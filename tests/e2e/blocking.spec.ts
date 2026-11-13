import type { Page, Worker } from '@playwright/test';
import { test, expect } from './fixtures';

type Api = {
  setUnlocked: (domains: string[]) => Promise<void>;
  clearUnlocked: () => Promise<void>;
  isUnlocked: () => Promise<boolean>;
  handleMessage: (req: unknown, sender: unknown) => Promise<{ state: { hasPassword: boolean } }>;
  saveSettings: (patch: unknown) => Promise<unknown>;
  applySettings: (settings: unknown) => Promise<void>;
  getSettings: () => Promise<unknown>;
};

// The worker owns the rules (it re-syncs them on start and on settings changes, and blocks
// nothing before a password exists), so tests lock domains the way the options page does:
// a password, then the domain list. Setup unlocks, so the helper locks again at the end.
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

test('B9a: a domain without host permission gets a navigation error, not the page or the lock page', async ({
  context,
  sw,
  origin,
}) => {
  await sync(sw, ['example.test', 'noperm.test']);
  const page = await context.newPage();
  await visit(page, origin('noperm.test'));
  expect(page.url()).not.toContain('lock.html');
  expect(await page.title()).not.toBe('ORIGINAL noperm.test');
  await expect(page.locator('body')).not.toHaveText('ORIGINAL-PAGE');
});

test('B9b: an iframe of a locked domain does not load, even inside an unlocked page', async ({
  context,
  sw,
  origin,
}) => {
  await sync(sw, ['example.test', 'noperm.test']);
  const page = await context.newPage();
  await page.goto(origin('other.test') + '/frame');
  await expect(page).toHaveTitle('ORIGINAL other.test');
  const frame = page.frames().find((f) => f !== page.mainFrame());
  expect(frame).toBeDefined();
  expect(frame!.url()).not.toBe(origin('example.test') + '/');
  expect(await frame!.title().catch(() => '')).not.toBe('ORIGINAL example.test');
});
