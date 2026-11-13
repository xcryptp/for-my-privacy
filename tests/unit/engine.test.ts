import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import background from '../../entrypoints/background';
import {
  applySettings,
  handleMessage,
  onIdleStateChanged,
  onPermissionsRemoved,
  relock,
  tabsToRelock,
} from '../../src/background/engine';
import { createRecord, verifyPassword } from '../../src/lib/password';
import { RULE_FALLBACK_BLOCK, RULE_REDIRECT, RULE_UNLOCK } from '../../src/lib/rules';
import { DEFAULT_SETTINGS, getAuth, saveAuth, saveSettings } from '../../src/lib/settings';
import { SETTINGS_GUARD_BUILD } from '../../src/lib/flags';

const PW = 'correct horse';
const WRONG = 'wrong password';
const LOCK = 'chrome-extension://test-extension-id/lock.html';

type Rule = { id: number; condition: { requestDomains?: string[] } };
type RuleUpdate = { removeRuleIds?: number[]; addRules?: Rule[] };
type Listener = (...args: never[]) => unknown;

// fakeBrowser has no declarativeNetRequest and leaves idle and parts of permissions and runtime
// unmocked. This installs in-memory stand-ins for one test; afterEach restores everything.
function installChrome() {
  const state = { dynamic: [] as Rule[], session: [] as Rule[] };
  const applyUpdate = (list: Rule[], { removeRuleIds = [], addRules = [] }: RuleUpdate) =>
    list.filter((r) => !removeRuleIds.includes(r.id)).concat(addRules);
  const dnr = {
    updateDynamicRules: vi.fn(async (o: RuleUpdate) => {
      state.dynamic = applyUpdate(state.dynamic, o);
    }),
    updateSessionRules: vi.fn(async (o: RuleUpdate) => {
      state.session = applyUpdate(state.session, o);
    }),
    getSessionRules: vi.fn(async () => state.session),
    getDynamicRules: vi.fn(async () => state.dynamic),
  };
  (browser as unknown as { declarativeNetRequest: unknown }).declarativeNetRequest = dnr;

  const listeners = { idle: [] as Listener[], permAdded: [] as Listener[], permRemoved: [] as Listener[] };
  const capture = (list: Listener[]) => ((cb: Listener) => void list.push(cb)) as never;
  vi.spyOn(browser.permissions, 'contains').mockImplementation((async () => true) as never);
  vi.spyOn(browser.permissions.onAdded, 'addListener').mockImplementation(capture(listeners.permAdded));
  vi.spyOn(browser.permissions.onRemoved, 'addListener').mockImplementation(capture(listeners.permRemoved));
  vi.spyOn(browser.idle.onStateChanged, 'addListener').mockImplementation(capture(listeners.idle));
  const setDetectionInterval = vi
    .spyOn(browser.idle, 'setDetectionInterval')
    .mockImplementation((() => undefined) as never);
  const openOptionsPage = vi.spyOn(browser.runtime, 'openOptionsPage').mockImplementation((async () => {}) as never);
  return { state, dnr, listeners, setDetectionInterval, openOptionsPage };
}

let chrome: ReturnType<typeof installChrome>;

const domainsOf = (rules: Rule[], id: number) => rules.find((r) => r.id === id)?.condition.requestDomains;

async function seedPassword(extra: Partial<Parameters<typeof saveAuth>[0]> = {}) {
  await saveAuth({ password: await createRecord(PW, 1000), failures: 0, blockedUntil: 0, ...extra });
}

async function seedUnlocked(domains: string[]) {
  await seedPassword();
  await saveSettings({ domains });
  const res = await handleMessage({ type: 'unlock', password: PW }, {});
  expect(res.ok).toBe(true);
}

beforeEach(() => {
  fakeBrowser.reset();
  chrome = installChrome();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (browser as unknown as { declarativeNetRequest?: unknown }).declarativeNetRequest;
});

