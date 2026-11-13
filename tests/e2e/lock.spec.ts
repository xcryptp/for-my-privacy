import type { Page, Worker } from '@playwright/test';
import { test, expect } from './fixtures';

type Api = {
  handleMessage: (req: unknown, sender: unknown) => Promise<unknown>;
  saveSettings: (patch: unknown) => Promise<unknown>;
  applySettings: (settings: unknown) => Promise<void>;
  getSettings: () => Promise<unknown>;
};

const PW = 'correct horse';

// Same setup the options page produces: a password, the locked domains, then locked again.
const lockDomains = (sw: Worker, domains: string[]) =>
  sw.evaluate(
    async ({ domains, pw }) => {
      const api = (globalThis as unknown as { __fmp: Api }).__fmp;
      await api.handleMessage({ type: 'setup', password: pw }, {});
      await api.saveSettings({ domains });
      await api.applySettings(await api.getSettings());
      await api.handleMessage({ type: 'lockNow' }, {});
    },
    { domains, pw: PW },
  );

// The browser UI language decides which locale chrome.i18n serves, and it differs between
// machines, so every expected text is looked up from the extension's own messages.
declare const chrome: typeof import('wxt/browser').browser;
const msg = (sw: Worker, key: string, subs?: string) =>
  sw.evaluate(([k, s]) => chrome.i18n.getMessage(k as never, s), [key, subs] as const) as Promise<string>;

/** The lock page's controls and expected texts for the browser's language. */
async function lockUi(page: Page, sw: Worker) {
  const [password, unlock] = await Promise.all([msg(sw, 'passwordLabel'), msg(sw, 'unlockButton')]);
  return {
    field: page.getByLabel(password),
    button: page.getByRole('button', { name: unlock }),
    alert: page.getByRole('alert'),
    status: page.getByRole('status'),
    text: (key: string, subs?: string) => msg(sw, key, subs),
  };
}

async function openLockPage(page: Page, sw: Worker, extensionId: string, target: string) {
  await page.goto(`chrome-extension://${extensionId}/lock.html#u=${target}`);
  await expect(page.getByRole('heading', { name: await msg(sw, 'lockTitle') })).toBeVisible();
  return lockUi(page, sw);
}

test('the lock page names the site and starts with focus in the password field', async ({
  context,
  sw,
  extensionId,
  origin,
}) => {
  await lockDomains(sw, ['example.test']);
  const page = await context.newPage();
  const ui = await openLockPage(page, sw, extensionId, origin('www.example.test') + '/p');
  await expect(page.getByText(await ui.text('lockSubtitle', 'www.example.test'))).toBeVisible();
  await expect(ui.field).toBeFocused();
  await expect(page.getByRole('link', { name: await ui.text('openSettings') })).toBeVisible();
});

test('a wrong password shows the error and keeps the lock page', async ({ context, sw, extensionId, origin }) => {
  await lockDomains(sw, ['example.test']);
  const page = await context.newPage();
  const ui = await openLockPage(page, sw, extensionId, origin('example.test') + '/');
  await ui.field.fill('not the password');
  await ui.button.click();
  await expect(ui.alert).toHaveText(await ui.text('wrongPassword'));
  await expect(ui.field).toBeFocused();
  expect(page.url()).toContain('lock.html');
});

test('five wrong answers show a countdown and disable the button', async ({ context, sw, extensionId, origin }) => {
  await lockDomains(sw, ['example.test']);
  const page = await context.newPage();
  const ui = await openLockPage(page, sw, extensionId, origin('example.test') + '/');
  for (let i = 0; i < 5; i++) {
    await ui.field.fill(`wrong ${i}`);
    await ui.field.press('Enter');
    await expect(ui.alert).not.toBeEmpty();
  }
  // The message with a countdown of 0:30, allowing for a second or two to have passed.
  const template = (await ui.text('tooManyAttempts', 'M:SS')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const waiting = (seconds: string) => new RegExp(`^${template.replace('M:SS', `0:(${seconds})`)}$`);
  await expect(ui.alert).toHaveText(waiting('30|29|28'));
  await expect(ui.button).toBeDisabled();
  // The countdown moves.
  await expect(ui.alert).toHaveText(waiting('2[0-8]'), { timeout: 5_000 });
  // The wait survives a reload of the lock page.
  await page.reload();
  await expect(ui.alert).toHaveText(waiting('30|29|[12][0-9]'));
  await expect(ui.button).toBeDisabled();
});

test('the right password returns to the original URL (Enter submits)', async ({
  context,
  sw,
  extensionId,
  origin,
}) => {
  await lockDomains(sw, ['example.test']);
  const page = await context.newPage();
  const target = origin('www.example.test') + '/p?q=1#h';
  await page.goto(target).catch(() => {});
  await expect.poll(() => page.url()).toContain(`chrome-extension://${extensionId}/lock.html#u=`);
  const ui = await lockUi(page, sw);
  await ui.field.fill(PW);
  await ui.field.press('Enter');
  await expect.poll(() => page.url()).toBe(target);
  await expect(page).toHaveTitle('ORIGINAL www.example.test');
});

test('the extensions page returns after unlocking', async ({ context, sw, extensionId }) => {
  await lockDomains(sw, ['example.test']);
  const page = await context.newPage();
  await page.goto('chrome://extensions/').catch(() => {});
  await expect
    .poll(() => page.url())
    .toBe(`chrome-extension://${extensionId}/lock.html#u=chrome://extensions/`);
  const ui = await lockUi(page, sw);
  await expect(page.getByText(await ui.text('lockSubtitle', 'chrome://extensions'))).toBeVisible();
  await ui.field.fill(PW);
  await ui.button.click();
  await expect.poll(() => page.url()).toMatch(/^chrome:\/\/extensions/);
});

test('a javascript: target is never followed and the page says so', async ({ context, sw, extensionId }) => {
  await lockDomains(sw, ['example.test']);
  const page = await context.newPage();
  const ui = await openLockPage(page, sw, extensionId, 'javascript:alert(1)');
  await ui.field.fill(PW);
  await ui.button.click();
  await expect(ui.status).toHaveText(await ui.text('unlockedNoReturn'));
  expect(page.url()).toContain('lock.html');
});

test('a foreign https target is not followed either', async ({ context, sw, extensionId }) => {
  await lockDomains(sw, ['example.test']);
  const page = await context.newPage();
  const ui = await openLockPage(page, sw, extensionId, 'https://other.test/');
  await ui.field.fill(PW);
  await ui.button.click();
  await expect(ui.status).toHaveText(await ui.text('unlockedNoReturn'));
  expect(page.url()).toContain('lock.html');
});
