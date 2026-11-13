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
  const keys = [
    'passwordLabel',
    'confirmPasswordLabel',
    'createButton',
    'unlockButton',
    'addButton',
    'removeButton',
    'lockNowButton',
    'currentPasswordLabel',
    'newPasswordLabel',
    'saveButton',
    'onboardingStart',
    'backButton',
    'nextButton',
    'skipButton',
    'finishButton',
  ] as const;
  const entries = await Promise.all(keys.map(async (key) => [key, await text(key)] as const));
  const label = Object.fromEntries(entries) as Record<(typeof keys)[number], string>;
  return {
    text,
    // The same label sits on the setup and the unlock form; only the visible one counts.
    password: page.getByLabel(label.passwordLabel, { exact: true }).filter({ visible: true }),
    confirm: page.getByLabel(label.confirmPasswordLabel, { exact: true }).filter({ visible: true }),
    create: page.getByRole('button', { name: label.createButton }),
    unlock: page.getByRole('button', { name: label.unlockButton }),
    add: page.getByRole('button', { name: label.addButton, exact: true }),
    remove: page.getByRole('button', { name: label.removeButton }),
    lockNow: page.getByRole('button', { name: label.lockNowButton }),
    idle: page.locator('#idle'),
    start: page.getByRole('button', { name: label.onboardingStart, exact: true }),
    back: page.getByRole('button', { name: label.backButton, exact: true }),
    nextStep: page.getByRole('button', { name: label.nextButton, exact: true }),
    skip: page.getByRole('button', { name: label.skipButton, exact: true }),
    finish: page.getByRole('button', { name: label.finishButton, exact: true }),
    progress: page.locator('#ob-progress'),
    siteField: page.locator('#ob-domain'),
    siteError: page.locator('#ob-site-error'),
    tip: page.locator('#tip'),
    menuLink: (key: string) => text(key).then((name) => page.getByRole('navigation').getByRole('link', { name })),
    current: page.getByLabel(label.currentPasswordLabel, { exact: true }),
    next: page.getByLabel(label.newPasswordLabel, { exact: true }),
    changeConfirm: page.locator('#change-confirm'),
    save: page.getByRole('button', { name: label.saveButton, exact: true }),
    domainField: page.locator('#domain'),
    domainError: page.locator('#domain-error'),
    list: page.locator('#domains'),
    setupError: page.locator('#setup-error'),
    unlockError: page.locator('#unlock-error'),
    changeError: page.locator('#change-error'),
    toast: page.locator('#toast'),
    toastBox: page.locator('#toast'),
    heading: (key: string) => text(key).then((name) => page.getByRole('heading', { name })),
  };
}

async function openOptions(page: Page, sw: Worker, extensionId: string, hash = '') {
  await page.goto(`chrome-extension://${extensionId}/options.html${hash}`);
  return optionsUi(page, sw);
}

type Ui = Awaited<ReturnType<typeof optionsUi>>;

/** Steps 1 and 2: the welcome step, then the password. Leaves the page on step 3. */
async function createPassword(ui: Ui) {
  await ui.start.click();
  await ui.password.fill(PW);
  await ui.confirm.fill(PW);
  await ui.create.click();
  await expect(ui.progress).toHaveText('3/4');
}

/** The whole first run with no site chosen: lands on the settings view. */
async function completeOnboarding(ui: Ui, site?: string) {
  await createPassword(ui);
  if (site) {
    await ui.siteField.fill(site);
    await ui.siteField.press('Enter');
    await ui.nextStep.click();
  } else {
    await ui.skip.click();
  }
  await expect(ui.progress).toHaveText('4/4');
  await ui.finish.click();
  await expect(ui.lockNow).toBeVisible();
}

