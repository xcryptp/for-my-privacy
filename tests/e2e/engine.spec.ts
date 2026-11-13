import type { BrowserContext, Page, Worker } from '@playwright/test';
import { test, expect, lockTargetOf } from './fixtures';

// The callbacks passed to sw.evaluate run inside the service worker, where `chrome` exists.
declare const chrome: typeof import('wxt/browser').browser;

type Api = {
  handleMessage: (req: unknown, sender: unknown) => Promise<{ ok: boolean; state: { unlocked: boolean } }>;
  saveSettings: (patch: unknown) => Promise<unknown>;
  applySettings: (settings: unknown) => Promise<void>;
  getSettings: () => Promise<unknown>;
};

const PW = 'correct horse';

const call = (sw: Worker, req: unknown) =>
  sw.evaluate((r) => (globalThis as unknown as { __fmp: Api }).__fmp.handleMessage(r, {}), req);

/** Sets a password, locks `domains`, then unlocks the sites the way the lock page does. */
async function setUp(sw: Worker, domains: string[]) {
  await sw.evaluate(
    async ({ domains, pw }) => {
      const api = (globalThis as unknown as { __fmp: Api }).__fmp;
      await api.handleMessage({ type: 'setup', password: pw }, {});
      await api.saveSettings({ domains });
      await api.applySettings(await api.getSettings());
      // Setup opens only the settings; the sites need the lock page's unlock.
      const res = await api.handleMessage({ type: 'unlock', password: pw }, {});
      if (!res.ok) throw new Error('unlock failed');
    },
    { domains, pw: PW },
  );
}

type TabInfo = { id: number; windowId: number; index: number; pinned: boolean; active: boolean; url: string };
const allTabs = (sw: Worker) =>
  sw.evaluate(async () =>
    (await chrome.tabs.query({})).map((t) => ({
      id: t.id!,
      windowId: t.windowId,
      index: t.index,
      pinned: t.pinned,
      active: t.active,
      url: t.url || t.pendingUrl || '',
    })),
  ) as Promise<TabInfo[]>;

async function openTab(sw: Worker, props: { windowId: number; url: string; pinned?: boolean; active?: boolean }) {
  return sw.evaluate(async (p) => {
    const tab = await chrome.tabs.create(p);
    return tab.id!;
  }, props);
}

async function waitLoaded(sw: Worker, tabId: number, host: string) {
  await expect
    .poll(() => sw.evaluate(async (id) => (await chrome.tabs.get(id)).title ?? '', tabId))
    .toBe(`ORIGINAL ${host}`);
}

test('relock replaces tabs in place', async ({ context, sw, extensionId, origin }) => {
  await setUp(sw, ['example.test']);
  const lockPrefix = `chrome-extension://${extensionId}/lock.html#t=`;

  // Window A: a pinned locked tab, then an unlocked other.test tab (active).
  const winA = await sw.evaluate(async () => (await chrome.windows.getLastFocused()).id!);
  const pinned = await openTab(sw, { windowId: winA, url: origin('www.example.test') + '/a', pinned: true, active: false });
  const other = await openTab(sw, { windowId: winA, url: origin('other.test') + '/', active: true });
  // Window B: an unlocked other.test tab, then the active locked tab at index 1.
  const winB = await sw.evaluate(
    async (url) => (await chrome.windows.create({ url, focused: false }))!.id!,
    origin('other.test') + '/b',
  );
  const activeLocked = await openTab(sw, { windowId: winB, url: origin('m.example.test') + '/c', active: true });
  await waitLoaded(sw, pinned, 'www.example.test');
  await waitLoaded(sw, other, 'other.test');
  await waitLoaded(sw, activeLocked, 'm.example.test');

  const before = await allTabs(sw);
  const pinnedBefore = before.find((t) => t.id === pinned)!;
  const activeBefore = before.find((t) => t.id === activeLocked)!;
  expect(pinnedBefore).toMatchObject({ pinned: true, active: false });
  expect(activeBefore).toMatchObject({ pinned: false, active: true, index: 1 });

  const res = await call(sw, { type: 'lockNow' });
  expect(res).toMatchObject({ ok: true, state: { unlocked: false } });

  const after = await allTabs(sw);
  const ids = after.map((t) => t.id);
  expect(ids).not.toContain(pinned);
  expect(ids).not.toContain(activeLocked);
  // The unlocked tab is untouched.
  expect(after.find((t) => t.id === other)).toMatchObject({ url: origin('other.test') + '/', windowId: winA });

  for (const [old, path] of [
    [pinnedBefore, origin('www.example.test') + '/a'],
    [activeBefore, origin('m.example.test') + '/c'],
  ] as const) {
    const replacement = after.find((t) => t.windowId === old.windowId && t.index === old.index)!;
    expect(replacement, path).toBeDefined();
    expect(replacement).toMatchObject({ pinned: old.pinned, active: old.active });
    // The lock page carries a token, not the private URL; the worker keeps the target.
    expect(replacement.url.startsWith(lockPrefix)).toBe(true);
    expect(replacement.url).not.toContain('example.test');
    expect(await lockTargetOf(sw, extensionId, replacement.url)).toBe(path);
  }

  // No history behind the lock page, so Back cannot bring the page back from bfcache.
  for (const path of [origin('www.example.test') + '/a', origin('m.example.test') + '/c']) {
    let page: Page | undefined;
    const find = async () => {
      for (const p of context.pages()) if ((await lockTargetOf(sw, extensionId, p.url())) === path) return p;
      return undefined;
    };
    await expect.poll(async () => (page = await find()) !== undefined).toBe(true);
    expect(await page!.evaluate(() => history.length)).toBe(1);
  }
});