describe('handleMessage: setup', () => {
  it('stores a record, starts blocking and rejects a second setup with already_set', async () => {
    await saveSettings({ domains: ['example.test'] });
    const first = await handleMessage({ type: 'setup', password: PW }, {});
    expect(first).toEqual({
      ok: true,
      state: { hasPassword: true, unlocked: true, waitMs: 0, settingsGuardAvailable: SETTINGS_GUARD_BUILD },
    });
    const auth = await getAuth();
    expect(auth.password).not.toBeNull();
    expect(await verifyPassword(PW, auth.password!)).toBe(true);
    expect(domainsOf(chrome.state.dynamic, RULE_FALLBACK_BLOCK)).toEqual(['example.test']);
    expect(domainsOf(chrome.state.dynamic, RULE_REDIRECT)).toEqual(['example.test']);

    const second = await handleMessage({ type: 'setup', password: 'another password' }, {});
    expect(second).toMatchObject({ ok: false, error: 'already_set' });
    expect(await verifyPassword(PW, (await getAuth()).password!)).toBe(true);
  });

  it('rejects a short password with too_short and stores nothing', async () => {
    const res = await handleMessage({ type: 'setup', password: 'short' }, {});
    expect(res).toMatchObject({ ok: false, error: 'too_short', state: { hasPassword: false } });
    expect((await getAuth()).password).toBeNull();
  });
});

describe('handleMessage: unlock', () => {
  it('returns not_set before a password exists', async () => {
    expect(await handleMessage({ type: 'unlock', password: PW }, {})).toMatchObject({ ok: false, error: 'not_set' });
  });

  it('wrong password increments failures', async () => {
    await seedPassword();
    const res = await handleMessage({ type: 'unlock', password: WRONG }, {});
    expect(res).toMatchObject({ ok: false, error: 'wrong_password', state: { unlocked: false, waitMs: 0 } });
    expect((await getAuth()).failures).toBe(1);
    expect(chrome.state.session).toEqual([]);
  });

  it('the fifth wrong answer sets blockedUntil, then too_many_attempts while waiting', async () => {
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await seedPassword({ failures: 4 });
    const fifth = await handleMessage({ type: 'unlock', password: WRONG }, {});
    expect(fifth).toMatchObject({ ok: false, error: 'wrong_password', state: { waitMs: 30_000 } });
    expect(await getAuth()).toMatchObject({ failures: 5, blockedUntil: now + 30_000 });

    // Even the right password is refused while waiting, and the attempt does not count.
    vi.spyOn(Date, 'now').mockReturnValue(now + 29_999);
    const waiting = await handleMessage({ type: 'unlock', password: PW }, {});
    expect(waiting).toMatchObject({ ok: false, error: 'too_many_attempts', state: { waitMs: 1 } });
    expect(await getAuth()).toMatchObject({ failures: 5, blockedUntil: now + 30_000 });
    expect(chrome.state.session).toEqual([]);
  });

  it('success resets failures and calls setUnlocked', async () => {
    await seedPassword({ failures: 6, blockedUntil: 0 });
    await saveSettings({ domains: ['example.test', 'other.test'] });
    const res = await handleMessage({ type: 'unlock', password: PW }, {});
    expect(res).toMatchObject({ ok: true, state: { unlocked: true, waitMs: 0 } });
    expect(await getAuth()).toMatchObject({ failures: 0, blockedUntil: 0 });
    expect(domainsOf(chrome.state.session, RULE_UNLOCK)).toEqual(expect.arrayContaining(['example.test', 'other.test']));
  });

  it('stays unlocked with no locked domains, so settings stay reachable', async () => {
    await seedPassword();
    const res = await handleMessage({ type: 'unlock', password: PW }, {});
    expect(res).toMatchObject({ ok: true, state: { unlocked: true } });
  });

  it('serializes parallel attempts so they cannot skip the wait', async () => {
    await seedPassword();
    const two = await Promise.all([
      handleMessage({ type: 'unlock', password: WRONG }, {}),
      handleMessage({ type: 'unlock', password: WRONG }, {}),
    ]);
    expect(two.map((r) => !r.ok && r.error)).toEqual(['wrong_password', 'wrong_password']);
    expect((await getAuth()).failures).toBe(2);

    const four = await Promise.all(
      [WRONG, WRONG, WRONG, PW].map((password) => handleMessage({ type: 'unlock', password }, {})),
    );
    expect(four.map((r) => (r.ok ? 'ok' : r.error))).toEqual([
      'wrong_password',
      'wrong_password',
      'wrong_password',
      'too_many_attempts',
    ]);
    expect((await getAuth()).failures).toBe(5);
  });

  it('ignores an unlock from a framed lock page: no unlock, no navigation, no attempt counted', async () => {
    const update = vi.spyOn(browser.tabs, 'update').mockImplementation((async () => ({})) as never);
    await seedPassword();
    await saveSettings({ domains: ['example.test'] });
    for (const sender of [{ tab: { id: 7 }, frameId: 3 }, { tab: { id: 7 } }]) {
      for (const password of [PW, WRONG]) {
        const res = await handleMessage({ type: 'unlock', password, returnTo: 'http://example.test/' }, sender);
        expect(res).toMatchObject({ ok: false, error: 'wrong_password', state: { unlocked: false } });
      }
    }
    expect(await getAuth()).toMatchObject({ failures: 0, blockedUntil: 0 });
    expect(chrome.state.session).toEqual([]);
    expect(update).not.toHaveBeenCalled();
  });

  it('sends the lock tab back to a safe returnTo only', async () => {
    const update = vi.spyOn(browser.tabs, 'update').mockImplementation((async () => ({})) as never);
    await seedPassword();
    await saveSettings({ domains: ['example.test'] });
    await handleMessage({ type: 'unlock', password: PW, returnTo: 'http://www.example.test/x' }, { tab: { id: 7 }, frameId: 0 });
    expect(update).toHaveBeenCalledWith(7, { url: 'http://www.example.test/x' });

    update.mockClear();
    await handleMessage({ type: 'unlock', password: PW, returnTo: 'https://evil.test/' }, { tab: { id: 7 }, frameId: 0 });
    await handleMessage({ type: 'unlock', password: PW, returnTo: 'javascript:alert(1)' }, { tab: { id: 7 }, frameId: 0 });
    await handleMessage({ type: 'unlock', password: PW, returnTo: 'http://example.test/' }, {});
    await handleMessage({ type: 'unlock', password: WRONG, returnTo: 'http://example.test/' }, { tab: { id: 7 }, frameId: 0 });
    expect(update).not.toHaveBeenCalled();
  });
});

