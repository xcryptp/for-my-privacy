import type { BrowserContext, Page, Worker } from '@playwright/test';
import { test, expect } from './fixtures';

type Api = {
  setUnlocked: (domains: string[]) => Promise<void>;
  clearUnlocked: () => Promise<void>;
  isUnlocked: () => Promise<boolean>;
  handleMessage: (req: unknown, sender: unknown) => Promise<{ ok: boolean; state: { hasPassword: boolean } }>;
  saveSettings: (patch: unknown) => Promise<unknown>;
  applySettings: (settings: unknown) => Promise<void>;
  getSettings: () => Promise<unknown>;
};

// The worker owns the rules (it re-syncs them on start and on settings changes, and blocks
// nothing before a password exists), so tests lock domains the way the options page does:
// a password, then the domain list. Setup opens only the settings; the helper still ends with a
// lockNow so every test starts from a relock.
const sync = (sw: Worker, domains: string[]) =>
  sw.evaluate(async (d) => {
    const api = (globalThis as unknown as { __fmp: Api }).__fmp;
    const { state } = await api.handleMessage({ type: 'getState' }, {});
    if (!state.hasPassword) await api.handleMessage({ type: 'setup', password: 'correct horse' }, {});
    await api.saveSettings({ domains: d });
    await api.applySettings(await api.getSettings());
    // lockNow goes through the worker's rule queue, so a pending settings resync cannot
    // re-create the unlock rule afterwards (a bare clearUnlocked could race with it).
    await api.handleMessage({ type: 'lockNow' }, {});
  }, domains);
const unlock = (sw: Worker, domains: string[]) =>
  sw.evaluate((d) => (globalThis as unknown as { __fmp: Api }).__fmp.setUnlocked(d), domains);
const clearUnlock = (sw: Worker) =>
  sw.evaluate(() => (globalThis as unknown as { __fmp: Api }).__fmp.clearUnlocked());
const isUnlocked = (sw: Worker) =>
  sw.evaluate(() => (globalThis as unknown as { __fmp: Api }).__fmp.isUnlocked());

// A redirect to the extension page can surface as a rejected goto; the final URL is what counts.
async function visit(page: Page, url: string) {
  await page.goto(url).catch(() => {});
}

test('B1: the domain and its subdomains land on the lock page, look-alikes do not', async ({
  context,
  sw,
  extensionId,
  origin,
}) => {
  await sync(sw, ['example.test']);
  const page = await context.newPage();
  const lockPrefix = `chrome-extension://${extensionId}/lock.html`;
  for (const host of ['example.test', 'www.example.test', 'm.example.test', 'EXAMPLE.test', 'example.test.']) {
    await visit(page, origin(host));
    expect(page.url(), host).toMatch(new RegExp(`^${lockPrefix.replace(/[.]/g, '\\.')}#u=`));
  }
  for (const host of ['notexample.test', 'example.test.notexample.test']) {
    await visit(page, origin(host));
    await expect(page, host).toHaveTitle(`ORIGINAL ${host}`);
  }
});

test('the lock page URL carries the original URL', async ({ context, sw, extensionId, origin }) => {
  await sync(sw, ['example.test']);
  const page = await context.newPage();
  await visit(page, origin('www.example.test') + '/p?q=1#h');
  const url = new URL(page.url());
  expect(url.protocol).toBe('chrome-extension:');
  expect(url.host).toBe(extensionId);
  expect(url.pathname).toBe('/lock.html');
  expect(url.hash.startsWith('#u=' + origin('www.example.test') + '/p?q=1')).toBe(true);
});

test('B2: a navigation started by another site is redirected too', async ({ context, sw, extensionId, origin }) => {
  await sync(sw, ['example.test']);
  const page = await context.newPage();
  await page.goto(origin('other.test'));
  await expect(page).toHaveTitle('ORIGINAL other.test');
  await page.evaluate((u) => void (location.href = u), origin('example.test'));
  await expect.poll(() => page.url()).toContain(`chrome-extension://${extensionId}/lock.html#u=`);
});

test('B3: unlocking lets the site through until it is cleared', async ({ context, sw, extensionId, origin }) => {
  await sync(sw, ['example.test']);
  await unlock(sw, ['example.test']);
  expect(await isUnlocked(sw)).toBe(true);
  const page = await context.newPage();
  await visit(page, origin('www.example.test'));
  await expect(page).toHaveTitle('ORIGINAL www.example.test');
  await clearUnlock(sw);
  expect(await isUnlocked(sw)).toBe(false);
  await visit(page, origin('www.example.test'));
  expect(page.url().startsWith(`chrome-extension://${extensionId}/lock.html#u=`)).toBe(true);
});

