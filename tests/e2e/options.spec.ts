import type { Page, Worker } from '@playwright/test';
import { test, expect, stays, visit } from './fixtures';

type Api = {
  handleMessage: (req: unknown, sender: unknown) => Promise<unknown>;
  saveSettings: (patch: unknown) => Promise<unknown>;
  getSettings: () => Promise<{ unlockScope: string }>;
};

const PW = 'correct horse';

// The browser UI language decides which locale chrome.i18n serves, and it differs between
// machines, so every expected text is looked up from the extension's own messages.
declare const chrome: typeof import('wxt/browser').browser;
const msg = (sw: Worker, key: string, subs?: string | string[]) =>
  sw.evaluate(([k, s]) => chrome.i18n.getMessage(k as never, s), [key, subs] as const) as Promise<string>;

/** The Finish tip with the Lock now shortcut Chrome has (or the text for none). */
async function doneTip(sw: Worker): Promise<string> {
  const keys = await sw.evaluate(
    async () => (await chrome.commands.getAll()).find((c) => c.name === 'lock-now')?.shortcut || '',
  );
  return keys ? msg(sw, 'onboardingDoneTip', keys) : msg(sw, 'onboardingDoneTipNoShortcut');
}

/** Controls and expected texts of the options page, in the browser's language. */
async function optionsUi(page: Page, sw: Worker) {
  const text = (key: string, subs?: string | string[]) => msg(sw, key, subs);
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

/** The README section for the browser's language: README.ko.md and README.ja.md have their own anchors. */
const limitsHref = (sw: Worker) =>
  sw.evaluate(() => {
    const lang = chrome.i18n.getUILanguage().toLowerCase().split(/[-_]/)[0];
    const repo = 'https://github.com/xcryptp/for-my-privacy';
    if (lang === 'ko') return `${repo}/blob/main/README.ko.md#${encodeURI('무엇을-막고-무엇은-막지-못하나')}`;
    if (lang === 'ja') return `${repo}/blob/main/README.ja.md#${encodeURI('何を守り何を守れないか')}`;
    return `${repo}#what-it-protects-and-what-it-does-not`;
  });

async function openOptions(page: Page, sw: Worker, extensionId: string, hash = '') {
  await page.goto(`chrome-extension://${extensionId}/options.html${hash}`);
  return optionsUi(page, sw);
}

type Ui = Awaited<ReturnType<typeof optionsUi>>;

/** The "too many attempts" message with a wait of any of the given seconds (a second or two may pass). */
async function waitingText(ui: Ui, seconds: number[]): Promise<RegExp> {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const options = await Promise.all(
    seconds.map(async (n) => escape(await ui.text('tooManyAttempts', await ui.text('waitSeconds', String(n))))),
  );
  return new RegExp(`^(${options.join('|')})$`);
}

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
  await expect(learn).toHaveAttribute('href', await limitsHref(sw));
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
  await expect(ui.tip).toHaveText(await doneTip(sw));
  await expect(ui.list.getByText('example.test', { exact: true })).toBeVisible();
  await (await ui.menuLink('menuAutolock')).click();
  await expect(ui.idle).toHaveValue('7');

  // The settings being open does not unlock the site.
  const site = await context.newPage();
  await visit(site, origin('www.example.test'));
  await expect.poll(() => site.url()).toMatch(new RegExp(`^chrome-extension://${extensionId}/lock\\.html#[ut]=`));
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
  // The text is still in the field, so the button reads Next, not Skip.
  await expect(ui.nextStep).toBeVisible();
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
  await visit(site, origin('example.test'));
  await expect.poll(() => site.url()).toMatch(new RegExp(`^chrome-extension://${extensionId}/lock\\.html#[ut]=`));
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
  await visit(site, origin('example.test'));
  await expect.poll(() => site.url()).toMatch(/lock\.html#[ut]=/);
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
  await expect(ui.list.getByText(await ui.text('domainAlsoLocks', 'example.test'), { exact: true })).toBeVisible();
  await expect(ui.list.getByText('*.example.test', { exact: true })).toBeVisible();
  await expect(ui.toast).toHaveText(await ui.text('saved'));
  await expect(ui.domainField).toHaveValue('');

  await ui.lockNow.click();
  await expect(ui.unlock).toBeVisible();

  const site = await context.newPage();
  await visit(site, origin('www.example.test'));
  await expect.poll(() => site.url()).toMatch(new RegExp(`^chrome-extension://${extensionId}/lock\\.html#[ut]=`));
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
  await visit(site, origin('a.b.example.test'));
  await expect.poll(() => site.url()).toMatch(new RegExp(`^chrome-extension://${extensionId}/lock\\.html#[ut]=`));
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
  await expect(ui.toast).toHaveText(await ui.text('idleClamped', '1'));
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
  await expect(ui.changeError).toHaveText(await ui.text('wrongPasswordTries', '4'));

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
  await expect(ui.unlockError).toHaveText(await ui.text('wrongPasswordTries', '4'));
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
    const counts = { slow: 0, done: 0 };
    (globalThis as unknown as { __slowReads: typeof counts }).__slowReads = counts;
    local.get = (async (keys: unknown) => {
      const result = await original(keys);
      if (keys === 'settings') {
        counts.slow++;
        await new Promise((resolve) => setTimeout(resolve, 1500));
        counts.done++;
      }
      return result;
    }) as typeof local.get;
  });
  const slowReads = () =>
    page.evaluate(() => (globalThis as unknown as { __slowReads: { slow: number; done: number } }).__slowReads);
  // Another options tab changing the settings starts a refresh here.
  await sw.evaluate(() =>
    (globalThis as unknown as { __fmp: Api }).__fmp.saveSettings({ domains: ['example.test', 'other.test'] }),
  );
  await ui.lockNow.click();
  await expect(ui.unlock).toBeVisible();
  // Every slow read that started has finished (and its render had its chance to write).
  await expect.poll(async () => {
    const { slow, done } = await slowReads();
    return slow > 0 && slow === done;
  }, { timeout: 5_000 }).toBe(true);
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
  await expect(ui.unlockError).toHaveText(await ui.text('wrongPasswordTries', '4'));
  for (let i = 0; i < 4; i++) {
    await ui.password.fill(`nope ${i}`);
    await ui.password.press('Enter');
    await expect(ui.unlockError).not.toBeEmpty();
  }
  await expect(ui.unlockError).toHaveText(await waitingText(ui, [30, 29, 28]));
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