describe('handleMessage: changePassword, lockNow, getState', () => {
  it('changePassword requires the current password and counts wrong answers', async () => {
    await seedPassword();
    const wrong = await handleMessage({ type: 'changePassword', current: WRONG, next: 'new password 1' }, {});
    expect(wrong).toMatchObject({ ok: false, error: 'wrong_password' });
    expect((await getAuth()).failures).toBe(1);

    const short = await handleMessage({ type: 'changePassword', current: PW, next: 'short' }, {});
    expect(short).toMatchObject({ ok: false, error: 'too_short' });

    const ok = await handleMessage({ type: 'changePassword', current: PW, next: 'new password 1' }, {});
    expect(ok.ok).toBe(true);
    const auth = await getAuth();
    expect(auth.failures).toBe(0);
    expect(await verifyPassword('new password 1', auth.password!)).toBe(true);
    expect(await verifyPassword(PW, auth.password!)).toBe(false);
  });

  it('changePassword is refused while waiting and before setup', async () => {
    expect(await handleMessage({ type: 'changePassword', current: PW, next: 'new password 1' }, {})).toMatchObject({
      ok: false,
      error: 'not_set',
    });
    await seedPassword({ failures: 5, blockedUntil: Date.now() + 60_000 });
    expect(await handleMessage({ type: 'changePassword', current: PW, next: 'new password 1' }, {})).toMatchObject({
      ok: false,
      error: 'too_many_attempts',
    });
  });

  it('lockNow clears the unlock rule', async () => {
    await seedUnlocked(['example.test']);
    const res = await handleMessage({ type: 'lockNow' }, {});
    expect(res).toMatchObject({ ok: true, state: { unlocked: false } });
    expect(chrome.state.session).toEqual([]);
  });

  it('getState reports the remaining wait', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000);
    await seedPassword({ failures: 5, blockedUntil: 35_000 });
    expect(await handleMessage({ type: 'getState' }, {})).toEqual({
      ok: true,
      state: { hasPassword: true, unlocked: false, waitMs: 30_000, settingsGuardAvailable: SETTINGS_GUARD_BUILD },
    });
  });
});

