import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import background from '../../entrypoints/background';
import {
  applySettings,
  handleMessage,
  onBrowserStart,
  onCommand,
  onFrameCommitted,
  onIdleStateChanged,
  onInstalled,
  onPermissionsRemoved,
  onTabActivated,
  onTabRemoved,
  onTabReplaced,
  onTabUpdated,
  openDomains,
  relock,
  siteDataOrigins,
  tabsToRelock,
  triesLeft,
} from '../../src/background/engine';
import { isRequest } from '../../src/lib/messages';
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
  const browsingData = { remove: vi.fn(async (_options: unknown, _types: unknown) => {}) };
  (browser as unknown as { browsingData: unknown }).browsingData = browsingData;

  const listeners = {
    idle: [] as Listener[],
    permAdded: [] as Listener[],
    permRemoved: [] as Listener[],
    tabReplaced: [] as Listener[],
    command: [] as Listener[],
    committed: [] as Listener[],
  };
  const capture = (list: Listener[]) => ((cb: Listener) => void list.push(cb)) as never;
  vi.spyOn(browser.permissions, 'contains').mockImplementation((async () => true) as never);
  vi.spyOn(browser.permissions.onAdded, 'addListener').mockImplementation(capture(listeners.permAdded));
  vi.spyOn(browser.permissions.onRemoved, 'addListener').mockImplementation(capture(listeners.permRemoved));
  vi.spyOn(browser.idle.onStateChanged, 'addListener').mockImplementation(capture(listeners.idle));
  vi.spyOn(browser.tabs.onReplaced, 'addListener').mockImplementation(capture(listeners.tabReplaced));
  vi.spyOn(browser.commands.onCommand, 'addListener').mockImplementation(capture(listeners.command));
  vi.spyOn(browser.webNavigation.onCommitted, 'addListener').mockImplementation(capture(listeners.committed));
  const setDetectionInterval = vi
    .spyOn(browser.idle, 'setDetectionInterval')
    .mockImplementation((() => undefined) as never);
  const openOptionsPage = vi.spyOn(browser.runtime, 'openOptionsPage').mockImplementation((async () => {}) as never);
  return { state, dnr, browsingData, listeners, setDetectionInterval, openOptionsPage };
}

let chrome: ReturnType<typeof installChrome>;

const MARKERS = ['all.unlocked.for-my-privacy.invalid', 'site.unlocked.for-my-privacy.invalid'];
const domainsOf = (rules: Rule[], id: number) => rules.find((r) => r.id === id)?.condition.requestDomains;
/** The unlocked domains in the session rule, without the scope marker. */
const unlockedOf = (rules: Rule[]) => domainsOf(rules, RULE_UNLOCK)?.filter((d) => !MARKERS.includes(d));

type TokenRecord = { url: string; tabId: number | null; source: 'engine' | 'claimed' };
const tokenOf = (url: string | undefined) => (url?.startsWith(`${LOCK}#t=`) ? url.slice(`${LOCK}#t=`.length) : null);
async function recordOf(token: string): Promise<TokenRecord | undefined> {
  return (await browser.storage.session.get(`lockTarget:${token}`))[`lockTarget:${token}`] as TokenRecord | undefined;
}
/** A `#t=` lock page URL written as the `#u=` form of its stored target (else unchanged). */
async function asTarget(url: string | undefined): Promise<string | undefined> {
  const token = tokenOf(url);
  if (token === null) return url;
  const record = await recordOf(token);
  return record ? `${LOCK}#u=${record.url}` : `${LOCK}#t=<unknown>`;
}
/** tabs.create / tabs.update arguments with lock page tokens resolved to their targets. */
async function withTargets<T>(args: T[]): Promise<T[]> {
  return Promise.all(
    args.map(async (a) => {
      if (!a || typeof a !== 'object' || !('url' in a)) return a;
      return { ...a, url: await asTarget((a as { url?: string }).url) };
    }),
  );
}

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
  delete (browser as unknown as { browsingData?: unknown }).browsingData;
});

const settingsUnlocked = async () => (await handleMessage({ type: 'getState' }, {})).state.settingsUnlocked;

describe('handleMessage: setup', () => {
  it('stores a record, starts blocking and rejects a second setup with already_set', async () => {
    await saveSettings({ domains: ['example.test'] });
    const first = await handleMessage({ type: 'setup', password: PW }, {});
    // Setup opens the settings only; the sites are locked from the start.
    expect(first).toEqual({
      ok: true,
      state: {
        hasPassword: true,
        unlocked: false,
        unlockedDomains: [],
        settingsUnlocked: true,
        waitMs: 0,
        triesLeft: 5,
        settingsGuardAvailable: SETTINGS_GUARD_BUILD,
      },
    });
    expect(chrome.state.session).toEqual([]);
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

  it('one unlock sends back only the lock tabs the worker opened, the sender first', async () => {
    const T = (n: number) => n.toString(16).padStart(32, '0');
    const update = vi.spyOn(browser.tabs, 'update').mockImplementation((async () => ({})) as never);
    await browser.storage.session.set({
      [`lockTarget:${T(7)}`]: { url: 'http://www.example.test/x', tabId: 7, source: 'engine' },
      [`lockTarget:${T(3)}`]: { url: 'http://m.example.test/b?x=1#h', tabId: 3, source: 'engine' },
      [`lockTarget:${T(11)}`]: { url: 'chrome://extensions/', tabId: 11, source: 'engine' },
      // Claimed from a `#u=` URL anyone can type: only its own tab's unlock returns it.
      [`lockTarget:${T(13)}`]: { url: 'http://www.example.test/c', tabId: 13, source: 'claimed' },
      // A token copied into another tab is not that tab's.
      [`lockTarget:${T(14)}`]: { url: 'http://www.example.test/d', tabId: 99, source: 'engine' },
      [`lockTarget:${T(15)}`]: { url: 'https://evil.test/', tabId: 15, source: 'engine' },
    });
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () => [
      { id: 3, url: `${LOCK}#t=${T(3)}` },
      { id: 7, url: `${LOCK}#t=${T(7)}` },
      { id: 8, url: `${LOCK}#u=http://www.example.test/crafted` },
      { id: 10, url: 'http://other.test/' },
      { id: 11, url: `${LOCK}#t=${T(11)}` },
      { id: 13, url: `${LOCK}#t=${T(13)}` },
      { id: 14, url: `${LOCK}#t=${T(14)}` },
      { id: 15, url: `${LOCK}#t=${T(15)}` },
      { id: 16, url: `${LOCK}#u=chrome://extensions/` },
      { id: 12, url: `${LOCK}` },
    ]) as never);
    await seedPassword();
    await saveSettings({ domains: ['example.test'] });
    await handleMessage({ type: 'unlock', password: PW, token: T(7) }, { tab: { id: 7 }, frameId: 0 });
    expect(update.mock.calls).toEqual([
      [7, { url: 'http://www.example.test/x' }],
      [3, { url: 'http://m.example.test/b?x=1#h' }],
      [11, { url: 'chrome://extensions/' }],
    ]);
    // Used tokens are gone; the others stay.
    expect(await recordOf(T(7))).toBeUndefined();
    expect(await recordOf(T(3))).toBeUndefined();
    expect(await recordOf(T(13))).toBeDefined();

    // A wrong password moves no tab.
    update.mockClear();
    await handleMessage({ type: 'lockNow' }, {});
    await handleMessage({ type: 'unlock', password: WRONG, token: T(13) }, { tab: { id: 13 }, frameId: 0 });
    expect(update).not.toHaveBeenCalled();
    // The claimed tab returns on its own unlock; the token is read from the sender's URL too.
    await handleMessage({ type: 'unlock', password: PW }, { tab: { id: 13 }, frameId: 0, url: `${LOCK}#t=${T(13)}` });
    expect(update.mock.calls).toEqual([[13, { url: 'http://www.example.test/c' }]]);
    // Another tab's token returns nothing.
    update.mockClear();
    await handleMessage({ type: 'unlock', password: PW, token: T(14) }, { tab: { id: 7 }, frameId: 0 });
    expect(update).not.toHaveBeenCalled();
  });

  it('the old returnTo is followed for http(s) only, never the extensions page', async () => {
    const update = vi.spyOn(browser.tabs, 'update').mockImplementation((async () => ({})) as never);
    await seedPassword();
    await saveSettings({ domains: ['example.test'] });
    await handleMessage({ type: 'unlock', password: PW, returnTo: 'chrome://extensions/' }, { tab: { id: 7 }, frameId: 0 });
    expect(update).not.toHaveBeenCalled();
  });

  it('still unlocks and returns the sender when listing the other tabs fails', async () => {
    const update = vi.spyOn(browser.tabs, 'update').mockImplementation((async () => ({})) as never);
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () => {
      throw new Error('tabs busy');
    }) as never);
    await seedPassword();
    await saveSettings({ domains: ['example.test'] });
    const res = await handleMessage({ type: 'unlock', password: PW, returnTo: 'http://example.test/' }, { tab: { id: 7 }, frameId: 0 });
    expect(res).toMatchObject({ ok: true, state: { unlocked: true } });
    expect(update.mock.calls).toEqual([[7, { url: 'http://example.test/' }]]);
  });
});