test('extensions page shows the lock page while locked', async ({ context, sw, extensionId }) => {
  await setUp(sw, ['example.test']);
  await call(sw, { type: 'lockNow' });
  const page = await context.newPage();
  await page.goto('chrome://extensions/').catch(() => {});
  await expect.poll(() => page.url()).toMatch(new RegExp(`^chrome-extension://${extensionId}/lock\\.html#t=`));
  expect(await lockTargetOf(sw, extensionId, page.url())).toBe('chrome://extensions/');
});

test('extensions page opens normally while unlocked', async ({ context, sw }) => {
  await setUp(sw, ['example.test']);
  const state = await call(sw, { type: 'getState' });
  expect(state.state.unlocked).toBe(true);
  const page = await context.newPage();
  await page.goto('chrome://extensions/');
  await page.waitForTimeout(500);
  expect(page.url()).toBe('chrome://extensions/');
});

test('a tab that showed a locked site and moved on is recreated, so Back cannot restore it', async ({
  context,
  sw,
  origin,
}) => {
  await setUp(sw, ['example.test']);
  const page = await context.newPage();
  await page.goto(origin('example.test') + '/');
  await expect(page).toHaveTitle('ORIGINAL example.test');
  // Same tab, a site that is not locked; the locked page stays in this tab's history.
  await page.goto(origin('other.test') + '/');
  await expect(page).toHaveTitle('ORIGINAL other.test');

  const res = await call(sw, { type: 'lockNow' });
  expect(res).toMatchObject({ ok: true, state: { unlocked: false } });

  // Back in every remaining tab must not bring the locked page back (bfcache needs no request,
  // so the redirect rule never sees it).
  for (const p of context.pages()) {
    await p.goBack({ waitUntil: 'commit' }).catch(() => {});
    await p.waitForTimeout(500);
    if (p.isClosed()) continue;
    expect(p.url().startsWith(origin('example.test')), p.url()).toBe(false);
    expect(await p.title().catch(() => '')).not.toBe('ORIGINAL example.test');
  }

  // The tab was replaced by a new one on the same URL, with no history behind it.
  expect(page.isClosed()).toBe(true);
  const fresh = context.pages().find((p) => p.url() === origin('other.test') + '/');
  expect(fresh).toBeDefined();
  await expect(fresh!).toHaveTitle('ORIGINAL other.test');
  expect(await fresh!.evaluate(() => history.length)).toBe(1);
});