describe('applySettings', () => {
  it('does not block before a password exists', async () => {
    await applySettings({ ...DEFAULT_SETTINGS, domains: ['example.test'] });
    expect(chrome.dnr.updateDynamicRules).toHaveBeenCalledWith({
      removeRuleIds: [RULE_REDIRECT, RULE_FALLBACK_BLOCK],
      addRules: [],
    });
    expect(chrome.state.dynamic).toEqual([]);
  });

  it('resyncs rules and unlock rule when domains change', async () => {
    await seedUnlocked(['example.test']);
    await applySettings({ ...DEFAULT_SETTINGS, domains: ['example.test', 'other.test'] });
    expect(domainsOf(chrome.state.dynamic, RULE_FALLBACK_BLOCK)).toEqual(['example.test', 'other.test']);
    expect(domainsOf(chrome.state.session, RULE_UNLOCK)).toEqual(expect.arrayContaining(['example.test', 'other.test']));
  });

  it('does not create an unlock rule while locked', async () => {
    await seedPassword();
    await applySettings({ ...DEFAULT_SETTINGS, domains: ['example.test'] });
    expect(chrome.state.session).toEqual([]);
    expect(domainsOf(chrome.state.dynamic, RULE_FALLBACK_BLOCK)).toEqual(['example.test']);
  });

  it('a relock during a settings sync is not undone by the sync', async () => {
    await seedUnlocked(['example.test']);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    chrome.dnr.getSessionRules.mockClear();
    // The sync reads the unlock rule, then stalls before refreshing it.
    chrome.dnr.getSessionRules.mockImplementationOnce(async () => {
      const snapshot = chrome.state.session;
      await gate;
      return snapshot;
    });
    const sync = applySettings({ ...DEFAULT_SETTINGS, domains: ['example.test'] });
    await vi.waitFor(() => expect(chrome.dnr.getSessionRules).toHaveBeenCalled());
    const lock = relock('idle');
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all([sync, lock]);
    expect(chrome.state.session).toEqual([]);
  });

  it('sets the idle interval from idleMinutes', async () => {
    await applySettings({ ...DEFAULT_SETTINGS, idleMinutes: 10 });
    expect(chrome.setDetectionInterval).toHaveBeenLastCalledWith(600);
  });
});

describe('tabsToRelock', () => {
  it('picks www.example.test and skips notexample.test', () => {
    const tabs = [
      { id: 1, url: 'https://www.example.test/a' },
      { id: 2, url: 'https://notexample.test/' },
      { id: 3, url: 'http://example.test:8080/' },
      { id: 4, url: `${LOCK}#u=https://example.test/` },
      { id: 5, url: 'view-source:https://m.example.test/' },
      { id: 6 },
      { id: 7, url: 'chrome://newtab/' },
      { id: 8, url: 'https://other.test/', pendingUrl: 'https://example.test/' },
    ];
    expect(tabsToRelock(tabs, ['example.test']).map((t) => t.id)).toEqual([1, 3, 5, 8]);
    expect(tabsToRelock(tabs, [])).toEqual([]);
  });
});