describe('handleMessage: unlock and unlockSettings are separate', () => {
  it('unlock opens the sites only, not the settings', async () => {
    await seedUnlocked(['example.test']);
    expect(await handleMessage({ type: 'getState' }, {})).toMatchObject({
      state: { unlocked: true, settingsUnlocked: false },
    });
  });

  it('unlockSettings opens the settings only: no unlock rule and no navigation', async () => {
    const update = vi.spyOn(browser.tabs, 'update').mockImplementation((async () => ({})) as never);
    await seedPassword({ failures: 3 });
    await saveSettings({ domains: ['example.test'] });
    const res = await handleMessage({ type: 'unlockSettings', password: PW }, { tab: { id: 4 }, frameId: 0 });
    expect(res).toMatchObject({ ok: true, state: { unlocked: false, settingsUnlocked: true } });
    expect(chrome.state.session).toEqual([]);
    expect(chrome.dnr.updateSessionRules).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(await getAuth()).toMatchObject({ failures: 0, blockedUntil: 0 });
  });

  it('unlockSettings returns not_set before a password exists', async () => {
    expect(await handleMessage({ type: 'unlockSettings', password: PW }, {})).toMatchObject({
      ok: false,
      error: 'not_set',
      state: { settingsUnlocked: false },
    });
  });

  it('unlockSettings counts wrong answers and shares the wait with unlock', async () => {
    const now = 2_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await seedPassword({ failures: 3 });
    const wrong = await handleMessage({ type: 'unlockSettings', password: WRONG }, {});
    expect(wrong).toMatchObject({ ok: false, error: 'wrong_password', state: { settingsUnlocked: false } });
    // The fifth wrong answer overall (one from the lock page) starts the wait for both.
    await handleMessage({ type: 'unlock', password: WRONG }, {});
    expect(await getAuth()).toMatchObject({ failures: 5, blockedUntil: now + 30_000 });
    const waiting = await handleMessage({ type: 'unlockSettings', password: PW }, {});
    expect(waiting).toMatchObject({ ok: false, error: 'too_many_attempts', state: { settingsUnlocked: false } });
    expect((await getAuth()).failures).toBe(5);
  });

  it('serializes parallel unlockSettings and unlock attempts', async () => {
    await seedPassword({ failures: 3 });
    const results = await Promise.all([
      handleMessage({ type: 'unlockSettings', password: WRONG }, {}),
      handleMessage({ type: 'unlock', password: WRONG }, {}),
      handleMessage({ type: 'unlockSettings', password: PW }, {}),
    ]);
    expect(results.map((r) => (r.ok ? 'ok' : r.error))).toEqual([
      'wrong_password',
      'wrong_password',
      'too_many_attempts',
    ]);
  });

  it('ignores unlockSettings from a frame: nothing unlocked, no attempt counted', async () => {
    await seedPassword();
    for (const sender of [{ tab: { id: 7 }, frameId: 3 }, { tab: { id: 7 } }]) {
      for (const password of [PW, WRONG]) {
        const res = await handleMessage({ type: 'unlockSettings', password }, sender);
        expect(res).toMatchObject({ ok: false, error: 'wrong_password', state: { settingsUnlocked: false } });
      }
    }
    expect(await getAuth()).toMatchObject({ failures: 0, blockedUntil: 0 });
  });

  it('isRequest accepts unlockSettings with a string password only', () => {
    expect(isRequest({ type: 'unlockSettings', password: PW })).toBe(true);
    expect(isRequest({ type: 'unlockSettings' })).toBe(false);
    expect(isRequest({ type: 'unlockSettings', password: 1 })).toBe(false);
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

  it('lockNow clears the unlock rule and the settings unlock', async () => {
    await seedUnlocked(['example.test']);
    await handleMessage({ type: 'unlockSettings', password: PW }, {});
    expect(await settingsUnlocked()).toBe(true);
    const res = await handleMessage({ type: 'lockNow' }, {});
    expect(res).toMatchObject({ ok: true, state: { unlocked: false, settingsUnlocked: false } });
    expect(chrome.state.session).toEqual([]);
  });

  it('every relock clears the settings unlock, even before a sweep can run', async () => {
    await seedPassword();
    for (const reason of ['idle', 'screen', 'windows', 'update'] as const) {
      await handleMessage({ type: 'unlockSettings', password: PW }, {});
      expect(await settingsUnlocked()).toBe(true);
      await relock(reason);
      expect(await settingsUnlocked(), reason).toBe(false);
    }
  });

  it('a relock still locks the settings when the key cannot be removed', async () => {
    await seedPassword();
    await handleMessage({ type: 'unlockSettings', password: PW }, {});
    vi.spyOn(browser.storage.session, 'remove').mockImplementation((async () => {
      throw new Error('session storage down');
    }) as never);
    await relock('idle');
    expect(await settingsUnlocked()).toBe(false);
  });

  it('getState reports the remaining wait', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000);
    await seedPassword({ failures: 5, blockedUntil: 35_000 });
    expect(await handleMessage({ type: 'getState' }, {})).toEqual({
      ok: true,
      state: {
        hasPassword: true,
        unlocked: false,
        unlockedDomains: [],
        settingsUnlocked: false,
        waitMs: 30_000,
        triesLeft: 0,
        settingsGuardAvailable: SETTINGS_GUARD_BUILD,
      },
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
    expect((await withTargets(create.mock.calls.map((c) => c[0])))).toEqual([
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

  it('sweeps a tab that appeared while the unlock rule was being cleared', async () => {
    await seedUnlocked(['example.test']);
    const { remove } = stubTabs(TABS);
    // The listing before the clear misses tab 3; it opens before the clear finishes.
    vi.mocked(browser.tabs.query).mockImplementationOnce((async () => [TABS[0]!, TABS[1]!]) as never);
    await relock('idle');
    expect(remove.mock.calls.map((c) => c[0])).toEqual([1, 3, 4]);
  });

  it('falls back to the earlier tab listing when the one after clearing fails', async () => {
    await seedUnlocked(['example.test']);
    const { remove } = stubTabs(TABS);
    vi.mocked(browser.tabs.query)
      .mockImplementationOnce((async () => TABS) as never)
      .mockImplementationOnce((async () => {
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

  it('retries closing a tab that cannot be edited right now, then sends it to the lock page', async () => {
    await seedUnlocked(['example.test']);
    const { create, remove } = stubTabs([TABS[0]!, TABS[2]!]);
    const update = vi.spyOn(browser.tabs, 'update').mockImplementation((async () => ({})) as never);
    const busy = (async () => {
      throw new Error('Tabs cannot be edited right now (user may be dragging a tab).');
    }) as never;
    // Tab 1 closes on the second try; tab 3 never does and is sent to the lock page instead.
    remove.mockImplementationOnce(busy).mockImplementationOnce((async () => {}) as never);
    remove.mockImplementationOnce(busy).mockImplementationOnce(busy);
    await relock('idle');
    expect(create).toHaveBeenCalledTimes(2);
    expect(remove.mock.calls.map((c) => c[0])).toEqual([1, 1, 3, 3]);
    expect(await withTargets(update.mock.calls.map((c) => c[1]))).toEqual([{ url: `${LOCK}#u=http://example.test/` }]);
    expect(update.mock.calls[0]![0]).toBe(3);
    // The token of that last-resort lock page belongs to the tab itself.
    expect((await recordOf(tokenOf((update.mock.calls[0]![1] as { url: string }).url)!))?.tabId).toBe(3);
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

  it('screen-lock timing fails closed when storage.session fails', async () => {
    const session = browser.storage.session;
    const boom = (async () => {
      throw new Error('session storage down');
    }) as never;
    await seedUnlocked(['example.test']);
    await saveSettings({ lockOnScreenLock: false, idleMinutes: 5 });

    // `locked`: the time cannot be stored → relock now.
    const set = vi.spyOn(session, 'set').mockImplementationOnce(boom);
    await onIdleStateChanged('locked');
    expect(set).toHaveBeenCalled();
    expect(chrome.state.session).toEqual([]);

    // `active`: the stored time cannot be read → relock.
    await seedUnlocked(['example.test']);
    vi.spyOn(session, 'get').mockImplementationOnce(boom);
    await onIdleStateChanged('active');
    expect(chrome.state.session).toEqual([]);

    // `active` after a long lock: a failing clear does not skip the relock.
    await seedUnlocked(['example.test']);
    const t0 = 50_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    await onIdleStateChanged('locked');
    expect(chrome.state.session).not.toEqual([]);
    now.mockReturnValue(t0 + 6 * 60_000);
    vi.spyOn(session, 'remove').mockImplementationOnce(boom);
    await onIdleStateChanged('active');
    expect(chrome.state.session).toEqual([]);
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
    expect(await withTargets(create.mock.calls.map((c) => c[0]))).toEqual([
      { windowId: 1, index: 1, pinned: false, active: true, url: `${LOCK}#u=chrome://extensions/?id=abc` },
    ]);
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
    expect(update.mock.calls[0]![0]).toBe(3);
    expect(await withTargets([update.mock.calls[0]![1]])).toEqual([{ url: `${LOCK}#u=chrome://extensions/?id=abc` }]);

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

// The worker keeps a copy of the shown-locked set in memory, which fakeBrowser.reset() cannot
// reach; a relock with a password (and no tabs) empties it, then storage is wiped again.
async function forgetTrackedTabs() {
  await seedPassword();
  await relock('manual');
  await browser.storage.local.clear();
  await browser.storage.session.clear();
}

describe('tabs that showed a locked site (back/forward cache)', () => {
  const KEY = 'shownLockedTabs';
  beforeEach(forgetTrackedTabs);
  const stored = async () => (await browser.storage.session.get(KEY))[KEY] as number[] | undefined;
  type FakeTab = { id: number; windowId: number; index: number; pinned: boolean; active: boolean; url: string };

  function stubTabs(tabs: FakeTab[]) {
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () => tabs) as never);
    const create = vi.spyOn(browser.tabs, 'create').mockImplementation((async () => ({ id: 99 })) as never);
    const remove = vi.spyOn(browser.tabs, 'remove').mockImplementation((async () => {}) as never);
    return { create, remove };
  }

  it('records a tab that showed a page of a locked domain, and only those', async () => {
    await seedUnlocked(['example.test']);
    await onTabUpdated(5, { url: 'https://www.example.test/a' });
    await onTabUpdated(6, { url: 'https://notexample.test/' });
    await onTabUpdated(7, { url: 'view-source:http://example.test/' });
    await onTabUpdated(8, {});
    await onTabUpdated(5, { url: 'https://example.test/b' });
    expect(await stored()).toEqual([5, 7]);
  });

  it('follows a replaced tab and forgets a closed one', async () => {
    await seedUnlocked(['example.test']);
    await onTabUpdated(5, { url: 'https://example.test/' });
    await onTabUpdated(6, { url: 'https://example.test/' });
    await onTabReplaced(50, 5);
    await onTabReplaced(70, 4);
    expect(await stored()).toEqual([6, 50]);
    await onTabRemoved(6);
    await onTabRemoved(123);
    expect(await stored()).toEqual([50]);
  });

  it('relock recreates a tracked tab that moved on, in place, and clears the set', async () => {
    await seedUnlocked(['example.test']);
    const tabs: FakeTab[] = [
      { id: 1, windowId: 1, index: 0, pinned: true, active: false, url: 'https://other.test/now' },
      { id: 2, windowId: 1, index: 1, pinned: false, active: true, url: 'https://other.test/untouched' },
      { id: 3, windowId: 2, index: 0, pinned: false, active: true, url: 'https://www.example.test/still' },
    ];
    // Tab 1 showed example.test and then moved on; tab 3 is still on it; tab 9 no longer exists.
    for (const id of [1, 3, 9]) await onTabUpdated(id, { url: 'https://example.test/' });
    const { create, remove } = stubTabs(tabs);
    await relock('idle');
    expect((await withTargets(create.mock.calls.map((c) => c[0])))).toEqual([
      { windowId: 1, index: 0, pinned: true, active: false, url: 'https://other.test/now' },
      { windowId: 2, index: 0, pinned: false, active: true, url: `${LOCK}#u=https://www.example.test/still` },
    ]);
    expect(remove.mock.calls.map((c) => c[0])).toEqual([1, 3]);
    expect(create.mock.invocationCallOrder[0]!).toBeLessThan(remove.mock.invocationCallOrder[0]!);
    expect(await stored()).toBeUndefined();

    // Cleared: the next relock leaves the recreated tab alone.
    create.mockClear();
    remove.mockClear();
    await seedUnlocked(['example.test']);
    stubTabs([tabs[0]!, tabs[1]!]);
    await relock('idle');
    expect(vi.mocked(browser.tabs.create)).not.toHaveBeenCalled();
    expect(vi.mocked(browser.tabs.remove)).not.toHaveBeenCalled();
  });

  it('still recreates the tabs this worker saw when the stored set cannot be read', async () => {
    await seedUnlocked(['example.test']);
    await onTabUpdated(1, { url: 'https://example.test/' });
    const { remove } = stubTabs([
      { id: 1, windowId: 1, index: 0, pinned: false, active: true, url: 'https://other.test/' },
    ]);
    vi.spyOn(browser.storage.session, 'get').mockImplementation((async () => {
      throw new Error('session storage down');
    }) as never);
    await relock('idle');
    expect(remove.mock.calls.map((c) => c[0])).toEqual([1]);
  });

  it('a failed read does not let the next write drop the stored tabs', async () => {
    await seedUnlocked(['example.test']);
    // Another worker life stored tab 4; this worker has not seen it.
    await browser.storage.session.set({ [KEY]: [4] });
    // The next read of the stored tab set fails (other keys read normally).
    const session = browser.storage.session;
    const get = session.get.bind(session);
    let failNext = true;
    vi.spyOn(session, 'get').mockImplementation((async (key: unknown) => {
      if (key === KEY && failNext) {
        failNext = false;
        throw new Error('session storage down');
      }
      return get(key as never);
    }) as never);
    await onTabUpdated(5, { url: 'https://example.test/' });
    expect(await stored()).toEqual([4]);
    const { remove } = stubTabs([
      { id: 4, windowId: 1, index: 0, pinned: false, active: false, url: 'https://other.test/a' },
      { id: 5, windowId: 1, index: 1, pinned: false, active: true, url: 'https://other.test/b' },
    ]);
    await relock('idle');
    expect(remove.mock.calls.map((c) => c[0])).toEqual([4, 5]);
  });

  it('keeps the set when no sweep ran (no password yet), so a later relock still covers the tab', async () => {
    await saveSettings({ domains: ['example.test'] });
    await onTabUpdated(1, { url: 'https://example.test/' });
    const { remove } = stubTabs([
      { id: 1, windowId: 1, index: 0, pinned: false, active: true, url: 'https://other.test/' },
    ]);
    await relock('idle');
    expect(remove).not.toHaveBeenCalled();
    expect(await stored()).toEqual([1]);
  });
});

describe('extension update', () => {
  beforeEach(forgetTrackedTabs);
  it('sweeps open tabs of locked domains on update, not on install', async () => {
    await seedUnlocked(['example.test']);
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () => [
      { id: 1, windowId: 1, index: 0, pinned: false, active: true, url: 'https://example.test/' },
      { id: 2, windowId: 1, index: 1, pinned: false, active: false, url: 'https://other.test/' },
    ]) as never);
    vi.spyOn(browser.tabs, 'create').mockImplementation((async () => ({ id: 99 })) as never);
    const remove = vi.spyOn(browser.tabs, 'remove').mockImplementation((async () => {}) as never);
    await onInstalled({ reason: 'install' });
    await onInstalled({ reason: 'chrome_update' });
    expect(remove).not.toHaveBeenCalled();
    await onInstalled({ reason: 'update' });
    expect(remove.mock.calls.map((c) => c[0])).toEqual([1]);
    expect(chrome.state.session).toEqual([]);
  });

  it('touches no tabs on update before a password exists', async () => {
    await saveSettings({ domains: ['example.test'] });
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () => [
      { id: 1, windowId: 1, index: 0, pinned: false, active: true, url: 'https://example.test/' },
    ]) as never);
    const remove = vi.spyOn(browser.tabs, 'remove').mockImplementation((async () => {}) as never);
    await onInstalled({ reason: 'update' });
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('service workers and caches of locked sites (L1)', () => {
  beforeEach(forgetTrackedTabs);
  type FakeTab = { id: number; windowId: number; index: number; pinned: boolean; active: boolean; url: string };
  const BASE_ORIGINS = [
    'http://example.test',
    'https://example.test',
    'http://www.example.test',
    'https://www.example.test',
    'http://m.example.test',
    'https://m.example.test',
  ];

  function stubTabs(tabs: FakeTab[]) {
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () => tabs) as never);
    const create = vi.spyOn(browser.tabs, 'create').mockImplementation((async () => ({ id: 99 })) as never);
    const remove = vi.spyOn(browser.tabs, 'remove').mockImplementation((async () => {}) as never);
    return { create, remove };
  }
  const removedOrigins = (call = 0) =>
    (chrome.browsingData.remove.mock.calls[call]?.[0] as { origins: string[] } | undefined)?.origins;

  it('siteDataOrigins lists http and https for the domain, www. and m., plus extra http(s) origins', () => {
    expect(siteDataOrigins(['example.test'])).toEqual(BASE_ORIGINS);
    expect(
      siteDataOrigins(
        ['example.test'],
        [
          'http://example.test:8080/feed?x=1',
          'https://shop.example.test/a',
          'view-source:https://cdn.example.test/',
          'chrome://newtab/',
          'not a url',
          'https://example.test/',
        ],
      ),
    ).toEqual([...BASE_ORIGINS, 'http://example.test:8080', 'https://shop.example.test', 'https://cdn.example.test']);
    expect(siteDataOrigins([], [])).toEqual([]);
  });

  it('a relock removes only service workers and caches of the listed, shown and open locked origins', async () => {
    await seedUnlocked(['example.test']);
    // A tab showed the site on a port, then closed: its service worker stays on disk.
    await onTabUpdated(5, { url: 'http://example.test:8080/feed' });
    await onTabRemoved(5);
    await onTabUpdated(6, { url: 'https://notexample.test/' });
    stubTabs([{ id: 1, windowId: 1, index: 0, pinned: false, active: true, url: 'https://shop.example.test/a' }]);
    await relock('idle');
    expect(chrome.browsingData.remove).toHaveBeenCalledTimes(1);
    const [options, types] = chrome.browsingData.remove.mock.calls[0]!;
    expect(types).toEqual({ serviceWorkers: true, cacheStorage: true });
    expect(options).toEqual({
      origins: expect.any(Array),
      originTypes: { unprotectedWeb: true, protectedWeb: true },
    });
    expect([...removedOrigins()!].sort()).toEqual(
      [...BASE_ORIGINS, 'http://example.test:8080', 'https://shop.example.test'].sort(),
    );
  });

  it('a failed removal never stops the relock, and the origin is asked for again next time', async () => {
    await seedUnlocked(['example.test']);
    await onTabUpdated(5, { url: 'http://example.test:8080/' });
    const { remove } = stubTabs([
      { id: 3, windowId: 1, index: 0, pinned: false, active: true, url: 'https://example.test/' },
    ]);
    chrome.browsingData.remove.mockImplementationOnce(async () => {
      throw new Error('browsingData failed');
    });
    await expect(relock('idle')).resolves.toBeUndefined();
    expect(chrome.state.session).toEqual([]);
    expect(remove.mock.calls.map((c) => c[0])).toEqual([3]);

    stubTabs([]);
    await relock('idle');
    expect(removedOrigins(1)).toContain('http://example.test:8080');
  });

  it('shown origins are kept in storage.local for later sessions, and dropped once unlisted', async () => {
    const stored = async () => (await browser.storage.local.get('shownLockedOrigins')).shownLockedOrigins;
    await seedUnlocked(['example.test', 'other.test']);
    await onTabUpdated(5, { url: 'https://deep.sub.example.test/a' });
    await onTabUpdated(6, { url: 'https://app.other.test/' });
    expect(await stored()).toEqual(['https://deep.sub.example.test', 'https://app.other.test']);
    expect((await browser.storage.session.get('shownLockedOrigins')).shownLockedOrigins).toBeUndefined();
    stubTabs([]);

    // Kept after a successful removal: a browser start (session storage gone) still covers it.
    await relock('idle');
    expect(removedOrigins(0)).toEqual(expect.arrayContaining(['https://deep.sub.example.test']));
    await browser.storage.session.clear();
    await onBrowserStart();
    expect(removedOrigins(1)).toEqual(expect.arrayContaining(['https://deep.sub.example.test']));

    // other.test is no longer listed: its origin is neither removed nor kept.
    await saveSettings({ domains: ['example.test'] });
    await relock('idle');
    expect(removedOrigins(2)).not.toContain('https://app.other.test');
    expect(removedOrigins(2)).toContain('https://deep.sub.example.test');
    expect(await stored()).toEqual(['https://deep.sub.example.test']);
  });

  it('a removal that hangs does not hold the relock queue', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await seedUnlocked(['example.test']);
      stubTabs([]);
      chrome.browsingData.remove.mockImplementationOnce(() => new Promise(() => {}));
      let done = false;
      const lock = relock('idle').then(() => (done = true));
      await vi.advanceTimersByTimeAsync(9_000);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1_500);
      await lock;
      expect(done).toBe(true);
      expect(chrome.state.session).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes nothing before a password exists', async () => {
    await saveSettings({ domains: ['example.test'] });
    stubTabs([]);
    await relock('idle');
    expect(chrome.browsingData.remove).not.toHaveBeenCalled();
  });

  it('browser start removes the listed sites’ service workers while locked, not while unlocked', async () => {
    await seedPassword();
    await saveSettings({ domains: ['example.test'] });
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () => []) as never);
    await onBrowserStart();
    expect(removedOrigins()).toEqual(BASE_ORIGINS);

    chrome.browsingData.remove.mockClear();
    await handleMessage({ type: 'unlock', password: PW }, {});
    await onBrowserStart();
    expect(chrome.browsingData.remove).not.toHaveBeenCalled();
  });

  it('browser start sends every open or restored tab of a listed domain to the lock page', async () => {
    await seedPassword();
    await saveSettings({ domains: ['example.test', 'noperm.test'] });
    const tabs = [
      { id: 1, windowId: 1, index: 0, pinned: true, active: false, url: 'https://www.example.test/feed' },
      { id: 2, windowId: 1, index: 1, pinned: false, active: true, url: 'https://other.test/' },
      { id: 3, windowId: 1, index: 2, pinned: false, active: false, url: 'https://noperm.test/' },
    ];
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () => tabs) as never);
    const create = vi.spyOn(browser.tabs, 'create').mockImplementation((async () => ({ id: 99 })) as never);
    const remove = vi.spyOn(browser.tabs, 'remove').mockImplementation((async () => {}) as never);
    // Domains without host access are sent to the lock page too.
    vi.mocked(browser.permissions.contains).mockImplementation((async ({ origins }: { origins: string[] }) =>
      !origins[0]!.includes('noperm')) as never);
    await onBrowserStart();
    expect((await withTargets(create.mock.calls.map((c) => c[0] as { url: string }))).map((a) => a.url)).toEqual([
      `${LOCK}#u=https://www.example.test/feed`,
      `${LOCK}#u=https://noperm.test/`,
    ]);
    expect(remove.mock.calls.map((c) => c[0])).toEqual([1, 3]);
    expect(chrome.browsingData.remove).toHaveBeenCalledTimes(1);

    // While unlocked nothing is touched.
    create.mockClear();
    remove.mockClear();
    await handleMessage({ type: 'unlock', password: PW }, {});
    await onBrowserStart();
    expect(create).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('browser start removes nothing before a password exists', async () => {
    await saveSettings({ domains: ['example.test'] });
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () => []) as never);
    await onBrowserStart();
    expect(chrome.browsingData.remove).not.toHaveBeenCalled();
  });
});

describe('a locked site that loads anyway is replaced (L2)', () => {
  beforeEach(forgetTrackedTabs);
  const URL_ = 'https://www.example.test/feed';
  const TAB = { id: 3, windowId: 1, index: 2, pinned: false, active: true, url: URL_ };

  function stubTab(tab: { url?: string; pendingUrl?: string } | null) {
    vi.spyOn(browser.tabs, 'get').mockImplementation((async () => {
      if (!tab) throw new Error('No tab with id: 3');
      return { ...TAB, ...tab };
    }) as never);
    const create = vi.spyOn(browser.tabs, 'create').mockImplementation((async () => ({ id: 99 })) as never);
    const remove = vi.spyOn(browser.tabs, 'remove').mockImplementation((async () => {}) as never);
    return { create, remove };
  }

  async function seedLocked() {
    await seedPassword();
    await saveSettings({ domains: ['example.test'] });
  }

  it('a new URL on a locked domain while locked: the tab is recreated on the lock page', async () => {
    await seedLocked();
    const { create, remove } = stubTab({ url: URL_ });
    await onTabUpdated(3, { url: URL_ });
    expect((await withTargets(create.mock.calls.map((c) => c[0])))).toEqual([
      { windowId: 1, index: 2, pinned: false, active: true, url: `${LOCK}#u=${URL_}` },
    ]);
    expect(remove.mock.calls.map((c) => c[0])).toEqual([3]);
  });

  it('a reload (status loading, committed URL on a locked domain) is replaced too', async () => {
    await seedLocked();
    const { remove } = stubTab({ url: URL_ });
    await onTabUpdated(3, { status: 'loading' }, { url: URL_ });
    expect(remove.mock.calls.map((c) => c[0])).toEqual([3]);
  });

  it('a pending navigation the redirect rule will catch is left alone', async () => {
    await seedLocked();
    const { create, remove } = stubTab({ url: 'https://other.test/', pendingUrl: URL_ });
    await onTabUpdated(3, { status: 'loading' }, { url: 'https://other.test/' });
    expect(create).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('leaves the tab alone while unlocked, before a password, or off the locked domains', async () => {
    await saveSettings({ domains: ['example.test'] });
    const { create, remove } = stubTab({ url: URL_ });
    await onTabUpdated(3, { url: URL_ }); // no password yet
    await seedPassword();
    await onTabUpdated(3, { url: 'https://notexample.test/' });
    await onTabUpdated(3, { url: `${LOCK}#u=${URL_}` });
    await handleMessage({ type: 'unlock', password: PW }, {});
    await onTabUpdated(3, { url: URL_ });
    // Unlocking the settings alone does not open the sites, so that tab is replaced.
    await handleMessage({ type: 'lockNow' }, {});
    await handleMessage({ type: 'unlockSettings', password: PW }, {});
    expect(create).not.toHaveBeenCalled();
    await onTabUpdated(3, { url: URL_ });
    expect(remove.mock.calls.map((c) => c[0])).toEqual([3]);
  });

  it('skips a tab that moved on or closed before its turn', async () => {
    await seedLocked();
    let { create } = stubTab({ url: `${LOCK}#u=${URL_}` });
    await onTabUpdated(3, { url: URL_ });
    expect(create).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    chrome = installChrome();
    ({ create } = stubTab(null));
    await onTabUpdated(3, { url: URL_ });
    expect(create).not.toHaveBeenCalled();
  });

  it('replaces a tab of a domain without site access too (its worker or blocked page)', async () => {
    await seedLocked();
    vi.mocked(browser.permissions.contains).mockImplementation((async () => false) as never);
    const { create, remove } = stubTab({ url: URL_ });
    await onTabUpdated(3, { url: URL_ });
    expect((await withTargets(create.mock.calls.map((c) => c[0] as { url: string }))).map((a) => a.url)).toEqual([`${LOCK}#u=${URL_}`]);
    expect(remove.mock.calls.map((c) => c[0])).toEqual([3]);
  });

  it('a storage failure while recording the tab never skips the guard', async () => {
    await seedLocked();
    const { remove } = stubTab({ url: URL_ });
    const boom = (async () => {
      throw new Error('storage down');
    }) as never;
    vi.spyOn(browser.storage.local, 'set').mockImplementation(boom);
    vi.spyOn(browser.storage.session, 'set').mockImplementation(boom);
    await onTabUpdated(3, { url: URL_ });
    expect(remove.mock.calls.map((c) => c[0])).toEqual([3]);

    // A failed read of the recorded tabs as well.
    remove.mockClear();
    vi.spyOn(browser.storage.session, 'get').mockImplementation(boom);
    await onTabUpdated(3, { url: 'https://m.example.test/' });
    expect(remove.mock.calls.map((c) => c[0])).toEqual([3]);
  });

  it('treats a failed unlock-rule read as locked', async () => {
    await seedLocked();
    const { remove } = stubTab({ url: URL_ });
    chrome.dnr.getSessionRules.mockImplementation(async () => {
      throw new Error('dnr down');
    });
    await onTabUpdated(3, { url: URL_ });
    expect(remove.mock.calls.map((c) => c[0])).toEqual([3]);
  });

  it('the tabs.onUpdated listener passes the tab, so a reload is caught', async () => {
    background.main();
    await seedLocked();
    const { remove } = stubTab({ url: URL_ });
    await fakeBrowser.tabs.onUpdated.trigger(3, { status: 'loading' } as never, { ...TAB } as never);
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith(3));
  });
});

describe('frames of a locked site inside other pages (E1, E2)', () => {
  beforeEach(forgetTrackedTabs);
  type FakeTab = { id: number; windowId: number; index: number; pinned: boolean; active: boolean; url: string };
  const HOST: FakeTab = { id: 4, windowId: 1, index: 0, pinned: false, active: true, url: 'https://other.test/embed' };
  const FRAMES_KEY = 'frameHostTabs';
  const framed = async () => (await browser.storage.session.get(FRAMES_KEY))[FRAMES_KEY] as number[] | undefined;
  const shown = async () => (await browser.storage.session.get('shownLockedTabs')).shownLockedTabs as number[] | undefined;
  const origins = async () => (await browser.storage.local.get('shownLockedOrigins')).shownLockedOrigins as string[];
  const commit = (tabId: number, frameId: number, url: string, transitionType = 'link') =>
    onFrameCommitted({ tabId, frameId, url, transitionType });

  function stubTabs(tabs: FakeTab[]) {
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () => tabs) as never);
    const create = vi.spyOn(browser.tabs, 'create').mockImplementation((async () => ({ id: 99 })) as never);
    const remove = vi.spyOn(browser.tabs, 'remove').mockImplementation((async () => {}) as never);
    // A reload that goes through commits its main frame again.
    const reload = vi.spyOn(browser.tabs, 'reload').mockImplementation((async (id: number) => {
      void onFrameCommitted({ tabId: id, frameId: 0, url: 'https://other.test/embed', transitionType: 'reload' });
    }) as never);
    return { create, remove, reload };
  }

  it('records a tab whose frame committed a page of a listed domain, and that frame origin', async () => {
    await seedUnlocked(['example.test']);
    await commit(4, 7, 'https://a.b.c.example.test/embed');
    await commit(5, 3, 'https://notexample.test/');
    await commit(6, 0, 'https://example.test/'); // a main frame is the tab guard's job
    await commit(-1, 2, 'https://example.test/'); // not in a tab
    await commit(8, 2, 'chrome-error://chromewebdata/');
    expect(await framed()).toEqual([4]);
    expect(await origins()).toEqual(['https://a.b.c.example.test']);
    // Recorded while locked too, so a commit right before a relock is never missed.
    await handleMessage({ type: 'lockNow' }, {});
    await commit(9, 1, 'http://example.test:8080/');
    expect(await framed()).toEqual([9]);
  });

  it('a relock reloads the host tab after the site data removal, keeping it, and removes the frame origin', async () => {
    await seedUnlocked(['example.test']);
    await commit(4, 7, 'https://a.b.c.example.test/embed');
    const { create, remove, reload } = stubTabs([HOST]);
    let removalDone = false;
    chrome.browsingData.remove.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 10));
      removalDone = true;
    });
    reload.mockImplementation((async (id: number) => {
      expect(removalDone).toBe(true);
      void onFrameCommitted({ tabId: id, frameId: 0, url: HOST.url, transitionType: 'reload' });
    }) as never);
    await relock('manual');
    expect(reload.mock.calls.map((c) => c[0])).toEqual([4]);
    expect(create).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect((chrome.browsingData.remove.mock.calls[0]![0] as { origins: string[] }).origins).toContain(
      'https://a.b.c.example.test',
    );
    expect(await framed()).toBeUndefined();
  });

  it('a host tab that cannot be reloaded is recreated instead', async () => {
    await seedUnlocked(['example.test']);
    await commit(4, 7, 'https://example.test/embed');
    const { create, remove, reload } = stubTabs([HOST]);
    reload.mockImplementation((async () => {
      throw new Error('cannot reload');
    }) as never);
    await relock('manual');
    expect(create.mock.calls.map((c) => c[0])).toEqual([
      { windowId: 1, index: 0, pinned: false, active: true, url: 'https://other.test/embed' },
    ]);
    expect(remove.mock.calls.map((c) => c[0])).toEqual([4]);
  });

  it('a host tab that moved on to a new page is recreated (the embedding page is in its history)', async () => {
    await seedUnlocked(['example.test']);
    await commit(4, 7, 'https://example.test/embed');
    await commit(4, 0, 'https://other.test/embed', 'reload'); // same page reloaded: still a host
    expect(await framed()).toEqual([4]);
    await commit(4, 0, 'https://other.test/next', 'link');
    expect(await framed()).toEqual([]);
    expect(await shown()).toEqual([4]);
    const { create, reload } = stubTabs([{ ...HOST, url: 'https://other.test/next' }]);
    await relock('manual');
    expect(reload).not.toHaveBeenCalled();
    expect(create.mock.calls.map((c) => (c[0] as { url: string }).url)).toEqual(['https://other.test/next']);
  });

  it('a tab that is itself on the locked site gets the lock page, not a reload', async () => {
    await seedUnlocked(['example.test']);
    await commit(4, 7, 'https://example.test/embed');
    const { reload, remove } = stubTabs([{ ...HOST, url: 'https://example.test/page' }]);
    await relock('manual');
    expect(reload).not.toHaveBeenCalled();
    expect(remove.mock.calls.map((c) => c[0])).toEqual([4]);
  });

  it('follows replaced tabs and forgets closed ones', async () => {
    await seedUnlocked(['example.test']);
    await commit(4, 7, 'https://example.test/embed');
    await commit(5, 7, 'https://example.test/embed');
    await onTabReplaced(40, 4);
    await onTabRemoved(5);
    expect(await framed()).toEqual([40]);
  });

  it('the webNavigation listener passes the commit details', async () => {
    background.main();
    await seedUnlocked(['example.test']);
    await Promise.all(
      chrome.listeners.committed.map((l) =>
        (l as (d: unknown) => unknown)({ tabId: 4, frameId: 2, url: 'https://example.test/x', transitionType: 'link' }),
      ),
    );
    await vi.waitFor(async () => expect(await framed()).toEqual([4]));
  });
});

describe('lock page targets (E3)', () => {
  beforeEach(forgetTrackedTabs);
  const T = (n: number) => n.toString(16).padStart(32, '0');

  it('claimTarget binds a safe #u= target to the sending tab and returns a token and the host', async () => {
    await seedPassword();
    await saveSettings({ domains: ['example.test'] });
    const res = await handleMessage(
      { type: 'claimTarget', raw: 'http://www.example.test/p?q=1#h' },
      { tab: { id: 7 }, frameId: 0 },
    );
    expect(res).toMatchObject({ ok: true, host: 'www.example.test', state: { unlocked: false } });
    const token = res.ok ? res.token : '';
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(await recordOf(token)).toMatchObject({ url: 'http://www.example.test/p?q=1#h', tabId: 7, source: 'claimed' });
    // The page can read its target again, from its own tab only.
    expect(await handleMessage({ type: 'describeTarget', token }, { tab: { id: 7 }, frameId: 0 })).toMatchObject({
      ok: true,
      token,
      host: 'www.example.test',
    });
    expect(await handleMessage({ type: 'describeTarget', token }, { tab: { id: 8 }, frameId: 0 })).toMatchObject({
      ok: false,
      error: 'invalid_target',
    });
    expect(
      await handleMessage({ type: 'describeTarget', token: T(1) }, { tab: { id: 7 }, frameId: 0 }),
    ).toMatchObject({ ok: false, error: 'invalid_target' });
  });

  it('claimTarget refuses anything but an http(s) URL of a listed domain, frames and pages without a tab', async () => {
    await seedPassword();
    await saveSettings({ domains: ['example.test'] });
    const top = { tab: { id: 7 }, frameId: 0 };
    for (const raw of ['https://evil.test/', 'javascript:alert(1)', 'chrome://extensions/', '', 'not a url']) {
      expect(await handleMessage({ type: 'claimTarget', raw }, top), raw).toMatchObject({
        ok: false,
        error: 'invalid_target',
      });
    }
    for (const sender of [{ tab: { id: 7 }, frameId: 2 }, {}]) {
      expect(await handleMessage({ type: 'claimTarget', raw: 'https://example.test/' }, sender)).toMatchObject({
        ok: false,
        error: 'invalid_target',
      });
    }
    const all = await browser.storage.session.get(null);
    expect(Object.keys(all).filter((k) => k.startsWith('lockTarget:'))).toEqual([]);
  });

  it('lock pages the worker opens carry a token, never the private URL', async () => {
    await seedUnlocked(['example.test']);
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () => [
      { id: 1, windowId: 1, index: 0, pinned: false, active: true, url: 'https://www.example.test/secret?q=1' },
    ]) as never);
    const create = vi.spyOn(browser.tabs, 'create').mockImplementation((async () => ({ id: 42 })) as never);
    vi.spyOn(browser.tabs, 'remove').mockImplementation((async () => {}) as never);
    await relock('manual');
    const url = (create.mock.calls[0]![0] as { url: string }).url;
    expect(url).toMatch(new RegExp(`^${LOCK.replace(/[.]/g, '\\.')}#t=[0-9a-f]{32}$`));
    expect(url).not.toContain('example.test');
    expect(await recordOf(tokenOf(url)!)).toEqual({
      url: 'https://www.example.test/secret?q=1',
      tabId: 42,
      source: 'engine',
    });
    // The new tab may describe and unlock with it.
    expect(
      await handleMessage({ type: 'describeTarget', token: tokenOf(url)! }, { tab: { id: 42 }, frameId: 0 }),
    ).toMatchObject({ ok: true, host: 'www.example.test' });
  });

  it('a request that arrives before the new tab is bound waits for the binding', async () => {
    await seedUnlocked(['example.test']);
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () => [
      { id: 1, windowId: 1, index: 0, pinned: false, active: true, url: 'https://example.test/' },
    ]) as never);
    let describe: Promise<unknown> | undefined;
    vi.spyOn(browser.tabs, 'create').mockImplementation((async (props: { url: string }) => {
      // The lock page asks before tabs.create has resolved.
      describe = handleMessage({ type: 'describeTarget', token: tokenOf(props.url)! }, { tab: { id: 42 }, frameId: 0 });
      await new Promise((r) => setTimeout(r, 5));
      return { id: 42 };
    }) as never);
    vi.spyOn(browser.tabs, 'remove').mockImplementation((async () => {}) as never);
    await relock('manual');
    expect(await describe).toMatchObject({ ok: true, host: 'example.test' });
  });

  it('a closed tab forgets its tokens', async () => {
    await browser.storage.session.set({
      [`lockTarget:${T(1)}`]: { url: 'https://example.test/', tabId: 5, source: 'engine' },
      [`lockTarget:${T(2)}`]: { url: 'https://example.test/', tabId: 6, source: 'claimed' },
    });
    await onTabRemoved(5);
    expect(await recordOf(T(1))).toBeUndefined();
    expect(await recordOf(T(2))).toBeDefined();
  });

  it('isRequest accepts the token protocol', () => {
    expect(isRequest({ type: 'claimTarget', raw: 'https://example.test/' })).toBe(true);
    expect(isRequest({ type: 'claimTarget', raw: 'x'.repeat(16_385) })).toBe(false);
    expect(isRequest({ type: 'claimTarget' })).toBe(false);
    expect(isRequest({ type: 'describeTarget', token: T(1) })).toBe(true);
    expect(isRequest({ type: 'describeTarget', token: 1 })).toBe(false);
    expect(isRequest({ type: 'unlock', password: PW, token: T(1) })).toBe(true);
    expect(isRequest({ type: 'unlock', password: PW, token: 5 })).toBe(false);
  });
});

