import type { Page, Worker } from '@playwright/test';
import { test, expect } from './fixtures';

type Api = {
  handleMessage: (req: unknown, sender: unknown) => Promise<unknown>;
  saveSettings: (patch: unknown) => Promise<unknown>;
};

const PW = 'correct horse';

// The browser UI language decides which locale chrome.i18n serves, and it differs between
// machines, so every expected text is looked up from the extension's own messages.
declare const chrome: typeof import('wxt/browser').browser;
const msg = (sw: Worker, key: string, subs?: string) =>
  sw.evaluate(([k, s]) => chrome.i18n.getMessage(k as never, s), [key, subs] as const) as Promise<string>;

/** Controls and expected texts of the options page, in the browser's language. */
async function optionsUi(page: Page, sw: Worker) {
  const text = (key: string, subs?: string) => msg(sw, key, subs);
  const [password, confirm, create, unlock, add, remove, lockNow, idle, current, next, save] = await Promise.all([
    text('passwordLabel'),
    text('confirmPasswordLabel'),
    text('createButton'),
    text('unlockButton'),
    text('addButton'),
    text('removeButton'),
    text('lockNowButton'),
    text('idleMinutesLabel'),
    text('currentPasswordLabel'),
    text('newPasswordLabel'),
    text('saveButton'),
  ]);
  return {
    text,
    // The same label sits on the setup and the unlock form; only the visible one counts.
    password: page.getByLabel(password, { exact: true }).filter({ visible: true }),
    confirm: page.getByLabel(confirm, { exact: true }),
    create: page.getByRole('button', { name: create }),
    unlock: page.getByRole('button', { name: unlock }),
    add: page.getByRole('button', { name: add, exact: true }),
    remove: page.getByRole('button', { name: remove }),
    lockNow: page.getByRole('button', { name: lockNow }),
    idle: page.getByLabel(idle),
    current: page.getByLabel(current, { exact: true }),
    next: page.getByLabel(next, { exact: true }),
    save: page.getByRole('button', { name: save, exact: true }),
    domainField: page.locator('#domain'),
    domainError: page.locator('#domain-error'),
    list: page.locator('#domains'),
    setupError: page.locator('#setup-error'),
    unlockError: page.locator('#unlock-error'),
    changeError: page.locator('#change-error'),
    toast: page.getByRole('status'),
    heading: (key: string) => text(key).then((name) => page.getByRole('heading', { name })),
  };
}

async function openOptions(page: Page, sw: Worker, extensionId: string, hash = '') {
  await page.goto(`chrome-extension://${extensionId}/options.html${hash}`);
  return optionsUi(page, sw);
}

async function createPassword(ui: Awaited<ReturnType<typeof optionsUi>>) {
  await ui.password.fill(PW);
  await ui.confirm.fill(PW);
  await ui.create.click();
  await expect(ui.lockNow).toBeVisible();
}

test('a password shorter than 8 characters is refused on the setup form', async ({ context, sw, extensionId }) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await expect(await ui.heading('setupTitle')).toBeVisible();
  await ui.password.fill('1234567');
  await ui.confirm.fill('1234567');
  await ui.create.click();
  await expect(ui.setupError).toHaveText(await ui.text('passwordTooShort'));
  await expect(await ui.heading('setupTitle')).toBeVisible();
});

test('two different passwords are refused on the setup form', async ({ context, sw, extensionId }) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await ui.password.fill(PW);
  await ui.confirm.fill(PW + 'x');
  await ui.create.click();
  await expect(ui.setupError).toHaveText(await ui.text('passwordMismatch'));
});

test('setup creates the password and opens the settings', async ({ context, sw, extensionId }) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await createPassword(ui);
  await expect(await ui.heading('domainsTitle')).toBeVisible();
  await expect(page.getByText(await ui.text('emptyDomains'))).toBeVisible();
  await expect(ui.idle).toHaveValue('5');
});

test('adding a site lists it normalized and, after Lock now, its subdomains are locked', async ({
  context,
  sw,
  extensionId,
  origin,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await createPassword(ui);
  await ui.domainField.fill('Example.TEST');
  await ui.add.click();
  await expect(ui.list.getByText('example.test', { exact: true })).toBeVisible();
  await expect(ui.toast).toHaveText(await ui.text('saved'));
  await expect(ui.domainField).toHaveValue('');

  await ui.lockNow.click();
  await expect(ui.unlock).toBeVisible();

  const site = await context.newPage();
  await site.goto(origin('www.example.test')).catch(() => {});
  await expect.poll(() => site.url()).toContain(`chrome-extension://${extensionId}/lock.html#u=`);
});

test('an input that is not a domain shows the invalid message and is not added', async ({
  context,
  sw,
  extensionId,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await createPassword(ui);
  await ui.domainField.fill('not a domain');
  await ui.add.click();
  await expect(ui.domainError).toHaveText(await ui.text('invalidDomain'));
  await expect(ui.list.locator('li')).toHaveCount(0);
});

test('Enter in the site field adds it, and Remove takes it out again', async ({ context, sw, extensionId }) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await createPassword(ui);
  await ui.domainField.fill('https://www.example.test/some/path');
  await ui.domainField.press('Enter');
  await expect(ui.list.locator('li')).toHaveCount(1);
  await expect(ui.list.getByText('example.test', { exact: true })).toBeVisible();
  await ui.remove.click();
  await expect(ui.list.locator('li')).toHaveCount(0);
  await expect(page.getByText(await ui.text('emptyDomains'))).toBeVisible();
});

test('idle minutes 0 is saved as 1', async ({ context, sw, extensionId }) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await createPassword(ui);
  await ui.idle.fill('0');
  await ui.idle.press('Enter');
  await expect(ui.idle).toHaveValue('1');
  await expect(ui.toast).toHaveText(await ui.text('saved'));
  await page.reload();
  await expect(ui.idle).toHaveValue('1');
});