test('B4: block rules survive a browser restart, the unlock does not', async ({
  context,
  sw,
  relaunch,
  extensionId,
  origin,
}) => {
  await sync(sw, ['example.test']);
  await unlock(sw, ['example.test']);
  expect(await isUnlocked(sw)).toBe(true);
  await relaunch();
  expect(await isUnlocked(sw)).toBe(false);
  const page = await context.newPage();
  await visit(page, origin('example.test'));
  expect(page.url().startsWith(`chrome-extension://${extensionId}/lock.html#u=`)).toBe(true);
});

test('B6: view-source of a locked page shows the lock page', async ({ context, sw, extensionId, origin }) => {
  await sync(sw, ['example.test']);
  const page = await context.newPage();
  await visit(page, 'view-source:' + origin('example.test'));
  expect(page.url()).toContain(`chrome-extension://${extensionId}/lock.html`);
});

test('B9a: a domain without host permission is blocked, then its tab ends on the lock page', async ({
  context,
  sw,
  extensionId,
  origin,
}) => {
  await sync(sw, ['example.test', 'noperm.test']);
  const page = await context.newPage();
  const failed: { url: string; error: string | undefined }[] = [];
  page.on('requestfailed', (r) => failed.push({ url: r.url(), error: r.failure()?.errorText }));
  const url = origin('noperm.test') + '/';
  await page.goto(url).catch(() => {});
  // The block rule fails the navigation itself (no redirect without host access).
  await expect.poll(() => failed.find((f) => f.url === url)?.error).toBe('net::ERR_BLOCKED_BY_CLIENT');
  // Chrome's blocked page commits under the site's URL; the tab guard then swaps the tab for
  // the lock page. The site's own page is never the final state.
  const lockUrl = `chrome-extension://${extensionId}/lock.html#u=${url}`;
  await expect.poll(() => context.pages().some((p) => !p.isClosed() && p.url() === lockUrl)).toBe(true);
  await new Promise((r) => setTimeout(r, 500));
  for (const p of context.pages()) {
    if (p.isClosed()) continue;
    expect(await p.title().catch(() => ''), p.url()).not.toBe('ORIGINAL noperm.test');
    expect(await p.locator('body').textContent().catch(() => ''), p.url()).not.toContain('ORIGINAL-PAGE');
  }
});

test('B9b: an iframe of a locked domain does not load, even inside an unlocked page', async ({
  context,
  sw,
  origin,
}) => {
  await sync(sw, ['example.test', 'noperm.test']);
  const page = await context.newPage();
  const failed: { url: string; error: string | undefined }[] = [];
  page.on('requestfailed', (r) => failed.push({ url: r.url(), error: r.failure()?.errorText }));
  await page.goto(origin('other.test') + '/frame');
  await expect(page).toHaveTitle('ORIGINAL other.test');
  const frame = page.frames().find((f) => f !== page.mainFrame());
  expect(frame).toBeDefined();
  // The frame request was blocked by the extension, not merely slow or empty.
  await expect
    .poll(() => failed.find((f) => f.url === origin('example.test') + '/')?.error)
    .toBe('net::ERR_BLOCKED_BY_CLIENT');
  await expect.poll(() => frame!.url()).toBe('chrome-error://chromewebdata/');
  expect(frame!.url()).not.toBe(origin('example.test') + '/');
  expect(await frame!.title().catch(() => '')).not.toBe('ORIGINAL example.test');
});