describe('tries left (E4)', () => {
  it('counts the wrong answers left before the first wait', async () => {
    expect([0, 1, 4, 5, 6, 20].map(triesLeft)).toEqual([5, 4, 1, 0, 0, 0]);
    await seedPassword({ failures: 3 });
    expect((await handleMessage({ type: 'getState' }, {})).state.triesLeft).toBe(2);
    await handleMessage({ type: 'unlock', password: WRONG }, {});
    expect((await handleMessage({ type: 'getState' }, {})).state.triesLeft).toBe(1);
  });
});

describe('lock-now keyboard command (E5)', () => {
  it('relocks without a password; other commands do nothing', async () => {
    await seedUnlocked(['example.test']);
    await onCommand('something-else');
    expect(chrome.state.session).not.toEqual([]);
    await onCommand('lock-now');
    expect(chrome.state.session).toEqual([]);
  });

  it('the commands listener is registered at start', async () => {
    background.main();
    await seedUnlocked(['example.test']);
    await Promise.all(chrome.listeners.command.map((l) => (l as (c: string) => unknown)('lock-now')));
    await vi.waitFor(() => expect(chrome.state.session).toEqual([]));
  });
});

describe('review minors (E6)', () => {
  beforeEach(forgetTrackedTabs);
  const stored = async () => (await browser.storage.local.get('shownLockedOrigins')).shownLockedOrigins;

  it('N1: a relock with the fallback settings keeps the stored origins', async () => {
    await seedUnlocked(['example.test']);
    await onTabUpdated(5, { url: 'https://deep.example.test/' });
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () => []) as never);
    // The worker restarted (no last known settings) and the settings read fails: the defaults
    // list nothing, but that must not wipe the stored origins.
    const get = browser.storage.local.get.bind(browser.storage.local);
    vi.spyOn(browser.storage.local, 'get').mockImplementation((async (key: unknown) => {
      if (key === 'settings' || (Array.isArray(key) && key.includes('settings'))) throw new Error('down');
      return get(key as never);
    }) as never);
    await relock('idle');
    vi.mocked(browser.storage.local.get).mockRestore();
    expect(await stored()).toEqual(['https://deep.example.test']);
  });

  it('N2: saving settings drops the stored origins of domains no longer listed', async () => {
    await seedUnlocked(['example.test', 'other.test']);
    await onTabUpdated(5, { url: 'https://app.other.test/' });
    await onTabUpdated(6, { url: 'https://example.test/' });
    await applySettings({ ...DEFAULT_SETTINGS, domains: ['example.test'] });
    expect(await stored()).toEqual(['https://example.test']);
  });

  it('N3: with the domain list unknown, the tab is guarded once the settings can be read', async () => {
    await seedPassword();
    await saveSettings({ domains: ['example.test'] });
    vi.spyOn(browser.tabs, 'get').mockImplementation((async () => ({
      id: 3,
      windowId: 1,
      index: 0,
      pinned: false,
      active: true,
      url: 'https://example.test/',
    })) as never);
    vi.spyOn(browser.tabs, 'create').mockImplementation((async () => ({ id: 99 })) as never);
    const remove = vi.spyOn(browser.tabs, 'remove').mockImplementation((async () => {}) as never);
    // The first settings read fails (and this worker knows no earlier settings).
    const get = browser.storage.local.get.bind(browser.storage.local);
    let failures = 1;
    vi.spyOn(browser.storage.local, 'get').mockImplementation((async (key: unknown) => {
      const wantsSettings = key === 'settings' || (Array.isArray(key) && key.includes('settings'));
      if (wantsSettings && failures-- > 0) throw new Error('down');
      return get(key as never);
    }) as never);
    await onTabUpdated(3, { url: 'https://example.test/' });
    expect(remove.mock.calls.map((c) => c[0])).toEqual([3]);
  });

  it('N4: the tab is recorded even when its origin cannot be stored', async () => {
    await seedUnlocked(['example.test']);
    vi.spyOn(browser.storage.local, 'set').mockImplementation((async () => {
      throw new Error('local down');
    }) as never);
    await onTabUpdated(5, { url: 'https://example.test/' });
    expect((await browser.storage.session.get('shownLockedTabs')).shownLockedTabs).toEqual([5]);
  });
});