test('first run opens the welcome step with progress 1/4, focus on its heading and a Learn more link', async ({
  context,
  sw,
  extensionId,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await expect(await ui.heading('onboardingWelcomeTitle')).toBeFocused();
  await expect(ui.progress).toHaveText('1/4');
  await expect(ui.back).toBeHidden();
  const learn = page.getByRole('link', { name: await ui.text('onboardingLearnMore') });
  await expect(learn).toHaveAttribute(
    'href',
    'https://github.com/xcryptp/for-my-privacy#what-it-protects-and-what-it-does-not',
  );
});

test('onboarding happy path: four steps end on the settings, and the chosen site is locked in a new tab', async ({
  context,
  sw,
  extensionId,
  origin,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await ui.start.click();
  await expect(await ui.heading('setupTitle')).toBeFocused();
  await expect(ui.progress).toHaveText('2/4');
  await ui.password.fill(PW);
  await ui.confirm.fill(PW);
  await ui.create.click();

  // Step 3: preset chips are toggles; a custom site becomes a selected chip.
  await expect(await ui.heading('onboardingSitesTitle')).toBeFocused();
  const preset = page.getByRole('button', { name: 'instagram.com', exact: true });
  await expect(preset).toHaveAttribute('aria-pressed', 'false');
  await preset.click();
  await expect(preset).toHaveAttribute('aria-pressed', 'true');
  await preset.click();
  await expect(preset).toHaveAttribute('aria-pressed', 'false');
  await ui.siteField.fill('Example.TEST');
  await expect(page.locator('#ob-preview')).toHaveText(await ui.text('willLock', 'example.test'));
  await ui.siteField.press('Enter');
  await expect(page.getByRole('button', { name: 'example.test', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await ui.nextStep.click();

  // Step 4: auto-lock.
  await expect(await ui.heading('idleTitle')).toBeFocused();
  await expect(ui.progress).toHaveText('4/4');
  await expect(page.locator('#ob-idle')).toHaveValue('5');
  await page.locator('#ob-idle').fill('7');
  await ui.finish.click();

  // Settings view with the tip; the site is listed and the idle value kept.
  await expect(ui.lockNow).toBeVisible();
  await expect(ui.tip).toHaveText(await ui.text('onboardingDoneTip'));
  await expect(ui.list.getByText('example.test', { exact: true })).toBeVisible();
  await (await ui.menuLink('menuAutolock')).click();
  await expect(ui.idle).toHaveValue('7');

  // The settings being open does not unlock the site.
  const site = await context.newPage();
  await site.goto(origin('www.example.test')).catch(() => {});
  await expect.poll(() => site.url()).toContain(`chrome-extension://${extensionId}/lock.html#u=`);
});

test('Back works from step 2 and step 3; step 2 shows the password as done afterwards', async ({
  context,
  sw,
  extensionId,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await ui.start.click();
  await expect(ui.progress).toHaveText('2/4');
  await ui.back.click();
  await expect(ui.progress).toHaveText('1/4');
  await expect(await ui.heading('onboardingWelcomeTitle')).toBeFocused();

  await createPassword(ui);
  await ui.back.click();
  await expect(ui.progress).toHaveText('2/4');
  await expect(page.getByText(await ui.text('onboardingPasswordDone'))).toBeVisible();
  await expect(ui.create).toBeHidden();
  await ui.nextStep.click();
  await expect(ui.progress).toHaveText('3/4');
  await ui.skip.click();
  await expect(ui.progress).toHaveText('4/4');
  await ui.back.click();
  await expect(ui.progress).toHaveText('3/4');
});

test('a reload during onboarding resumes at the same step; Finish ends the resume', async ({
  context,
  sw,
  extensionId,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await createPassword(ui);
  await page.reload();
  await expect(ui.progress).toHaveText('3/4');
  await expect(await ui.heading('onboardingSitesTitle')).toBeVisible();

  await ui.siteField.fill('example.test');
  await ui.siteField.press('Enter');
  await ui.nextStep.click();
  await expect(ui.progress).toHaveText('4/4');
  await page.reload();
  await expect(ui.progress).toHaveText('4/4');
  await ui.back.click();
  await expect(page.getByRole('button', { name: 'example.test', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await ui.nextStep.click();
  await ui.finish.click();
  await expect(ui.lockNow).toBeVisible();

  await page.reload();
  await expect(ui.lockNow).toBeVisible();
  await expect(ui.progress).toBeHidden();
  await expect(ui.list.getByText('example.test', { exact: true })).toBeVisible();
});

test('a password shorter than 8 characters is refused on step 2 and stays there', async ({
  context,
  sw,
  extensionId,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await ui.start.click();
  await ui.password.fill('1234567');
  await ui.confirm.fill('1234567');
  await ui.create.click();
  await expect(ui.setupError).toHaveText(await ui.text('passwordTooShort'));
  await expect(ui.progress).toHaveText('2/4');
});

test('two different passwords are refused on step 2', async ({ context, sw, extensionId }) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await ui.start.click();
  await ui.password.fill(PW);
  await ui.confirm.fill(PW + 'x');
  await ui.create.click();
  await expect(ui.setupError).toHaveText(await ui.text('passwordMismatch'));
  await expect(ui.progress).toHaveText('2/4');
});

test('Skip on step 3 chooses no site and the settings list is empty', async ({ context, sw, extensionId }) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await createPassword(ui);
  await expect(ui.skip).toBeVisible();
  await ui.skip.click();
  await expect(ui.progress).toHaveText('4/4');
  await ui.finish.click();
  await expect(await ui.heading('domainsTitle')).toBeVisible();
  await expect(page.getByText(await ui.text('emptyDomains'))).toBeVisible();
});

test('an invalid custom site on step 3 shows the message and is not added', async ({ context, sw, extensionId }) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await createPassword(ui);
  await ui.siteField.fill('not a domain');
  await expect(page.locator('#ob-preview')).toHaveText(await ui.text('invalidDomain'));
  await ui.siteField.press('Enter');
  await expect(ui.siteError).toHaveText(await ui.text('invalidDomain'));
  await expect(ui.skip).toBeVisible();
});

test('the settings unlock keeps the sites locked: unlock, add a site, a new tab still shows the lock page', async ({
  context,
  sw,
  extensionId,
  origin,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await completeOnboarding(ui);
  await ui.lockNow.click();
  await expect(ui.unlock).toBeVisible();
  await ui.password.fill(PW);
  await ui.unlock.click();
  await expect(ui.lockNow).toBeVisible();

  await ui.domainField.fill('example.test');
  await ui.add.click();
  await expect(ui.list.getByText('example.test', { exact: true })).toBeVisible();

  const site = await context.newPage();
  await site.goto(origin('example.test')).catch(() => {});
  await expect.poll(() => site.url()).toContain(`chrome-extension://${extensionId}/lock.html#u=`);
});

test('unlocking the sites on the lock page does not open the settings', async ({
  context,
  sw,
  extensionId,
  origin,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await completeOnboarding(ui, 'example.test');
  await ui.lockNow.click();
  await expect(ui.unlock).toBeVisible();

  const site = await context.newPage();
  await site.goto(origin('example.test')).catch(() => {});
  await expect.poll(() => site.url()).toContain('lock.html#u=');
  await site.locator('#password').fill(PW);
  await site.locator('#submit').click();
  await expect.poll(() => site.url()).toContain('example.test');

  const again = await context.newPage();
  const ui2 = await openOptions(again, sw, extensionId);
  await expect(ui2.unlock).toBeVisible();
  await expect(await ui2.heading('domainsTitle')).toBeHidden();
  await expect(ui2.lockNow).toBeHidden();
});

test('adding a site lists it with its wildcard forms and, after Lock now, its subdomains are locked', async ({
  context,
  sw,
  extensionId,
  origin,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await completeOnboarding(ui);
  await ui.domainField.fill('Example.TEST');
  await expect(page.locator('#domain-preview')).toHaveText(await ui.text('willLock', 'example.test'));
  await ui.add.click();
  await expect(ui.list.getByText('example.test', { exact: true })).toBeVisible();
  await expect(ui.list.getByText('*.example.test · *.*.example.test', { exact: true })).toBeVisible();
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
  await completeOnboarding(ui);
  await ui.domainField.fill('not a domain');
  await expect(page.locator('#domain-preview')).toHaveText(await ui.text('invalidDomain'));
  await ui.add.click();
  await expect(ui.domainError).toHaveText(await ui.text('invalidDomain'));
  await expect(ui.list.locator('li')).toHaveCount(0);
});

test('Enter in the site field adds it, and Remove takes it out again', async ({ context, sw, extensionId }) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await completeOnboarding(ui);
  await ui.domainField.fill('https://www.example.test/some/path');
  await ui.domainField.press('Enter');
  await expect(ui.list.locator('li')).toHaveCount(1);
  await expect(ui.list.getByText('example.test', { exact: true })).toBeVisible();
  await ui.remove.click();
  await expect(ui.list.locator('li')).toHaveCount(0);
  await expect(page.getByText(await ui.text('emptyDomains'))).toBeVisible();
});

test('a pasted URL with a subdomain is stored as its registrable domain and locks every depth', async ({
  context,
  sw,
  extensionId,
  origin,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await completeOnboarding(ui);
  await ui.domainField.fill('https://m.example.test/path?x=1');
  await ui.domainField.press('Enter');
  await expect(ui.list.getByText('example.test', { exact: true })).toBeVisible();
  await expect(ui.list.locator('li')).toHaveCount(1);
  await ui.lockNow.click();
  await expect(ui.unlock).toBeVisible();

  const site = await context.newPage();
  await site.goto(origin('a.b.example.test')).catch(() => {});
  await expect.poll(() => site.url()).toContain(`chrome-extension://${extensionId}/lock.html#u=`);
});

test('the menu opens one section at a time, by click and by hash, and moves focus to its heading', async ({
  context,
  sw,
  extensionId,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await completeOnboarding(ui);

  const sites = await ui.menuLink('menuSites');
  await expect(sites).toHaveAttribute('aria-current', 'page');
  await expect(await ui.heading('domainsTitle')).toBeVisible();
  await expect(await ui.heading('idleTitle')).toBeHidden();

  await (await ui.menuLink('menuAutolock')).click();
  await expect(page).toHaveURL(/#autolock$/);
  await expect(await ui.heading('idleTitle')).toBeFocused();
  await expect(await ui.menuLink('menuAutolock')).toHaveAttribute('aria-current', 'page');
  await expect(sites).not.toHaveAttribute('aria-current', 'page');
  await expect(await ui.heading('domainsTitle')).toBeHidden();

  await (await ui.menuLink('menuSecurity')).click();
  await expect(await ui.heading('changePasswordTitle')).toBeFocused();

  await page.goto(`chrome-extension://${extensionId}/options.html#about`);
  await expect(page.locator('#about-version')).toHaveText(await ui.text('aboutVersion', '0.1.0'));
  await expect(await ui.menuLink('menuAbout')).toHaveAttribute('aria-current', 'page');

  await page.evaluate(() => (location.hash = '#autolock'));
  await expect(await ui.heading('idleTitle')).toBeVisible();
});

test('the menu is a sidebar on a wide screen and a tab bar on a narrow one', async ({ context, sw, extensionId }) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await completeOnboarding(ui);
  const menu = page.locator('#menu');
  await page.setViewportSize({ width: 1280, height: 800 });
  const wide = await menu.evaluate((el) => getComputedStyle(el).flexDirection);
  expect(wide).toBe('column');
  await page.setViewportSize({ width: 375, height: 700 });
  const narrow = await menu.evaluate((el) => getComputedStyle(el).flexDirection);
  expect(narrow).toBe('row');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('idle minutes 0 is saved as 1', async ({ context, sw, extensionId }) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await completeOnboarding(ui);
  await (await ui.menuLink('menuAutolock')).click();
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
  await completeOnboarding(ui);
  const screen = page.getByRole('switch', { name: await ui.text('screenLockLabel') });
  const guard = page.getByRole('switch', { name: await ui.text('guardLabel') });
  await (await ui.menuLink('menuAutolock')).click();
  await expect(screen).toBeChecked();
  await screen.click();
  await (await ui.menuLink('menuSecurity')).click();
  await expect(guard).toBeChecked();
  await guard.click();
  await page.reload();
  await expect(guard).not.toBeChecked();
  await (await ui.menuLink('menuAutolock')).click();
  await expect(screen).not.toBeChecked();
});

test('changing the password works: the new one unlocks, the old one does not', async ({
  context,
  sw,
  extensionId,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await completeOnboarding(ui);
  await (await ui.menuLink('menuSecurity')).click();

  // A wrong current password is reported and nothing changes.
  await ui.current.fill('not the password');
  await ui.next.fill('another secret');
  await ui.changeConfirm.fill('another secret');
  await ui.save.click();
  await expect(ui.changeError).toHaveText(await ui.text('wrongPassword'));

  await ui.current.fill(PW);
  await ui.next.fill('another secret');
  await ui.changeConfirm.fill('another secret');
  await ui.save.click();
  await expect(ui.toast).toHaveText(await ui.text('saved'));
  await expect(ui.current).toHaveValue('');
  await expect(ui.changeConfirm).toHaveValue('');

  await ui.lockNow.click();
  await expect(ui.unlock).toBeVisible();
  await ui.password.fill(PW);
  await ui.unlock.click();
  await expect(ui.unlockError).toHaveText(await ui.text('wrongPassword'));
  await ui.password.fill('another secret');
  await ui.unlock.click();
  await expect(ui.lockNow).toBeVisible();
});

test('a mismatched confirmation is refused and the old password still unlocks', async ({
  context,
  sw,
  extensionId,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await completeOnboarding(ui);
  await (await ui.menuLink('menuSecurity')).click();
  await ui.current.fill(PW);
  await ui.next.fill('another secret');
  await ui.changeConfirm.fill('another sekret');
  await ui.save.click();
  await expect(ui.changeError).toHaveText(await ui.text('passwordMismatch'));
  await expect(ui.toastBox).toHaveText('');

  await ui.lockNow.click();
  await expect(ui.unlock).toBeVisible();
  await ui.password.fill(PW);
  await ui.password.press('Enter');
  await expect(ui.lockNow).toBeVisible();
});

test('a slow settings render that finishes after Lock now writes nothing into the hidden settings', async ({
  context,
  sw,
  extensionId,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await completeOnboarding(ui, 'example.test');
  await expect(ui.list.locator('li')).toHaveCount(1);

  // Make the next read of the settings slow, so its render is still pending when the page locks.
  await page.evaluate(() => {
    const local = (globalThis as unknown as { chrome: typeof import('wxt/browser').browser }).chrome.storage.local;
    const original = local.get.bind(local) as (keys: unknown) => Promise<unknown>;
    local.get = (async (keys: unknown) => {
      const result = await original(keys);
      if (keys === 'settings') await new Promise((resolve) => setTimeout(resolve, 1500));
      return result;
    }) as typeof local.get;
  });
  // Another options tab changing the settings starts a refresh here.
  await sw.evaluate(() =>
    (globalThis as unknown as { __fmp: Api }).__fmp.saveSettings({ domains: ['example.test', 'other.test'] }),
  );
  await ui.lockNow.click();
  await expect(ui.unlock).toBeVisible();
  await page.waitForTimeout(2500);
  await expect(ui.list.locator('li')).toHaveCount(0);
  await expect(ui.unlock).toBeVisible();
  await expect(ui.lockNow).toBeHidden();
});

test('Lock now locks again and the locked page shows no site names', async ({ context, sw, extensionId }) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await completeOnboarding(ui, 'example.test');
  await expect(ui.list.locator('li')).toHaveCount(1);

  await ui.lockNow.click();
  await expect(await ui.heading('settingsLockedTitle')).toBeVisible();
  await expect(ui.unlock).toBeVisible();
  await expect(page.getByText('example.test')).toHaveCount(0);
  await expect(ui.lockNow).toBeHidden();
  await expect(await ui.heading('domainsTitle')).toBeHidden();
  await expect(page.getByRole('navigation')).toBeHidden();

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
  await completeOnboarding(ui);
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

test('#permission-lost opens Sites with the notice for a listed site and offers to grant it', async ({
  context,
  sw,
  extensionId,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await completeOnboarding(ui);
  // noperm.test is listed but the e2e build has no host permission for it.
  await sw.evaluate(() =>
    (globalThis as unknown as { __fmp: Api }).__fmp.saveSettings({ domains: ['noperm.test'] }),
  );
  await page.goto(`chrome-extension://${extensionId}/options.html#permission-lost`);
  await page.reload();
  await expect(await ui.menuLink('menuSites')).toHaveAttribute('aria-current', 'page');
  await expect(await ui.heading('permissionLostTitle')).toBeVisible();
  await expect(page.getByText(await ui.text('permissionLostBody'))).toBeVisible();
  await expect(page.getByRole('button', { name: await ui.text('grantButton') })).toBeVisible();
});

test('the banner is absent when every listed site has access', async ({ context, sw, extensionId }) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId, '#permission-lost');
  await completeOnboarding(ui, 'example.test');
  await expect(ui.list.locator('li')).toHaveCount(1);
  await expect(await ui.heading('permissionLostTitle')).toBeHidden();
});
