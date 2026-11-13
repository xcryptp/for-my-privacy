import type { Page, Worker } from '@playwright/test';
import { test, expect } from './fixtures';

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

/** Sets a password and locks `domains`; the worker is then unlocked (setup unlocks). */
async function setUp(sw: Worker, domains: string[]) {
  await sw.evaluate(
    async ({ domains, pw }) => {
      const api = (globalThis as unknown as { __fmp: Api }).__fmp;
      await api.handleMessage({ type: 'setup', password: pw }, {});
      await api.saveSettings({ domains });
      await api.applySettings(await api.getSettings());
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
      url: t.url ?? t.pendingUrl ?? '',
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
  const lockPrefix = `chrome-extension://${extensionId}/lock.html#u=`;

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
    expect(replacement).toMatchObject({ pinned: old.pinned, active: old.active, url: lockPrefix + path });
  }

  // No history behind the lock page, so Back cannot bring the page back from bfcache.
  for (const path of [origin('www.example.test') + '/a', origin('m.example.test') + '/c']) {
    let page: Page | undefined;
    await expect.poll(() => (page = context.pages().find((p) => p.url() === lockPrefix + path)) !== undefined).toBe(true);
    expect(await page!.evaluate(() => history.length)).toBe(1);
  }
});

test('extensions page shows the lock page while locked', async ({ context, sw, extensionId }) => {
  await setUp(sw, ['example.test']);
  await call(sw, { type: 'lockNow' });
  const page = await context.newPage();
  await page.goto('chrome://extensions/').catch(() => {});
  await expect
    .poll(() => page.url())
    .toBe(`chrome-extension://${extensionId}/lock.html#u=chrome://extensions/`);
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