describe("unlock scope 'site' (E7)", () => {
  beforeEach(forgetTrackedTabs);
  const T = (n: number) => n.toString(16).padStart(32, '0');
  const DOMAINS = ['example.test', 'second.test'];

  async function seedSite(domains = DOMAINS) {
    await seedPassword();
    await saveSettings({ domains, unlockScope: 'site' });
    await applySettings({ ...DEFAULT_SETTINGS, domains, unlockScope: 'site' });
  }
  async function lockTab(id: number, url: string, source: 'engine' | 'claimed' = 'engine') {
    await browser.storage.session.set({ [`lockTarget:${T(id)}`]: { url, tabId: id, source } });
  }
  const unlockFrom = (id: number, password = PW) =>
    handleMessage({ type: 'unlock', password, token: T(id) }, { tab: { id }, frameId: 0 });

  it('an unlock opens only the lock page’s own domain; the next unlock adds its domain', async () => {
    vi.spyOn(browser.tabs, 'update').mockImplementation((async () => ({})) as never);
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () => []) as never);
    await seedSite();
    await lockTab(1, 'https://www.example.test/a');
    await lockTab(2, 'https://second.test/b');
    const first = await unlockFrom(1);
    expect(first).toMatchObject({ ok: true, state: { unlocked: true, unlockedDomains: ['example.test'] } });
    expect(unlockedOf(chrome.state.session)).toEqual(['example.test']);
    expect(domainsOf(chrome.state.session, RULE_UNLOCK)).toContain('site.unlocked.for-my-privacy.invalid');
    const second = await unlockFrom(2);
    expect(second.state.unlockedDomains).toEqual(['example.test', 'second.test']);
    // A relock clears every domain.
    await relock('manual');
    expect(chrome.state.session).toEqual([]);
    expect((await handleMessage({ type: 'getState' }, {})).state.unlockedDomains).toEqual([]);
  });

  it('an unlock without a target of a listed domain opens nothing', async () => {
    await seedSite();
    const res = await handleMessage({ type: 'unlock', password: PW }, {});
    expect(res).toMatchObject({ ok: true, state: { unlocked: false, unlockedDomains: [] } });
    expect(chrome.state.session).toEqual([]);
  });

  it('only lock tabs of the opened domain go back; the other domain stays on its lock page', async () => {
    const update = vi.spyOn(browser.tabs, 'update').mockImplementation((async () => ({})) as never);
    await seedSite();
    await lockTab(1, 'https://www.example.test/a');
    await lockTab(2, 'https://second.test/b');
    await lockTab(3, 'https://m.example.test/c');
    await lockTab(4, 'chrome://extensions/');
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () =>
      [1, 2, 3, 4].map((id) => ({ id, url: `${LOCK}#t=${T(id)}` }))) as never);
    await unlockFrom(1);
    expect(update.mock.calls).toEqual([
      [1, { url: 'https://www.example.test/a' }],
      [3, { url: 'https://m.example.test/c' }],
    ]);
  });

  it('the tab guard still replaces a tab of a domain that was not unlocked', async () => {
    vi.spyOn(browser.tabs, 'update').mockImplementation((async () => ({})) as never);
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () => []) as never);
    await seedSite();
    await lockTab(1, 'https://example.test/');
    await unlockFrom(1);
    let current = 'https://example.test/feed';
    vi.spyOn(browser.tabs, 'get').mockImplementation((async () => ({
      id: 3,
      windowId: 1,
      index: 0,
      pinned: false,
      active: true,
      url: current,
    })) as never);
    vi.spyOn(browser.tabs, 'create').mockImplementation((async () => ({ id: 99 })) as never);
    const remove = vi.spyOn(browser.tabs, 'remove').mockImplementation((async () => {}) as never);
    await onTabUpdated(3, { url: current });
    expect(remove).not.toHaveBeenCalled();
    current = 'https://second.test/';
    await onTabUpdated(3, { url: current });
    expect(remove.mock.calls.map((c) => c[0])).toEqual([3]);
  });

  it('the extensions-page guard stays on after a site unlock; its own lock tab opens it until a relock', async () => {
    const update = vi.spyOn(browser.tabs, 'update').mockImplementation((async () => ({})) as never);
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () => []) as never);
    await seedSite();
    await lockTab(1, 'https://example.test/');
    await unlockFrom(1);
    update.mockClear();
    await onTabUpdated(3, { url: 'chrome://extensions/' });
    expect(update.mock.calls[0]![0]).toBe(3);
    expect(await withTargets([update.mock.calls[0]![1]])).toEqual([{ url: `${LOCK}#u=chrome://extensions/` }]);
    // A correct unlock on that guard-made lock tab opens the extensions page (no site).
    const token = tokenOf((update.mock.calls[0]![1] as { url: string }).url)!;
    expect(
      await handleMessage({ type: 'describeTarget', token }, { tab: { id: 3 }, frameId: 0 }),
    ).toMatchObject({ ok: true, kind: 'extensions', host: 'chrome://extensions' });
    update.mockClear();
    await handleMessage({ type: 'unlock', password: PW, token }, { tab: { id: 3 }, frameId: 0 });
    expect(update.mock.calls).toEqual([[3, { url: 'chrome://extensions/' }]]);
    expect(unlockedOf(chrome.state.session)).toEqual(['example.test']);
    // The guard honours it until the next relock.
    update.mockClear();
    await onTabUpdated(3, { url: 'chrome://extensions/?id=x' });
    expect(update).not.toHaveBeenCalled();
    await relock('manual');
    await onTabUpdated(3, { url: 'chrome://extensions/' });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('a claimed extensions page never opens it, even in site scope', async () => {
    const update = vi.spyOn(browser.tabs, 'update').mockImplementation((async () => ({})) as never);
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () => []) as never);
    await seedSite();
    await lockTab(5, 'chrome://extensions/', 'claimed');
    await unlockFrom(5);
    expect(update).not.toHaveBeenCalled();
    await onTabUpdated(3, { url: 'chrome://extensions/' });
    expect(update).toHaveBeenCalledTimes(1); // still guarded
  });

  it('settings changes: an added domain stays locked, a removed one leaves the rule, none left clears it', async () => {
    vi.spyOn(browser.tabs, 'update').mockImplementation((async () => ({})) as never);
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () => []) as never);
    await seedSite(['example.test']);
    await lockTab(1, 'https://example.test/');
    await unlockFrom(1);
    await applySettings({ ...DEFAULT_SETTINGS, unlockScope: 'site', domains: ['example.test', 'second.test'] });
    expect(unlockedOf(chrome.state.session)).toEqual(['example.test']);
    await applySettings({ ...DEFAULT_SETTINGS, unlockScope: 'site', domains: ['second.test'] });
    expect(chrome.state.session).toEqual([]);
  });

  it("'all' scope keeps opening every listed domain, including one added while unlocked", async () => {
    await seedUnlocked(['example.test']);
    expect((await handleMessage({ type: 'getState' }, {})).state.unlockedDomains).toEqual(['example.test']);
    await applySettings({ ...DEFAULT_SETTINGS, domains: ['example.test', 'second.test'] });
    expect(unlockedOf(chrome.state.session)).toEqual(['example.test', 'second.test']);
  });

  it('switching the scope while unlocked relocks (both ways)', async () => {
    const create = vi.spyOn(browser.tabs, 'create').mockImplementation((async () => ({ id: 99 })) as never);
    vi.spyOn(browser.tabs, 'remove').mockImplementation((async () => {}) as never);
    vi.spyOn(browser.tabs, 'update').mockImplementation((async () => ({})) as never);
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () => [
      { id: 5, windowId: 1, index: 0, pinned: false, active: true, url: 'https://example.test/' },
    ]) as never);
    await seedUnlocked(['example.test']);
    await applySettings({ ...DEFAULT_SETTINGS, domains: ['example.test'], unlockScope: 'site' });
    expect(chrome.state.session).toEqual([]);
    expect(create).toHaveBeenCalledTimes(1);

    await lockTab(1, 'https://example.test/');
    await saveSettings({ unlockScope: 'site' });
    await unlockFrom(1);
    expect(unlockedOf(chrome.state.session)).toEqual(['example.test']);
    await applySettings({ ...DEFAULT_SETTINGS, domains: ['example.test'], unlockScope: 'all' });
    expect(chrome.state.session).toEqual([]);
  });

  it('a rule made under the other scope opens nothing', () => {
    const settings = { ...DEFAULT_SETTINGS, domains: DOMAINS, unlockScope: 'site' as const };
    expect(openDomains({ scope: 'all', domains: DOMAINS }, settings)).toEqual([]);
    expect(openDomains({ scope: null, domains: DOMAINS }, settings)).toEqual([]);
    expect(openDomains({ scope: 'site', domains: ['second.test', 'gone.test'] }, settings)).toEqual(['second.test']);
    expect(openDomains(null, settings)).toEqual([]);
  });
});