// Instagram-style sites register a service worker that answers navigations from its cache, so a
// typed navigation never reaches the network and the redirect rule never sees it.
async function installSiteWorker(
  context: BrowserContext,
  sw: Worker,
  origin: (host: string) => string,
  host = 'example.test',
) {
  const res = await sw.evaluate(
    (pw) => (globalThis as unknown as { __fmp: Api }).__fmp.handleMessage({ type: 'unlock', password: pw }, {}),
    'correct horse',
  );
  expect(res.ok).toBe(true);
  // While unlocked the site installs its service worker and it takes control of the page.
  const site = await context.newPage();
  await site.goto(origin(host) + '/sw-page');
  await site.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await site.reload();
  await expect.poll(() => site.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  // A page that is not locked, loaded while unlocked, can reach the site's data.
  const other = await context.newPage();
  await other.goto(origin('other.test') + '/');
  const fetchApi = () =>
    other.evaluate(
      (u) => fetch(u).then((r) => r.text(), (e: Error) => `failed: ${e.message}`),
      origin(host) + '/api',
    );
  expect(await fetchApi()).toBe('{"data":"SECRET"}');
  return { fetchApi };
}

/** Types the cached page into a new tab; it must end on the lock page and nothing shows the site. */
async function expectTypedPageLocked(context: BrowserContext, extensionId: string, url: string) {
  const title = `ORIGINAL ${new URL(url).hostname}`;
  // The relock sent the site's tab to the lock page; close it so only the new tab can show one.
  const lockUrl = `chrome-extension://${extensionId}/lock.html#u=${url}`;
  for (const p of context.pages()) if (p.url() === lockUrl) await p.close();
  const typed = await context.newPage();
  await typed.goto(url).catch(() => {});
  await expect.soft
    .poll(() => context.pages().some((p) => !p.isClosed() && p.url() === lockUrl), { timeout: 5_000 })
    .toBe(true);
  await new Promise((r) => setTimeout(r, 500));
  for (const p of context.pages()) {
    if (p.isClosed()) continue;
    expect.soft(await p.title().catch(() => ''), p.url()).not.toBe(title);
  }
}

const lockNow = (sw: Worker) =>
  sw.evaluate(() => (globalThis as unknown as { __fmp: Api }).__fmp.handleMessage({ type: 'lockNow' }, {}));

test('B10: a site service worker cannot show a locked page or fetch its data after a relock', async ({
  context,
  sw,
  extensionId,
  origin,
}) => {
  await sync(sw, ['example.test']);
  const { fetchApi } = await installSiteWorker(context, sw, origin);
  await lockNow(sw);

  // (a) A new tab typed to the page the service worker cached shows the lock page, not the page.
  await expectTypedPageLocked(context, extensionId, origin('example.test') + '/sw-page');
  // (b) The site's data cannot be fetched any more, even from a page loaded while unlocked.
  expect(await fetchApi()).toMatch(/^failed: /);

  // (c) The relock removed the site's service worker: once unlocked again, a page of the site
  // is not controlled and finds no registration.
  await unlock(sw, ['example.test']);
  const page = await context.newPage();
  await page.goto(origin('example.test') + '/');
  await expect(page).toHaveTitle('ORIGINAL example.test');
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(false);
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
});

test('B11: without the service-worker removal, the tab guard and the rules still keep the site locked', async ({
  context,
  sw,
  extensionId,
  origin,
}) => {
  await sync(sw, ['example.test']);
  const { fetchApi } = await installSiteWorker(context, sw, origin);
  // Make the removal fail, so the site's service worker survives the relock.
  await disableSiteDataRemoval(sw);
  await lockNow(sw);
  // The service worker answers the navigation from its cache; tabs.onUpdated replaces the tab.
  await expectTypedPageLocked(context, extensionId, origin('example.test') + '/sw-page');
  expect(await fetchApi()).toMatch(/^failed: /);

  // Check the premise: the service worker really survived, so the network rules never saw the page.
  await unlock(sw, ['example.test']);
  const page = await context.newPage();
  await page.goto(origin('example.test') + '/');
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(1);
});

/** Makes the relock's service-worker removal fail, as after a restart or a failed removal. */
const disableSiteDataRemoval = (sw: Worker) =>
  sw.evaluate(() => {
    (globalThis as unknown as { chrome: { browsingData: { remove: unknown } } }).chrome.browsingData.remove =
      async () => {
        throw new Error('disabled by the test');
      };
  });

test('B12: a domain without host permission answered by its own service worker still shows the lock page', async ({
  context,
  sw,
  extensionId,
  origin,
}) => {
  await sync(sw, ['example.test', 'noperm.test']);
  // The unlock rule lets noperm.test through, so its worker installs while unlocked.
  const { fetchApi } = await installSiteWorker(context, sw, origin, 'noperm.test');
  await disableSiteDataRemoval(sw);
  await lockNow(sw);
  // No redirect can apply without host access, and the worker answers from its cache anyway;
  // the tab guard still replaces the tab.
  await expectTypedPageLocked(context, extensionId, origin('noperm.test') + '/sw-page');
  expect(await fetchApi()).toMatch(/^failed: /);

  // Premise: the worker survived the relock.
  await unlock(sw, ['example.test', 'noperm.test']);
  const page = await context.newPage();
  await page.goto(origin('noperm.test') + '/');
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(1);
});
