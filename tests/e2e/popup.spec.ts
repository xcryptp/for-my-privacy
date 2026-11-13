import type { Page, Worker } from '@playwright/test';
import { test, expect, visit } from './fixtures';

type Api = {
  handleMessage: (req: unknown, sender: unknown) => Promise<unknown>;
  saveSettings: (patch: unknown) => Promise<unknown>;
  applySettings: (settings: unknown) => Promise<void>;
  getSettings: () => Promise<unknown>;
};

const PW = 'correct horse';

declare const chrome: typeof import('wxt/browser').browser;
const msg = (sw: Worker, key: string, subs?: string) =>
  sw.evaluate(([k, s]) => chrome.i18n.getMessage(k as never, s), [key, subs] as const) as Promise<string>;

// A set-up extension that is unlocked: the state in which someone clicks the toolbar icon.
const setUp = (sw: Worker, domains: string[]) =>
  sw.evaluate(
    async ({ domains, pw }) => {
      const api = (globalThis as unknown as { __fmp: Api }).__fmp;
      await api.handleMessage({ type: 'setup', password: pw }, {});
      await api.saveSettings({ domains });
      await api.applySettings(await api.getSettings());
    },
    { domains, pw: PW },
  );

const state = (sw: Worker) =>
  sw.evaluate(async () => {
    const res = (await (globalThis as unknown as { __fmp: Api }).__fmp.handleMessage({ type: 'getState' }, {})) as {
      state: { unlocked: boolean; settingsUnlocked: boolean };
    };
    return res.state;
  });

async function openPopup(page: Page, extensionId: string) {
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
}

test('the popup shows the name, a Lock now button and Open settings, and no site names', async ({
  context,
  sw,
  extensionId,
}) => {
  await setUp(sw, ['example.test']);
  const page = await context.newPage();
  await openPopup(page, extensionId);
  await expect(page.getByRole('heading', { name: await msg(sw, 'extShortName') })).toBeVisible();
  await expect(page.getByRole('button', { name: await msg(sw, 'lockNowButton') })).toBeVisible();
  await expect(page.getByRole('button', { name: await msg(sw, 'popupOpenSettings') })).toBeVisible();
  await expect(page.getByRole('button', { name: await msg(sw, 'lockNowButton') })).toBeFocused();
  expect(await page.evaluate(() => document.body.textContent ?? '')).not.toContain('example.test');
});

test('Lock now locks the sites and the settings, then says Locked', async ({ context, sw, extensionId, origin }) => {
  await setUp(sw, ['example.test']);
  // Unlocked first: the site opens.
  await sw.evaluate(() => (globalThis as unknown as { __fmp: { setUnlocked: (d: string[]) => Promise<void> } }).__fmp.setUnlocked(['example.test']));
  const page = await context.newPage();
  await openPopup(page, extensionId);
  // The line under the title says a site is open, then that the sites are locked.
  await expect(page.getByText(await msg(sw, 'popupSomeUnlocked'), { exact: true })).toBeVisible();
  await page.getByRole('button', { name: await msg(sw, 'lockNowButton') }).click();
  await expect(page.getByRole('status').filter({ hasText: await msg(sw, 'popupLocked') })).toBeVisible();
  await expect(page.getByText(await msg(sw, 'popupAllLocked'), { exact: true })).toBeVisible();
  expect(await state(sw)).toMatchObject({ unlocked: false, settingsUnlocked: false });
  const site = await context.newPage();
  await visit(site, origin('example.test'));
  await expect.poll(() => site.url()).toMatch(new RegExp(`^chrome-extension://${extensionId}/lock\\.html#[ut]=`));
});

test('Open settings opens the options page', async ({ context, sw, extensionId }) => {
  await setUp(sw, []);
  const page = await context.newPage();
  await openPopup(page, extensionId);
  await page.getByRole('button', { name: await msg(sw, 'popupOpenSettings') }).click();
  // The page's URL is still blank when the tab appears, so look again until it has loaded.
  await expect
    .poll(() => context.pages().some((p) => p.url().startsWith(`chrome-extension://${extensionId}/options.html`)))
    .toBe(true);
});

test('before the setup is finished the popup points at the settings instead of locking', async ({
  context,
  sw,
  extensionId,
}) => {
  const page = await context.newPage();
  await openPopup(page, extensionId);
  await expect(page.getByText(await msg(sw, 'popupNotSet'))).toBeVisible();
  await expect(page.getByRole('button', { name: await msg(sw, 'lockNowButton') })).toBeDisabled();
});

test('the popup fits 320 px wide in light and dark', async ({ context, extensionId }) => {
  const page = await context.newPage();
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 320, height: 400 });
    await openPopup(page, extensionId);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});