describe('a lock tab goes back to its own site once that site is open (E3 follow-up)', () => {
  beforeEach(forgetTrackedTabs);
  const T = (n: number) => n.toString(16).padStart(32, '0');

  async function lockTab(id: number, url: string, source: 'engine' | 'claimed' = 'claimed', tabId = id) {
    await browser.storage.session.set({ [`lockTarget:${T(id)}`]: { url, tabId, source } });
  }
  function stubTabs() {
    const update = vi.spyOn(browser.tabs, 'update').mockImplementation((async () => ({})) as never);
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () => []) as never);
    vi.spyOn(browser.tabs, 'get').mockImplementation((async (id: number) => ({
      id,
      url: `${LOCK}#t=${T(id)}`,
    })) as never);
    return update;
  }

  it('on activation, a claimed lock tab whose site was unlocked elsewhere goes back, once', async () => {
    const update = stubTabs();
    await seedPassword();
    await saveSettings({ domains: ['example.test'] });
    await lockTab(13, 'http://www.example.test/c');
    await onTabActivated({ tabId: 13 }); // still locked
    expect(update).not.toHaveBeenCalled();
    await handleMessage({ type: 'unlock', password: PW }, {});
    await onTabActivated({ tabId: 13 });
    expect(update.mock.calls).toEqual([[13, { url: 'http://www.example.test/c' }]]);
    expect(await recordOf(T(13))).toBeUndefined();
    await onTabActivated({ tabId: 13 });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('never for a target off the listed domains, another tab’s token or a claimed extensions page', async () => {
    const update = stubTabs();
    await seedPassword();
    await saveSettings({ domains: ['example.test'] });
    await lockTab(1, 'https://evil.test/');
    await lockTab(2, 'http://example.test/', 'claimed', 99);
    await lockTab(3, 'chrome://extensions/');
    await handleMessage({ type: 'unlock', password: PW }, {});
    for (const tabId of [1, 2, 3]) await onTabActivated({ tabId });
    expect(update).not.toHaveBeenCalled();
    // The extensions page only for a token the guard made, and only after an 'all' unlock.
    await lockTab(4, 'chrome://extensions/', 'engine');
    await onTabActivated({ tabId: 4 });
    expect(update.mock.calls).toEqual([[4, { url: 'chrome://extensions/' }]]);
  });

  it("'site' scope: only a target whose domain is unlocked goes back", async () => {
    const update = stubTabs();
    await seedPassword();
    await saveSettings({ domains: ['example.test', 'second.test'], unlockScope: 'site' });
    await applySettings({ ...DEFAULT_SETTINGS, domains: ['example.test', 'second.test'], unlockScope: 'site' });
    await lockTab(1, 'https://example.test/a', 'engine');
    await lockTab(2, 'https://m.example.test/b');
    await lockTab(3, 'https://second.test/c');
    await lockTab(4, 'chrome://extensions/', 'engine');
    await handleMessage({ type: 'unlock', password: PW, token: T(1) }, { tab: { id: 1 }, frameId: 0 });
    update.mockClear();
    for (const tabId of [2, 3, 4]) await onTabActivated({ tabId });
    expect(update.mock.calls).toEqual([[2, { url: 'https://m.example.test/b' }]]);
  });

  it('a lock page that asks again (describeTarget, claimTarget) while its site is open goes back', async () => {
    const update = stubTabs();
    await seedPassword();
    await saveSettings({ domains: ['example.test'] });
    await lockTab(5, 'https://example.test/x');
    await handleMessage({ type: 'unlock', password: PW }, {});
    const described = await handleMessage({ type: 'describeTarget', token: T(5) }, { tab: { id: 5 }, frameId: 0 });
    expect(described).toMatchObject({ ok: true, host: 'example.test' });
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith(5, { url: 'https://example.test/x' }));
    const claimed = await handleMessage(
      { type: 'claimTarget', raw: 'https://www.example.test/y' },
      { tab: { id: 6 }, frameId: 0 },
    );
    expect(claimed).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith(6, { url: 'https://www.example.test/y' }));
  });

  it('the tabs.onActivated listener is registered at start', async () => {
    background.main();
    const update = stubTabs();
    await seedPassword();
    await saveSettings({ domains: ['example.test'] });
    await lockTab(7, 'https://example.test/z');
    await handleMessage({ type: 'unlock', password: PW }, {});
    await fakeBrowser.tabs.onActivated.trigger({ tabId: 7, windowId: 1 } as never);
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith(7, { url: 'https://example.test/z' }));
  });
});