test('Skip then Finish says no site is locked yet instead of claiming it', async ({ context, sw, extensionId }) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await completeOnboarding(ui);
  await expect(ui.tip).toHaveText(await ui.text('onboardingDoneTipEmpty'));
  await expect(page.getByText(await ui.text('onboardingDoneTip'), { exact: true })).toHaveCount(0);
});

test('a site typed but not added is added when Next is pressed, and the button never reads Skip meanwhile', async ({
  context,
  sw,
  extensionId,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await createPassword(ui);
  await expect(ui.skip).toBeVisible();
  await ui.siteField.fill('example.test');
  await expect(ui.nextStep).toBeVisible();
  await ui.nextStep.click();
  await expect(ui.progress).toHaveText('4/4');
  await ui.finish.click();
  await expect(ui.list.getByText('example.test', { exact: true })).toBeVisible();
  await expect(ui.tip).toHaveText(await doneTip(sw));
});

test('a typed text that is not a site keeps the person on step 3 with the message', async ({ context, sw, extensionId }) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await createPassword(ui);
  await ui.siteField.fill('not a domain');
  await ui.nextStep.click();
  await expect(ui.siteError).toHaveText(await ui.text('invalidDomain'));
  await expect(ui.progress).toHaveText('3/4');
  await expect(ui.siteField).toBeFocused();
});

test('the no-recovery warning is a visible warning box that says the site list is erased too', async ({
  context,
  sw,
  extensionId,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await ui.start.click();
  const box = page.locator('#setup-warning');
  await expect(box).toBeVisible();
  await expect(box).toContainText(await ui.text('setupWarningTitle'));
  await expect(box).toContainText(await ui.text('setupWarningBody'));
  const style = await box.evaluate((el) => {
    const s = getComputedStyle(el);
    return { border: s.borderTopWidth, bg: s.backgroundColor };
  });
  expect(style.border).not.toBe('0px');
  expect(style.bg).not.toBe('rgba(0, 0, 0, 0)');
});

test('each step heading announces "Step N of 4" as its description', async ({ context, sw, extensionId }) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await expect(await ui.heading('onboardingWelcomeTitle')).toHaveAccessibleDescription(
    await ui.text('onboardingProgress', ['1', '4']),
  );
  await ui.start.click();
  await expect(await ui.heading('setupTitle')).toHaveAccessibleDescription(await ui.text('onboardingProgress', ['2', '4']));
  await ui.password.fill(PW);
  await ui.confirm.fill(PW);
  await ui.create.click();
  await expect(await ui.heading('onboardingSitesTitle')).toHaveAccessibleDescription(
    await ui.text('onboardingProgress', ['3', '4']),
  );
});