test('E1: a frame of a locked site inside another site stops showing it after a relock', async ({
  context,
  sw,
  origin,
}) => {
  await setUp(sw, ['example.test']);
  const host = await context.newPage();
  await host.goto(origin('other.test') + '/');
  await host.goto(origin('other.test') + '/frame');
  const frame = () => host.frames().find((f) => f !== host.mainFrame());
  await expect.poll(() => frame()?.title().catch(() => '')).toBe('ORIGINAL example.test');
  const historyBefore = await host.evaluate(() => history.length);

  const res = await call(sw, { type: 'lockNow' });
  expect(res).toMatchObject({ ok: true, state: { unlocked: false } });

  // The host page itself is not locked: same tab, same page, history kept; its frame no longer
  // shows the locked site.
  await expect
    .poll(async () => {
      const f = frame();
      if (!f) return 'no frame';
      return `${f.url()} | ${await f.title().catch(() => '')} | ${await f.locator('body').textContent().catch(() => '')}`;
    })
    .not.toMatch(/ORIGINAL/);
  expect(host.isClosed()).toBe(false);
  expect(host.url()).toBe(origin('other.test') + '/frame');
  expect(await host.evaluate(() => history.length)).toBe(historyBefore);
  await host.waitForTimeout(500);
  expect(await frame()!.locator('body').textContent().catch(() => '')).not.toContain('ORIGINAL-PAGE');
  // The blocked frame of the reload is not recorded again, so the next relock leaves the tab be.
  expect(await sw.evaluate(async () => (await chrome.storage.session.get('frameHostTabs')).frameHostTabs ?? [])).toEqual(
    [],
  );
});

test('E2: a service worker registered only inside a frame is removed by the relock (no flash)', async ({
  context,
  sw,
  origin,
}) => {
  await setUp(sw, ['example.test']);
  const deep = origin('a.b.c.example.test');
  // While unlocked, a page of the site embeds a deeper subdomain, which registers its worker.
  const site = await context.newPage();
  await site.goto(origin('example.test') + '/frame-sw');
  const frame = () => site.frames().find((f) => f !== site.mainFrame());
  await expect
    .poll(() => frame()?.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.active).catch(() => false))
    .toBe(true);

  await call(sw, { type: 'lockNow' });

  // Typing that host: the first document the tab commits must not be the site's cached page.
  const typed = await context.newPage();
  const commits: string[] = [];
  typed.on('framenavigated', (f) => {
    if (f === typed.mainFrame()) commits.push(f.url());
  });
  await typed.goto(deep + '/sw-page').catch(() => {});
  // The tab guard may close the tab, so wait outside it.
  await new Promise((r) => setTimeout(r, 1_000));
  expect(commits.length).toBeGreaterThan(0);
  expect(commits.filter((u) => u.startsWith(deep)), commits.join(', ')).toEqual([]);
  for (const p of context.pages()) {
    if (p.isClosed()) continue;
    expect(await p.title().catch(() => ''), p.url()).not.toBe('ORIGINAL a.b.c.example.test');
  }
});

/** Types the password into a lock page and submits it (works with the `#u=` and `#t=` pages). */
async function unlockFromPage(page: Page) {
  const field = page.locator('input[type="password"]');
  await expect(field).toBeVisible();
  await field.fill(PW);
  await field.press('Enter');
}

async function lockPageFor(context: BrowserContext, sw: Worker, extensionId: string, target: string) {
  let found: Page | undefined;
  await expect
    .poll(async () => {
      for (const p of context.pages()) {
        if (!p.isClosed() && (await lockTargetOf(sw, extensionId, p.url())) === target) return !!(found = p);
      }
      return false;
    })
    .toBe(true);
  return found!;
}