describe('round 3 fix round 1 (EF1-EF4, minors)', () => {
  beforeEach(forgetTrackedTabs);
  type FakeTab = { id: number; windowId: number; index: number; pinned: boolean; active: boolean; url: string };
  const HOST: FakeTab = { id: 4, windowId: 1, index: 0, pinned: false, active: true, url: 'https://other.test/embed' };
  const T = (n: number) => n.toString(16).padStart(32, '0');

  function stubTabs(tabs: FakeTab[], { commits = true } = {}) {
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () => tabs) as never);
    vi.spyOn(browser.tabs, 'get').mockImplementation((async (id: number) => tabs.find((t) => t.id === id)) as never);
    const create = vi.spyOn(browser.tabs, 'create').mockImplementation((async () => ({ id: 99 })) as never);
    const remove = vi.spyOn(browser.tabs, 'remove').mockImplementation((async () => {}) as never);
    const reload = vi.spyOn(browser.tabs, 'reload').mockImplementation((async (id: number) => {
      if (commits) void onFrameCommitted({ tabId: id, frameId: 0, url: 'https://other.test/embed', transitionType: 'reload' });
    }) as never);
    return { create, remove, reload };
  }
  /** webNavigation.getAllFrames answers per tab. */
  function stubFrames(byTab: Record<number, { frameId: number; url: string; errorOccurred?: boolean }[]>) {
    const getAllFrames = vi.fn(async ({ tabId }: { tabId: number }) => byTab[tabId] ?? []);
    (browser.webNavigation as unknown as { getAllFrames: unknown }).getAllFrames = getAllFrames;
    return getAllFrames;
  }
  const removedOrigins = () =>
    chrome.browsingData.remove.mock.calls.map((c) => (c[0] as { origins: string[] }).origins);

  it('EF1: a locked frame that commits while locked: its origin is removed, then the host reloads', async () => {
    await seedPassword();
    await saveSettings({ domains: ['example.test'] });
    const { reload, create } = stubTabs([HOST]);
    await onFrameCommitted({ tabId: 4, frameId: 3, url: 'https://a.b.c.example.test/sw-page', parentDocumentId: 'D1' });
    expect(removedOrigins()).toEqual([['https://a.b.c.example.test']]);
    expect(reload.mock.calls.map((c) => c[0])).toEqual([4]);
    expect(create).not.toHaveBeenCalled();
    expect(chrome.browsingData.remove.mock.invocationCallOrder[0]!).toBeLessThan(reload.mock.invocationCallOrder[0]!);
    // Another frame of the same (old) host document is not handled twice.
    await onFrameCommitted({ tabId: 4, frameId: 5, url: 'https://example.test/x', parentDocumentId: 'D1' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('EF1: the frame comes back from the reloaded host document: the host tab gets the lock page', async () => {
    await seedPassword();
    await saveSettings({ domains: ['example.test'] });
    const { reload, create, remove } = stubTabs([HOST]);
    await onFrameCommitted({ tabId: 4, frameId: 3, url: 'https://a.b.c.example.test/sw-page', parentDocumentId: 'D1' });
    await onFrameCommitted({ tabId: 4, frameId: 3, url: 'https://a.b.c.example.test/sw-page', parentDocumentId: 'D2' });
    expect(reload).toHaveBeenCalledTimes(1);
    expect((await withTargets(create.mock.calls.map((c) => c[0] as { url: string }))).map((a) => a.url)).toEqual([
      `${LOCK}#u=https://a.b.c.example.test/sw-page`,
    ]);
    expect(remove.mock.calls.map((c) => c[0])).toEqual([4]);
  });

  it('EF1: a frame of an open domain, or before a password exists, is only recorded', async () => {
    await seedUnlocked(['example.test']);
    const { reload } = stubTabs([HOST]);
    await onFrameCommitted({ tabId: 4, frameId: 3, url: 'https://example.test/' });
    expect(reload).not.toHaveBeenCalled();
    expect(chrome.browsingData.remove).not.toHaveBeenCalled();
  });

  it('EF1: a relock also reloads tabs whose frames show a locked site now, though never recorded', async () => {
    await seedUnlocked(['example.test']);
    const other: FakeTab = { ...HOST, id: 5, index: 1, url: 'https://other.test/plain' };
    const { reload } = stubTabs([HOST, other]);
    stubFrames({
      4: [
        { frameId: 0, url: HOST.url },
        { frameId: 2, url: 'https://deep.example.test/w' },
      ],
      // A blocked frame reports the site's URL with errorOccurred: not shown, left alone.
      5: [
        { frameId: 0, url: other.url },
        { frameId: 2, url: 'https://example.test/', errorOccurred: true },
      ],
    });
    await relock('manual');
    expect(reload.mock.calls.map((c) => c[0])).toEqual([4]);
    expect(removedOrigins()[0]).toContain('https://deep.example.test');
    expect(removedOrigins()[0]).not.toContain('https://example.test:443');
  });

  it('EF1: browser start reloads restored tabs that show a locked site in a frame, after the removal', async () => {
    await seedPassword();
    await saveSettings({ domains: ['example.test'] });
    const { reload } = stubTabs([HOST]);
    stubFrames({ 4: [{ frameId: 2, url: 'https://deep.example.test/w' }] });
    await onBrowserStart();
    expect(reload.mock.calls.map((c) => c[0])).toEqual([4]);
    expect(removedOrigins()[0]).toContain('https://deep.example.test');
    expect(chrome.browsingData.remove.mock.invocationCallOrder[0]!).toBeLessThan(reload.mock.invocationCallOrder[0]!);
  });

  it('EF2: a reload that does not commit in time (a dialog holds it) recreates the host tab', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await seedUnlocked(['example.test']);
      await onFrameCommitted({ tabId: 4, frameId: 3, url: 'https://example.test/' });
      // The reload call itself never returns while the dialog is open.
      const { create, remove, reload } = stubTabs([HOST], { commits: false });
      reload.mockImplementation((() => new Promise(() => {})) as never);
      const done = relock('manual');
      await vi.advanceTimersByTimeAsync(3_500);
      await done;
      expect(reload).toHaveBeenCalledTimes(1);
      expect(create.mock.calls.map((c) => (c[0] as { url: string }).url)).toEqual([HOST.url]);
      expect(remove.mock.calls.map((c) => c[0])).toEqual([4]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('EF3: switching the scope while unlocked relocks the sites only, not the settings', async () => {
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () => []) as never);
    await seedUnlocked(['example.test']);
    await handleMessage({ type: 'unlockSettings', password: PW }, {});
    await applySettings({ ...DEFAULT_SETTINGS, domains: ['example.test'], unlockScope: 'site' });
    const { state } = await handleMessage({ type: 'getState' }, {});
    expect(state).toMatchObject({ unlocked: false, settingsUnlocked: true });
    // Any other relock still locks the settings too.
    await relock('manual');
    expect((await handleMessage({ type: 'getState' }, {})).state.settingsUnlocked).toBe(false);
  });

  it('EF4: claimTarget and describeTarget say what an unlock opens (kind, listed domain)', async () => {
    await seedPassword();
    await saveSettings({ domains: ['example.test'] });
    const res = await handleMessage({ type: 'claimTarget', raw: 'https://m.blog.example.test/p' }, { tab: { id: 7 }, frameId: 0 });
    expect(res).toMatchObject({ ok: true, kind: 'site', domain: 'example.test', host: 'm.blog.example.test' });
    await browser.storage.session.set({ [`lockTarget:${T(9)}`]: { url: 'chrome://extensions/', tabId: 9, source: 'engine' } });
    const ext = await handleMessage({ type: 'describeTarget', token: T(9) }, { tab: { id: 9 }, frameId: 0 });
    expect(ext).toMatchObject({ ok: true, kind: 'extensions', host: 'chrome://extensions' });
    expect(ext).not.toHaveProperty('domain');
  });

  it("EF4: 'all' scope never uses the extensions flag; a scope change clears it", async () => {
    vi.spyOn(browser.tabs, 'update').mockImplementation((async () => ({})) as never);
    vi.spyOn(browser.tabs, 'query').mockImplementation((async () => []) as never);
    await seedPassword();
    await saveSettings({ domains: ['example.test'], unlockScope: 'site' });
    await browser.storage.session.set({ [`lockTarget:${T(3)}`]: { url: 'chrome://extensions/', tabId: 3, source: 'engine' } });
    await handleMessage({ type: 'unlock', password: PW, token: T(3) }, { tab: { id: 3 }, frameId: 0 });
    expect((await browser.storage.session.get('extensionsUnlocked')).extensionsUnlocked).toBe(true);
    await applySettings({ ...DEFAULT_SETTINGS, domains: ['example.test'], unlockScope: 'all' });
    expect((await browser.storage.session.get('extensionsUnlocked')).extensionsUnlocked).toBeUndefined();
  });

  it("minor: a domain that becomes locked by a settings change sweeps its open tabs and frames ('site')", async () => {
    vi.spyOn(browser.tabs, 'update').mockImplementation((async () => ({})) as never);
    await seedPassword();
    await saveSettings({ domains: ['example.test'], unlockScope: 'site' });
    await applySettings({ ...DEFAULT_SETTINGS, domains: ['example.test'], unlockScope: 'site' });
    await browser.storage.session.set({ [`lockTarget:${T(1)}`]: { url: 'https://example.test/', tabId: 1, source: 'engine' } });
    stubTabs([]);
    await handleMessage({ type: 'unlock', password: PW, token: T(1) }, { tab: { id: 1 }, frameId: 0 });
    const tabs: FakeTab[] = [
      { id: 2, windowId: 1, index: 0, pinned: false, active: true, url: 'https://second.test/feed' },
      { id: 3, windowId: 1, index: 1, pinned: false, active: false, url: 'https://example.test/still-open' },
      HOST,
    ];
    const { create, remove, reload } = stubTabs(tabs);
    stubFrames({ 4: [{ frameId: 2, url: 'https://second.test/embed' }] });
    await saveSettings({ domains: ['example.test', 'second.test'] });
    await applySettings({ ...DEFAULT_SETTINGS, domains: ['example.test', 'second.test'], unlockScope: 'site' });
    expect((await withTargets(create.mock.calls.map((c) => c[0] as { url: string }))).map((a) => a.url)).toEqual([
      `${LOCK}#u=https://second.test/feed`,
    ]);
    expect(remove.mock.calls.map((c) => c[0])).toEqual([2]);
    expect(reload.mock.calls.map((c) => c[0])).toEqual([4]);
    expect(removedOrigins().at(-1)).toEqual(expect.arrayContaining(['https://second.test']));
  });

  it("minor: in 'all' scope while locked, an added domain's open tabs are swept too", async () => {
    await seedPassword();
    await applySettings({ ...DEFAULT_SETTINGS, domains: ['example.test'] });
    const { remove } = stubTabs([{ id: 2, windowId: 1, index: 0, pinned: false, active: true, url: 'https://second.test/' }]);
    stubFrames({});
    await applySettings({ ...DEFAULT_SETTINGS, domains: ['example.test', 'second.test'] });
    expect(remove.mock.calls.map((c) => c[0])).toEqual([2]);
  });

  it('minor: getState.unlocked is false under a rule made for the other scope', async () => {
    await seedUnlocked(['example.test']);
    await saveSettings({ unlockScope: 'site' }); // no sync yet
    expect((await handleMessage({ type: 'getState' }, {})).state).toMatchObject({ unlocked: false, unlockedDomains: [] });
  });

  it('minor: only the newest few claimed tokens of a tab are kept', async () => {
    await seedPassword();
    await saveSettings({ domains: ['example.test'] });
    const tokens: string[] = [];
    for (let i = 0; i < 5; i++) {
      vi.spyOn(Date, 'now').mockReturnValue(1_000 + i);
      const res = await handleMessage({ type: 'claimTarget', raw: `https://example.test/${i}` }, { tab: { id: 7 }, frameId: 0 });
      tokens.push(res.ok ? res.token : '');
    }
    const kept = await Promise.all(tokens.map(async (t) => (await recordOf(t)) !== undefined));
    expect(kept).toEqual([false, false, true, true, true]);
  });

  it('minor: the extensions guard fails closed when the settings or the password cannot be read', async () => {
    const update = vi.spyOn(browser.tabs, 'update').mockImplementation((async () => ({})) as never);
    await seedPassword();
    const boom = (async () => {
      throw new Error('storage down');
    }) as never;
    vi.spyOn(browser.storage.local, 'get').mockImplementation(boom);
    await onTabUpdated(3, { url: 'chrome://extensions/' });
    expect(update.mock.calls.map((c) => c[0])).toEqual([3]);
  });

  it('minor: N3 fallback keeps an open domain open when the rule was readable', async () => {
    await seedUnlocked(['example.test']);
    vi.spyOn(browser.tabs, 'get').mockImplementation((async () => ({ ...HOST, id: 3, url: 'https://example.test/' })) as never);
    vi.spyOn(browser.tabs, 'create').mockImplementation((async () => ({ id: 99 })) as never);
    const remove = vi.spyOn(browser.tabs, 'remove').mockImplementation((async () => {}) as never);
    vi.spyOn(browser.storage.local, 'get').mockImplementation((async () => {
      throw new Error('storage down');
    }) as never);
    await onTabUpdated(3, { url: 'https://example.test/' });
    expect(remove).not.toHaveBeenCalled();
  });

  it('minor: the webNavigation listener is registered for http(s) only', () => {
    const add = vi.mocked(browser.webNavigation.onCommitted.addListener);
    background.main();
    const call = add.mock.calls.at(-1)!;
    expect(call[1]).toEqual({ url: [{ schemes: ['http', 'https'] }] });
  });
});