describe('relock', () => {
  type FakeTab = { id: number; windowId: number; index: number; pinned: boolean; active: boolean; url: string };
  const TABS: FakeTab[] = [
    { id: 1, windowId: 1, index: 0, pinned: true, active: false, url: 'https://www.example.test/a' },
    { id: 2, windowId: 1, index: 1, pinned: false, active: true, url: 'https://other.test/' },
    { id: 3, windowId: 2, index: 1, pinned: false, active: true, url: 'http://example.test/' },
    { id: 4, windowId: 2, index: 2, pinned: false, active: false, url: 'chrome://extensions/' },
  ];

  function stubTabs(tabs: FakeTab[]) {
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () => tabs) as never);
    const create = vi.spyOn(browser.tabs, 'create').mockImplementation((async () => ({ id: 99 })) as never);
    const remove = vi.spyOn(browser.tabs, 'remove').mockImplementation((async () => {}) as never);
    return { create, remove };
  }

  it('clears the unlock rule and replaces locked tabs in place, then closes them', async () => {
    await seedUnlocked(['example.test']);
    const { create, remove } = stubTabs(TABS);
    await relock('manual');
    expect(chrome.state.session).toEqual([]);
    expect(create.mock.calls.map((c) => c[0])).toEqual([
      { windowId: 1, index: 0, pinned: true, active: false, url: `${LOCK}#u=https://www.example.test/a` },
      { windowId: 2, index: 1, pinned: false, active: true, url: `${LOCK}#u=http://example.test/` },
      { windowId: 2, index: 2, pinned: false, active: false, url: `${LOCK}#u=chrome://extensions/` },
    ]);
    expect(remove.mock.calls.map((c) => c[0])).toEqual([1, 3, 4]);
    // Each replacement is created before its original closes.
    for (let i = 0; i < 3; i++) {
      expect(create.mock.invocationCallOrder[i]!).toBeLessThan(remove.mock.invocationCallOrder[i]!);
    }
  });

  it('leaves the extensions page alone when the guard is off', async () => {
    await seedUnlocked(['example.test']);
    await saveSettings({ settingsGuard: false });
    const { remove } = stubTabs(TABS);
    await relock('idle');
    expect(remove.mock.calls.map((c) => c[0])).toEqual([1, 3]);
  });

  it('closes a locked tab even when its replacement cannot be created', async () => {
    await seedUnlocked(['example.test']);
    const { create, remove } = stubTabs([TABS[0]!, TABS[2]!]);
    create.mockImplementationOnce((async () => {
      throw new Error('no window');
    }) as never);
    await relock('idle');
    expect(remove.mock.calls.map((c) => c[0])).toEqual([1, 3]);
  });

  it('still sweeps tabs with the last known settings when storage fails after clearing', async () => {
    await seedUnlocked(['example.test']);
    const { remove } = stubTabs(TABS);
    vi.spyOn(browser.storage.local, 'get').mockImplementation((async () => {
      throw new Error('storage down');
    }) as never);
    await relock('idle');
    expect(chrome.state.session).toEqual([]);
    expect(remove.mock.calls.map((c) => c[0])).toEqual([1, 3, 4]);
  });

  it('retries a failed tab listing and still sweeps', async () => {
    await seedUnlocked(['example.test']);
    const { remove } = stubTabs(TABS);
    vi.mocked(browser.tabs.query).mockImplementationOnce((async () => {
      throw new Error('tabs busy');
    }) as never);
    await relock('idle');
    expect(chrome.state.session).toEqual([]);
    expect(remove.mock.calls.map((c) => c[0])).toEqual([1, 3, 4]);
  });

  it('sweeps tabs even when clearing the unlock rule fails, then reports the error', async () => {
    await seedUnlocked(['example.test']);
    const { remove } = stubTabs(TABS);
    chrome.dnr.updateSessionRules.mockImplementationOnce(async () => {
      throw new Error('dnr down');
    });
    await expect(relock('idle')).rejects.toThrow('dnr down');
    expect(remove.mock.calls.map((c) => c[0])).toEqual([1, 3, 4]);
  });

  it('touches no tabs before a password exists', async () => {
    await saveSettings({ domains: ['example.test'] });
    const { create, remove } = stubTabs(TABS);
    await relock('idle');
    expect(create).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('background listeners', () => {
  const start = () => background.main();

  it('restores idle interval on worker start', async () => {
    start();
    await vi.waitFor(() => expect(chrome.setDetectionInterval).toHaveBeenCalledWith(300));
  });

  it('applies the stored settings on worker start and keeps an existing unlock', async () => {
    await seedUnlocked(['example.test']);
    chrome.dnr.updateDynamicRules.mockClear();
    start();
    await vi.waitFor(() => expect(chrome.dnr.updateDynamicRules).toHaveBeenCalled());
    expect(domainsOf(chrome.state.dynamic, RULE_FALLBACK_BLOCK)).toEqual(['example.test']);
    expect(domainsOf(chrome.state.session, RULE_UNLOCK)).toEqual(expect.arrayContaining(['example.test']));
  });

  it('resyncs when the stored settings change', async () => {
    await seedUnlocked(['example.test']);
    start();
    await saveSettings({ domains: ['example.test', 'other.test'] });
    await vi.waitFor(() =>
      expect(domainsOf(chrome.state.dynamic, RULE_FALLBACK_BLOCK)).toEqual(['example.test', 'other.test']),
    );
    await vi.waitFor(() =>
      expect(domainsOf(chrome.state.session, RULE_UNLOCK)).toEqual(expect.arrayContaining(['other.test'])),
    );
  });

  it('opens the options page on install only', async () => {
    start();
    await fakeBrowser.runtime.onInstalled.trigger({ reason: 'update' } as never);
    expect(chrome.openOptionsPage).not.toHaveBeenCalled();
    await fakeBrowser.runtime.onInstalled.trigger({ reason: 'install' } as never);
    await vi.waitFor(() => expect(chrome.openOptionsPage).toHaveBeenCalledTimes(1));
  });

  it('applies settings on browser startup', async () => {
    start();
    await vi.waitFor(() => expect(chrome.setDetectionInterval).toHaveBeenCalled());
    chrome.setDetectionInterval.mockClear();
    await fakeBrowser.runtime.onStartup.trigger();
    await vi.waitFor(() => expect(chrome.setDetectionInterval).toHaveBeenCalledWith(300));
  });

  it('relocks on idle, and on screen lock only when lockOnScreenLock is on', async () => {
    start();
    const fire = (s: string) => Promise.all(chrome.listeners.idle.map((l) => (l as (s: string) => unknown)(s)));

    await seedUnlocked(['example.test']);
    await fire('active');
    expect(chrome.state.session).not.toEqual([]);
    await fire('idle');
    await vi.waitFor(() => expect(chrome.state.session).toEqual([]));

    await seedUnlocked(['example.test']);
    await saveSettings({ lockOnScreenLock: false });
    await fire('locked');
    await new Promise((r) => setTimeout(r, 20));
    expect(chrome.state.session).not.toEqual([]);
    await saveSettings({ lockOnScreenLock: true });
    await fire('locked');
    await vi.waitFor(() => expect(chrome.state.session).toEqual([]));
  });

  it('relocks on screen lock when the settings cannot be read', async () => {
    start();
    await seedUnlocked(['example.test']);
    vi.spyOn(browser.storage.local, 'get').mockImplementation((async () => {
      throw new Error('storage down');
    }) as never);
    await Promise.all(chrome.listeners.idle.map((l) => (l as (s: string) => unknown)('locked')));
    await vi.waitFor(() => expect(chrome.state.session).toEqual([]));
  });

  it('with lockOnScreenLock off, relocks on return when the screen stayed locked past idleMinutes', async () => {
    const fire = onIdleStateChanged;
    const stored = async () => (await browser.storage.session.get('screenLockedAt')).screenLockedAt;
    const t0 = 10_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    await seedUnlocked(['example.test']);
    await saveSettings({ lockOnScreenLock: false, idleMinutes: 1 });

    // A short screen lock: still unlocked, the stored time is cleared.
    await fire('locked');
    expect(await stored()).toBe(t0);
    expect(chrome.state.session).not.toEqual([]);
    now.mockReturnValue(t0 + 30_000);
    await fire('active');
    expect(await stored()).toBeUndefined();
    expect(chrome.state.session).not.toEqual([]);

    // A screen lock longer than idleMinutes: relocked on return.
    await fire('locked');
    now.mockReturnValue(t0 + 30_000 + 61_000);
    await fire('active');
    expect(chrome.state.session).toEqual([]);
    expect(await stored()).toBeUndefined();

    // `active` without a stored screen lock does nothing.
    await seedUnlocked(['example.test']);
    await fire('active');
    expect(chrome.state.session).not.toEqual([]);
  });

  it('sweeps open extensions pages at worker start and browser start while locked', async () => {
    const tabs = [
      { id: 2, windowId: 1, index: 0, pinned: false, active: false, url: 'https://other.test/' },
      { id: 4, windowId: 1, index: 1, pinned: false, active: true, url: 'chrome://extensions/?id=abc' },
    ];
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () => tabs) as never);
    const create = vi.spyOn(browser.tabs, 'create').mockImplementation((async () => ({ id: 99 })) as never);
    const remove = vi.spyOn(browser.tabs, 'remove').mockImplementation((async () => {}) as never);
    await seedPassword();
    start();
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith(4));
    expect(create).toHaveBeenCalledWith({
      windowId: 1,
      index: 1,
      pinned: false,
      active: true,
      url: `${LOCK}#u=chrome://extensions/?id=abc`,
    });
    expect(remove).toHaveBeenCalledTimes(1);

    remove.mockClear();
    await fakeBrowser.runtime.onStartup.trigger();
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith(4));
  });

  it('leaves extensions pages alone at worker start while unlocked or with the guard off', async () => {
    const tabs = [{ id: 4, windowId: 1, index: 0, pinned: false, active: true, url: 'chrome://extensions/' }];
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () => tabs) as never);
    const remove = vi.spyOn(browser.tabs, 'remove').mockImplementation((async () => {}) as never);
    await seedUnlocked([]);
    start();
    await vi.waitFor(() => expect(chrome.setDetectionInterval).toHaveBeenCalled());
    await handleMessage({ type: 'lockNow' }, {});
    remove.mockClear();
    await saveSettings({ settingsGuard: false });
    chrome.setDetectionInterval.mockClear();
    await fakeBrowser.runtime.onStartup.trigger();
    await vi.waitFor(() => expect(chrome.setDetectionInterval).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(remove).not.toHaveBeenCalled();
  });

  it('relocks when the last normal window closes', async () => {
    start();
    await seedUnlocked(['example.test']);
    const getAll = vi
      .spyOn(browser.windows, 'getAll')
      .mockImplementation((async () => [{ id: 1, type: 'normal' }]) as never);
    await fakeBrowser.windows.onRemoved.trigger(2);
    await new Promise((r) => setTimeout(r, 20));
    expect(getAll).toHaveBeenCalledWith({ windowTypes: ['normal'] });
    expect(chrome.state.session).not.toEqual([]);

    getAll.mockImplementation((async () => []) as never);
    await fakeBrowser.windows.onRemoved.trigger(1);
    await vi.waitFor(() => expect(chrome.state.session).toEqual([]));
  });

  it('sends the extensions page to the lock page while locked', async () => {
    start();
    const update = vi.spyOn(browser.tabs, 'update').mockImplementation((async () => ({})) as never);
    const fire = (url: string) => fakeBrowser.tabs.onUpdated.trigger(3, { url } as never, { id: 3, url } as never);

    // No password yet: nothing is locked.
    await fire('chrome://extensions/');
    await new Promise((r) => setTimeout(r, 20));
    expect(update).not.toHaveBeenCalled();

    await seedPassword();
    await fire('https://example.test/');
    await fire('chrome://extensions/?id=abc');
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith(3, { url: `${LOCK}#u=chrome://extensions/?id=abc` });

    update.mockClear();
    await handleMessage({ type: 'unlock', password: PW }, {});
    await fire('chrome://extensions/');
    await new Promise((r) => setTimeout(r, 20));
    expect(update).not.toHaveBeenCalled();

    await handleMessage({ type: 'lockNow' }, {});
    await saveSettings({ settingsGuard: false });
    await fire('chrome://extensions/');
    await new Promise((r) => setTimeout(r, 20));
    expect(update).not.toHaveBeenCalled();
  });

  it('resyncs on permission changes and asks for a lost permission again', async () => {
    start();
    await seedPassword();
    await saveSettings({ domains: ['example.test'] });
    const create = vi.spyOn(browser.tabs, 'create').mockImplementation((async () => ({ id: 9 })) as never);
    const contains = vi.mocked(browser.permissions.contains);

    contains.mockImplementation((async () => false) as never);
    await Promise.all(chrome.listeners.permRemoved.map((l) => (l as (p: unknown) => unknown)({ origins: [] })));
    // The page opens after the resync, so wait for it before looking at the rules.
    await vi.waitFor(() =>
      expect(create).toHaveBeenCalledWith({ url: 'chrome-extension://test-extension-id/options.html#permission-lost' }),
    );
    expect(domainsOf(chrome.state.dynamic, RULE_REDIRECT)).toBeUndefined();
    expect(domainsOf(chrome.state.dynamic, RULE_FALLBACK_BLOCK)).toEqual(['example.test']);

    contains.mockImplementation((async () => true) as never);
    await Promise.all(chrome.listeners.permAdded.map((l) => (l as (p: unknown) => unknown)({ origins: [] })));
    await vi.waitFor(() => expect(domainsOf(chrome.state.dynamic, RULE_REDIRECT)).toEqual(['example.test']));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not ask again when the removed permission was for a domain no longer listed', async () => {
    await seedPassword();
    await saveSettings({ domains: ['example.test'] });
    const create = vi.spyOn(browser.tabs, 'create').mockImplementation((async () => ({ id: 9 })) as never);
    // example.test keeps its access; the removed origin belonged to a domain already deleted.
    await onPermissionsRemoved();
    expect(domainsOf(chrome.state.dynamic, RULE_REDIRECT)).toEqual(['example.test']);
    expect(create).not.toHaveBeenCalled();

    // Once a listed domain loses access, the page opens.
    vi.mocked(browser.permissions.contains).mockImplementation((async () => false) as never);
    await onPermissionsRemoved();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('answers runtime messages and ignores unknown ones', async () => {
    start();
    expect(await browser.runtime.sendMessage({ type: 'getState' })).toMatchObject({
      ok: true,
      state: { hasPassword: false },
    });
    expect(await browser.runtime.sendMessage({ type: 'nope' })).toBeUndefined();
    expect(await browser.runtime.sendMessage({ type: 'unlock', password: 42 })).toBeUndefined();
  });
});