test('E3: one unlock returns the lock tabs the relock opened, never a typed #u= lock tab', async ({
  context,
  sw,
  extensionId,
  origin,
}) => {
  await setUp(sw, ['example.test']);
  const a = origin('www.example.test') + '/one';
  const b = origin('m.example.test') + '/two?x=1';
  for (const url of [a, b]) {
    const p = await context.newPage();
    await p.goto(url);
  }
  await call(sw, { type: 'lockNow' });
  const lockA = await lockPageFor(context, sw, extensionId, a);
  const lockB = await lockPageFor(context, sw, extensionId, b);
  expect(lockA.url()).toMatch(/#t=[0-9a-f]{32}$/);

  // Someone at the browser types lock page URLs of their own choosing.
  const crafted = await context.newPage();
  await crafted.goto(`chrome-extension://${extensionId}/lock.html#u=${origin('www.example.test')}/crafted`);
  const craftedExt = await context.newPage();
  await craftedExt.goto(`chrome-extension://${extensionId}/lock.html#u=chrome://extensions/`);

  await unlockFromPage(lockB);
  await expect.poll(() => lockB.url()).toBe(b);
  await expect.poll(() => lockA.url()).toBe(a);
  await expect(lockA).toHaveTitle('ORIGINAL www.example.test');
  await crafted.waitForTimeout(500);
  expect(crafted.url()).toContain('/lock.html');
  expect(craftedExt.url()).toContain('/lock.html');
});

test('E3: claimTarget binds a #u= target to its tab and swaps it for a token', async ({
  context,
  sw,
  extensionId,
  origin,
}) => {
  await setUp(sw, ['example.test']);
  await call(sw, { type: 'lockNow' });
  const target = origin('www.example.test') + '/p?q=1';
  const page = await context.newPage();
  await page.goto(target).catch(() => {});
  await expect.poll(() => page.url()).toContain('/lock.html#');
  const res = (await page.evaluate(
    (raw) => chrome.runtime.sendMessage({ type: 'claimTarget', raw }),
    target,
  )) as { ok: boolean; token: string; host: string };
  expect(res).toMatchObject({ ok: true, host: 'www.example.test' });
  expect(res.token).toMatch(/^[0-9a-f]{32}$/);
  const tokenUrl = `chrome-extension://${extensionId}/lock.html#t=${res.token}`;
  expect(await lockTargetOf(sw, extensionId, tokenUrl)).toBe(target);
  // A foreign target is refused.
  expect(
    await page.evaluate(() => chrome.runtime.sendMessage({ type: 'claimTarget', raw: 'https://other.test/' })),
  ).toMatchObject({ ok: false, error: 'invalid_target' });
  // Unlocking with the token returns this tab to its target.
  // The worker navigates this very page, so the evaluate may lose its context before it answers.
  await page
    .evaluate(
      ([password, token]) => chrome.runtime.sendMessage({ type: 'unlock', password, token }),
      [PW, res.token] as const,
    )
    .catch(() => {});
  await expect.poll(() => page.url()).toBe(target);
});

test("E7: with the 'site' scope, one unlock opens only that site; another listed site stays locked", async ({
  context,
  sw,
  extensionId,
  origin,
}) => {
  await setUp(sw, ['example.test', 'second.test']);
  await sw.evaluate(async () => {
    const api = (globalThis as unknown as { __fmp: Api }).__fmp;
    await api.saveSettings({ unlockScope: 'site' });
    await api.applySettings(await api.getSettings());
  });
  // The scope changed while unlocked: everything is locked again.
  expect((await call(sw, { type: 'getState' })).state.unlocked).toBe(false);

  const first = await context.newPage();
  const target = origin('www.example.test') + '/a';
  await first.goto(target).catch(() => {});
  await expect.poll(() => first.url()).toContain('/lock.html#');
  await unlockFromPage(first);
  await expect.poll(() => first.url()).toBe(target);
  await expect(first).toHaveTitle('ORIGINAL www.example.test');
  const state = (await call(sw, { type: 'getState' })).state as { unlocked: boolean; unlockedDomains: string[] };
  expect(state).toMatchObject({ unlocked: true, unlockedDomains: ['example.test'] });

  // The other listed site still lands on the lock page; other addresses of the opened one load.
  const second = await context.newPage();
  await second.goto(origin('second.test') + '/b').catch(() => {});
  await expect.poll(() => second.url()).toMatch(new RegExp(`^chrome-extension://${extensionId}/lock\\.html#[ut]=`));
  await second.waitForTimeout(300);
  expect(await second.title()).not.toBe('ORIGINAL second.test');
  const sub = await context.newPage();
  await sub.goto(origin('m.example.test') + '/');
  await expect(sub).toHaveTitle('ORIGINAL m.example.test');
});

/** Makes the relock's service-worker removal fail, as after a failed or timed-out removal. */
const failSiteDataRemoval = (sw: Worker) =>
  sw.evaluate(() => {
    (globalThis as unknown as { chrome: { browsingData: { remove: unknown } } }).chrome.browsingData.remove =
      async () => {
        throw new Error('disabled by the test');
      };
  });

/** Every frame (not the top one) of every open page, as "url | title". */
async function subFrames(context: BrowserContext): Promise<string[]> {
  const out: string[] = [];
  for (const p of context.pages()) {
    if (p.isClosed()) continue;
    for (const f of p.frames()) {
      if (f === p.mainFrame()) continue;
      out.push(`${f.url()} | ${await f.title().catch(() => '')}`);
    }
  }
  return out;
}

test('EF1: a frame the site’s own service worker answers while locked is not left on screen', async ({
  context,
  sw,
  origin,
}) => {
  await setUp(sw, ['example.test']);
  // While unlocked, another site embeds the locked site's deeper subdomain, which installs a
  // worker that answers the frame's navigation from its cache (no request the rules could see).
  const host = await context.newPage();
  await host.goto(origin('other.test') + '/frame-deep');
  const frame = () => host.frames().find((f) => f !== host.mainFrame());
  await expect
    .poll(() => frame()?.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.active).catch(() => false))
    .toBe(true);
  // The removal fails, so the worker survives the relock and answers the reloaded frame.
  await failSiteDataRemoval(sw);
  await call(sw, { type: 'lockNow' });

  // A new visit to the host page as well.
  const again = await context.newPage();
  await again.goto(origin('other.test') + '/frame-deep').catch(() => {});
  const shownSite = new RegExp(`^${origin('a.b.c.example.test').replace(/[.]/g, '\\.')}|ORIGINAL`);
  await expect.poll(() => subFrames(context), { timeout: 10_000 }).not.toContainEqual(expect.stringMatching(shownSite));
  await new Promise((r) => setTimeout(r, 1_000));
  expect(await subFrames(context)).not.toContainEqual(expect.stringMatching(shownSite));
});