test('a resumed onboarding offers to skip the setup and go to the settings; a fresh one does not', async ({
  context,
  sw,
  extensionId,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  const skipSetup = page.getByRole('button', { name: await ui.text('onboardingSkipSetup') });
  await createPassword(ui);
  await expect(skipSetup).toBeHidden();
  await page.reload();
  await expect(ui.progress).toHaveText('3/4');
  await expect(skipSetup).toBeVisible();
  await skipSetup.click();
  await expect(ui.lockNow).toBeVisible();
  await expect(ui.tip).toHaveText(await ui.text('onboardingDoneTipEmpty'));
  await page.reload();
  await expect(ui.lockNow).toBeVisible();
  await expect(ui.progress).toBeHidden();
});

test('a relock mid-onboarding leaves no site name in the page, hidden or not', async ({ context, sw, extensionId }) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await createPassword(ui);
  await ui.siteField.fill('secretsite.test');
  await expect(page.locator('#ob-preview')).toContainText('secretsite.test');
  // The worker locks (idle, Lock now elsewhere); the page notices on its next state check.
  await sw.evaluate(() =>
    (globalThis as unknown as { __fmp: Api }).__fmp.handleMessage({ type: 'lockNow' }, {}),
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(ui.unlock).toBeVisible();
  const leaked = await page.evaluate(() => ({
    text: document.documentElement.textContent ?? '',
    fields: [...document.querySelectorAll('input')].map((el) => el.value),
    preview: document.getElementById('ob-preview')?.textContent ?? '',
  }));
  expect(leaked.text).not.toContain('secretsite');
  expect(leaked.fields.join('|')).not.toContain('secretsite');
  expect(leaked.preview).toBe('');
});

test('the settings unlock says it opens the settings only and that locked sites stay locked', async ({
  context,
  sw,
  extensionId,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await completeOnboarding(ui);
  await ui.lockNow.click();
  await expect(ui.unlock).toBeVisible();
  await expect(page.getByText(await ui.text('settingsUnlockHint'), { exact: true })).toBeVisible();
});

test('an already open locked settings tab shows the lock-out wait without a submit', async ({
  context,
  sw,
  extensionId,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await completeOnboarding(ui);
  await ui.lockNow.click();
  await expect(ui.unlock).toBeVisible();
  await expect(ui.unlock).toBeEnabled();
  // Five wrong answers somewhere else (a lock page).
  await sw.evaluate(async () => {
    const worker = (globalThis as unknown as { __fmp: Api }).__fmp;
    for (let i = 0; i < 5; i++) await worker.handleMessage({ type: 'unlock', password: `wrong ${i}` }, {});
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(ui.unlockError).toHaveText(await waitingText(ui, [30, 29, 28, 27]));
  await expect(ui.unlock).toBeDisabled();
});

test('#permission-lost on locked settings shows the notice above the form, with no site name', async ({
  context,
  sw,
  extensionId,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await completeOnboarding(ui, 'example.test');
  await ui.lockNow.click();
  await expect(ui.unlock).toBeVisible();
  await page.goto(`chrome-extension://${extensionId}/options.html#permission-lost`);
  const notice = page.locator('#locked-notice');
  await expect(notice).toBeVisible();
  await expect(await ui.heading('permissionLostTitle')).toBeVisible();
  await expect(page.getByText('example.test')).toHaveCount(0);
  const above = await page.evaluate(
    () => document.getElementById('locked-notice')!.getBoundingClientRect().bottom <= document.getElementById('unlock-form')!.getBoundingClientRect().top,
  );
  expect(above).toBe(true);
  // Without the hash there is no notice.
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(ui.unlock).toBeVisible();
  await expect(notice).toBeHidden();
});

test('the permission notice takes the focus when #permission-lost opens Sites', async ({ context, sw, extensionId }) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await completeOnboarding(ui);
  await sw.evaluate(() =>
    (globalThis as unknown as { __fmp: Api }).__fmp.saveSettings({ domains: ['noperm.test'] }),
  );
  await page.goto(`chrome-extension://${extensionId}/options.html#permission-lost`);
  await page.reload();
  await expect(page.locator('#permission-lost')).toBeFocused();
});

test('after Remove the focus goes to the next row, then the field when the list is empty', async ({
  context,
  sw,
  extensionId,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await completeOnboarding(ui);
  // The e2e build has no host access for other.test, so the list is filled through the worker.
  await sw.evaluate(() =>
    (globalThis as unknown as { __fmp: Api }).__fmp.saveSettings({ domains: ['example.test', 'other.test'] }),
  );
  await expect(ui.list.locator('li')).toHaveCount(2);
  const removeFirst = page.getByRole('button', { name: `${await ui.text('removeButton')}: example.test` });
  await removeFirst.click();
  await expect(ui.list.locator('li')).toHaveCount(1);
  await expect(page.getByRole('button', { name: `${await ui.text('removeButton')}: other.test` })).toBeFocused();
  // The redraw after the storage change keeps the focus there.
  const removeOther = page.getByRole('button', { name: `${await ui.text('removeButton')}: other.test` });
  await stays(() => removeOther.evaluate((el) => el === document.activeElement).catch(() => false), true, 500);
  await page.getByRole('button', { name: `${await ui.text('removeButton')}: other.test` }).click();
  await expect(ui.list.locator('li')).toHaveCount(0);
  await expect(ui.domainField).toBeFocused();
});

test('locking clears the "Saved." toast, and so does moving to another section', async ({ context, sw, extensionId }) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await completeOnboarding(ui);
  await (await ui.menuLink('menuAutolock')).click();
  await ui.idle.fill('9');
  await ui.idle.press('Enter');
  await expect(ui.toast).toHaveText(await ui.text('saved'));
  await (await ui.menuLink('menuSecurity')).click();
  await expect(ui.toast).toHaveText('');
  await (await ui.menuLink('menuAutolock')).click();
  await ui.idle.fill('8');
  await ui.idle.press('Enter');
  await expect(ui.toast).toHaveText(await ui.text('saved'));
  await ui.lockNow.click();
  await expect(ui.unlock).toBeVisible();
  await expect(ui.toast).toHaveText('');
});

test('a clamped auto-lock value is said out loud', async ({ context, sw, extensionId }) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await completeOnboarding(ui);
  await (await ui.menuLink('menuAutolock')).click();
  await ui.idle.fill('90');
  await ui.idle.press('Enter');
  await expect(ui.idle).toHaveValue('60');
  await expect(ui.toast).toHaveText(await ui.text('idleClamped', '60'));
  await ui.idle.fill('0');
  await ui.idle.press('Enter');
  await expect(ui.toast).toHaveText(await ui.text('idleClamped', '1'));
  await ui.idle.fill('30');
  await ui.idle.press('Enter');
  await expect(ui.toast).toHaveText(await ui.text('saved'));
});

test('a pasted address deeper than the registrable domain says it locks the whole site', async ({
  context,
  sw,
  extensionId,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await completeOnboarding(ui);
  await ui.domainField.fill('https://m.blog.example.test/someone/123');
  await expect(page.locator('#domain-preview')).toHaveText(
    await ui.text('willLockBroader', ['example.test', 'm.blog.example.test']),
  );
  await ui.domainField.fill('https://www.example.test/');
  await expect(page.locator('#domain-preview')).toHaveText(await ui.text('willLock', 'example.test'));
});

test('an e-mail address and local network names are not sites', async ({ context, sw, extensionId }) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await completeOnboarding(ui);
  for (const bad of ['me@example.test', 'printer.local', 'nas.internal', 'router.home.arpa', 'localhost']) {
    await ui.domainField.fill(bad);
    await expect(page.locator('#domain-preview'), bad).toHaveText(await ui.text('invalidDomain'));
  }
  await ui.domainField.fill('printer.local');
  await ui.add.click();
  await expect(ui.domainError).toHaveText(await ui.text('invalidDomain'));
  await expect(ui.list.locator('li')).toHaveCount(0);
});

test('the guard hint links to the README section and the About links follow the page language', async ({
  context,
  sw,
  extensionId,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await completeOnboarding(ui);
  const href = await limitsHref(sw);
  await expect(page.locator('#link-limits')).toHaveAttribute('href', href);
  await (await ui.menuLink('menuSecurity')).click();
  const more = page.getByRole('link', { name: await ui.text('guardHintLink') });
  await expect(more).toHaveAttribute('href', href);
});

test('the unlock choice is a radio group in Security, saved and kept', async ({ context, sw, extensionId }) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await completeOnboarding(ui);
  await (await ui.menuLink('menuSecurity')).click();
  await expect(await ui.heading('unlockScopeTitle')).toBeVisible();
  await expect(page.getByText(await ui.text('unlockScopeNote'), { exact: true })).toBeVisible();
  const all = page.getByRole('radio', { name: await ui.text('unlockScopeAll') });
  const site = page.getByRole('radio', { name: await ui.text('unlockScopeSite') });
  await expect(all).toBeChecked();
  await site.check();
  // The worker locks the sites again on a change; the toast says so.
  await expect(ui.toast).toHaveText(await ui.text('unlockScopeSaved'));
  expect(await sw.evaluate(() => (globalThis as unknown as { __fmp: Api }).__fmp.getSettings().then((x) => x.unlockScope))).toBe('site');
  await page.reload();
  await expect(site).toBeChecked();
  await all.check();
  await expect(all).toBeChecked();
  await expect(site).not.toBeChecked();
});

test('changing the unlock choice locks the sites again while the settings stay open', async ({
  context,
  sw,
  extensionId,
  origin,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await completeOnboarding(ui, 'example.test');
  // Sites unlocked, as after a site unlock.
  await sw.evaluate(() =>
    (globalThis as unknown as { __fmp: Api & { setUnlocked: (d: string[]) => Promise<void> } }).__fmp.setUnlocked([
      'example.test',
    ]),
  );
  const open = await context.newPage();
  await visit(open, origin('example.test'));
  await expect(open).toHaveTitle('ORIGINAL example.test');

  await (await ui.menuLink('menuSecurity')).click();
  await page.getByRole('radio', { name: await ui.text('unlockScopeSite') }).check();
  await expect(ui.toast).toHaveText(await ui.text('unlockScopeSaved'));
  // The settings are still open for their owner ...
  await expect(ui.lockNow).toBeVisible();
  await expect(await ui.heading('unlockScopeTitle')).toBeVisible();
  // ... and the sites are locked again.
  const again = await context.newPage();
  await visit(again, origin('example.test'));
  await expect.poll(() => again.url()).toMatch(new RegExp(`^chrome-extension://${extensionId}/lock\\.html#[ut]=`));
});

test('the locked settings carry the forgot-password help and the controls hold no earlier values', async ({
  context,
  sw,
  extensionId,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await completeOnboarding(ui);
  await (await ui.menuLink('menuAutolock')).click();
  await ui.idle.fill('9');
  await ui.idle.press('Enter');
  await expect(ui.toast).toHaveText(await ui.text('saved'));
  await ui.lockNow.click();
  await expect(ui.unlock).toBeVisible();
  const held = await page.evaluate(() => ({
    idle: (document.getElementById('idle') as HTMLInputElement).value,
    scope: (document.getElementById('scope-site') as HTMLInputElement).checked,
  }));
  expect(held).toEqual({ idle: '5', scope: false });

  const summary = page.getByText(await ui.text('forgotSummary'), { exact: true });
  const body = page.getByText(await ui.text('forgotBody'), { exact: true });
  await expect(summary).toBeVisible();
  await expect(body).toBeHidden();
  await summary.click();
  await expect(body).toBeVisible();
});

test('a typed address deeper than the locked domain gets a warning-weight preview', async ({
  context,
  sw,
  extensionId,
}) => {
  const page = await context.newPage();
  const ui = await openOptions(page, sw, extensionId);
  await completeOnboarding(ui);
  const preview = page.locator('#domain-preview');
  await ui.domainField.fill('https://m.blog.example.test/x');
  await expect(preview).toHaveClass(/broader/);
  expect(await preview.evaluate((el) => getComputedStyle(el).fontWeight)).toBe('600');
  await ui.domainField.fill('example.test');
  await expect(preview).not.toHaveClass(/broader/);
});