test('the screen-lock and guard switches are saved', async ({ context, sw, extensionId }) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await createPassword(ui);
  const screen = page.getByRole('switch', { name: await ui.text('screenLockLabel') });
  const guard = page.getByRole('switch', { name: await ui.text('guardLabel') });
  await expect(screen).toBeChecked();
  await expect(guard).toBeChecked();
  await screen.click();
  await guard.click();
  await page.reload();
  await expect(screen).not.toBeChecked();
  await expect(guard).not.toBeChecked();
});

test('changing the password works: the new one unlocks, the old one does not', async ({
  context,
  sw,
  extensionId,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await createPassword(ui);

  // A wrong current password is reported and nothing changes.
  await ui.current.fill('not the password');
  await ui.next.fill('another secret');
  await ui.save.click();
  await expect(ui.changeError).toHaveText(await ui.text('wrongPassword'));

  await ui.current.fill(PW);
  await ui.next.fill('another secret');
  await ui.save.click();
  await expect(ui.toast).toHaveText(await ui.text('saved'));
  await expect(ui.current).toHaveValue('');

  await ui.lockNow.click();
  await expect(ui.unlock).toBeVisible();
  await ui.password.fill(PW);
  await ui.unlock.click();
  await expect(ui.unlockError).toHaveText(await ui.text('wrongPassword'));
  await ui.password.fill('another secret');
  await ui.unlock.click();
  await expect(await ui.heading('domainsTitle')).toBeVisible();
});

test('Lock now locks again and the locked page shows no site names', async ({ context, sw, extensionId }) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await createPassword(ui);
  await ui.domainField.fill('example.test');
  await ui.add.click();
  await expect(ui.list.locator('li')).toHaveCount(1);

  await ui.lockNow.click();
  await expect(await ui.heading('settingsLockedTitle')).toBeVisible();
  await expect(ui.unlock).toBeVisible();
  await expect(page.getByText('example.test')).toHaveCount(0);
  await expect(ui.lockNow).toBeHidden();
  await expect(await ui.heading('domainsTitle')).toBeHidden();

  // A reload stays on the unlock form; the right password opens the settings again.
  await page.reload();
  await expect(ui.unlock).toBeVisible();
  await expect(page.getByText('example.test')).toHaveCount(0);
  await ui.password.fill(PW);
  await ui.password.press('Enter');
  await expect(ui.list.getByText('example.test', { exact: true })).toBeVisible();
});

test('a wrong password on the unlock form shows the error, five show a countdown', async ({
  context,
  sw,
  extensionId,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await createPassword(ui);
  await ui.lockNow.click();
  await ui.password.fill('nope nope');
  await ui.unlock.click();
  await expect(ui.unlockError).toHaveText(await ui.text('wrongPassword'));
  for (let i = 0; i < 4; i++) {
    await ui.password.fill(`nope ${i}`);
    await ui.password.press('Enter');
    await expect(ui.unlockError).not.toBeEmpty();
  }
  const template = (await ui.text('tooManyAttempts', 'M:SS')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await expect(ui.unlockError).toHaveText(new RegExp(`^${template.replace('M:SS', '0:(30|29|28)')}$`));
  await expect(ui.unlock).toBeDisabled();
});

test('#permission-lost explains the lost access for a listed site and offers to grant it', async ({
  context,
  sw,
  extensionId,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await createPassword(ui);
  // noperm.test is listed but the e2e build has no host permission for it.
  await sw.evaluate(() =>
    (globalThis as unknown as { __fmp: Api }).__fmp.saveSettings({ domains: ['noperm.test'] }),
  );
  await page.goto(`chrome-extension://${extensionId}/options.html#permission-lost`);
  await page.reload();
  await expect(await ui.heading('permissionLostTitle')).toBeVisible();
  await expect(page.getByText(await ui.text('permissionLostBody'))).toBeVisible();
  await expect(page.getByRole('button', { name: await ui.text('grantButton') })).toBeVisible();
});

test('the banner is absent when every listed site has access', async ({ context, sw, extensionId }) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId, '#permission-lost');
  await createPassword(ui);
  await ui.domainField.fill('example.test');
  await ui.add.click();
  await expect(ui.list.locator('li')).toHaveCount(1);
  await expect(await ui.heading('permissionLostTitle')).toBeHidden();
});