test('EF2: a host page that holds its reload back with beforeunload still loses the frame', async ({
  context,
  sw,
  origin,
}) => {
  await setUp(sw, ['example.test']);
  const host = await context.newPage();
  await host.goto(origin('other.test') + '/frame-unload');
  const frame = () => host.frames().find((f) => f !== host.mainFrame());
  await expect.poll(() => frame()?.title().catch(() => '')).toBe('ORIGINAL example.test');
  // beforeunload dialogs need a user gesture on the page. The dialog is left open (as a person
  // away from the desk would), which holds the reload back and keeps the old document.
  const dialogs: string[] = [];
  host.on('dialog', (d) => void dialogs.push(d.type()));
  await host.locator('body').click();
  await call(sw, { type: 'lockNow' });
  await expect.poll(() => dialogs).toEqual(['beforeunload']);
  // By URL: a page held by its dialog cannot be asked for its frame's title. A blocked frame
  // shows Chrome's error page, never the site's URL.
  const shownSite = new RegExp(`^${origin('example.test').replace(/[.]/g, '\\.')}|ORIGINAL`);
  await expect.poll(() => subFrames(context), { timeout: 10_000 }).not.toContainEqual(expect.stringMatching(shownSite));
  // The host page itself is back, in a tab of its own.
  await expect
    .poll(() => context.pages().some((p) => !p.isClosed() && p.url() === origin('other.test') + '/frame-unload'))
    .toBe(true);
});

test("EF3/EF4: in 'site' scope the extensions lock page opens the extensions page until the next relock", async ({
  context,
  sw,
  extensionId,
}) => {
  await setUp(sw, ['example.test']);
  await call(sw, { type: 'unlockSettings', password: PW });
  await sw.evaluate(async () => {
    const api = (globalThis as unknown as { __fmp: Api }).__fmp;
    await api.saveSettings({ unlockScope: 'site' });
    await api.applySettings(await api.getSettings());
  });
  // The scope change locked the sites, not the settings (the owner is in the settings page).
  const after = (await call(sw, { type: 'getState' })).state as { unlocked: boolean; settingsUnlocked: boolean };
  expect(after).toMatchObject({ unlocked: false, settingsUnlocked: true });

  const page = await context.newPage();
  await page.goto('chrome://extensions/').catch(() => {});
  await expect.poll(() => page.url()).toMatch(new RegExp(`^chrome-extension://${extensionId}/lock\\.html#t=`));
  await unlockFromPage(page);
  await expect.poll(() => page.url()).toMatch(/^chrome:\/\/extensions/);
  // It stays open in another tab too, until the next relock.
  const second = await context.newPage();
  await second.goto('chrome://extensions/');
  await second.waitForTimeout(500);
  expect(second.url()).toBe('chrome://extensions/');
  await call(sw, { type: 'lockNow' });
  const third = await context.newPage();
  await third.goto('chrome://extensions/').catch(() => {});
  await expect.poll(() => third.url()).toMatch(new RegExp(`^chrome-extension://${extensionId}/lock\\.html#t=`));
});
