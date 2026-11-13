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

/** A lock page of this extension: `#u=<raw>` as the rule makes it, or `#t=<token>` after the page claimed it. */
const lockPageUrl = (extensionId: string) => new RegExp(`^chrome-extension://${extensionId}/lock\\.html#[ut]=`);

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
  // The first of five tries: the message says how many are left before the wait.
  await expect(ui.alert).toHaveText(await ui.text('wrongPasswordTries', '4'));
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
  // The message with a wait of 30 s, allowing for a second or two to have passed.
  const waiting = async (seconds: number[]) =>
    new RegExp(
      `^(${(
        await Promise.all(
          seconds.map(async (n) => (await ui.text('tooManyAttempts', await ui.text('waitSeconds', String(n)))).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        )
      ).join('|')})$`,
    );
  await expect(ui.alert).toHaveText(await waiting([30, 29, 28]));
  await expect(ui.button).toBeDisabled();
  // The countdown moves.
  await expect(ui.alert).toHaveText(await waiting([28, 27, 26, 25, 24, 23, 22, 21, 20]), { timeout: 5_000 });
  // The wait survives a reload of the lock page.
  await page.reload();
  await expect(ui.alert).toHaveText(await waiting(Array.from({ length: 12 }, (_, i) => 30 - i)));
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
  await expect.poll(() => page.url()).toMatch(lockPageUrl(extensionId));
  const ui = await lockUi(page, sw);
  await ui.field.fill(PW);
  await ui.field.press('Enter');
  await expect.poll(() => page.url()).toBe(target);
  await expect(page).toHaveTitle('ORIGINAL www.example.test');
});

test('unlocking in one lock tab returns it; another redirect-created lock tab returns when it is brought to front', async ({
  context,
  sw,
  extensionId,
  origin,
}) => {
  await lockDomains(sw, ['example.test']);
  const first = await context.newPage();
  const second = await context.newPage();
  const firstTarget = origin('www.example.test') + '/one';
  const secondTarget = origin('m.example.test') + '/two?x=1';
  for (const [page, target] of [
    [first, firstTarget],
    [second, secondTarget],
  ] as const) {
    await page.goto(target).catch(() => {});
    await expect.poll(() => page.url()).toMatch(lockPageUrl(extensionId));
  }
  const ui = await lockUi(second, sw);
  await ui.field.fill(PW);
  await ui.field.press('Enter');
  await expect.poll(() => second.url()).toBe(secondTarget);
  await expect(second).toHaveTitle('ORIGINAL m.example.test');

  // The other tab was made by the redirect: it stays on its lock page until it is looked at again.
  await first.bringToFront();
  await expect.poll(() => first.url()).toBe(firstTarget);
  await expect(first).toHaveTitle('ORIGINAL www.example.test');
});

test('the extensions page returns after unlocking', async ({ context, sw, extensionId }) => {
  await lockDomains(sw, ['example.test']);
  const page = await context.newPage();
  await page.goto('chrome://extensions/').catch(() => {});
  await expect.poll(() => page.url()).toMatch(lockPageUrl(extensionId));
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

test('the lock page swaps the raw address for a token and still names the site', async ({
  context,
  sw,
  extensionId,
  origin,
}) => {
  await lockDomains(sw, ['example.test']);
  const page = await context.newPage();
  const target = origin('www.example.test') + '/secret/path?q=1';
  const ui = await openLockPage(page, sw, extensionId, target);
  await expect.poll(() => page.url()).toMatch(new RegExp(`/lock\\.html#t=[^#]+$`));
  expect(page.url()).not.toContain('secret');
  expect(page.url()).not.toContain('example.test');
  await expect(page.getByText(await ui.text('lockSubtitle', 'www.example.test'))).toBeVisible();
  // A reload keeps the token and the host label.
  await page.reload();
  await expect(page.getByText(await ui.text('lockSubtitle', 'www.example.test'))).toBeVisible();
  await ui.field.fill(PW);
  await ui.field.press('Enter');
  await expect.poll(() => page.url()).toBe(target);
});

test('each wrong answer says how many tries are left before the wait', async ({
  context,
  sw,
  extensionId,
  origin,
}) => {
  await lockDomains(sw, ['example.test']);
  const page = await context.newPage();
  const ui = await openLockPage(page, sw, extensionId, origin('example.test') + '/');
  await ui.field.fill('wrong 1');
  await ui.field.press('Enter');
  await expect(ui.alert).toHaveText(await ui.text('wrongPasswordTries', '4'));
  for (const n of [2, 3]) {
    await ui.field.fill(`wrong ${n}`);
    await ui.field.press('Enter');
    await expect(ui.alert).toHaveText(await ui.text('wrongPasswordTries', String(5 - n)));
  }
  await ui.field.fill('wrong 4');
  await ui.field.press('Enter');
  await expect(ui.alert).toHaveText(await ui.text('wrongPasswordLastTry'));
});

test('a help line explains that a forgotten password cannot be recovered and how to start over', async ({
  context,
  sw,
  extensionId,
  origin,
}) => {
  await lockDomains(sw, ['example.test']);
  const page = await context.newPage();
  const ui = await openLockPage(page, sw, extensionId, origin('example.test') + '/');
  const summary = page.getByText(await ui.text('forgotSummary'), { exact: true });
  const body = page.getByText(await ui.text('forgotBody'), { exact: true });
  await expect(summary).toBeVisible();
  await expect(body).toBeHidden();
  await summary.click();
  await expect(body).toBeVisible();
  // It is reachable by keyboard: the summary is a focusable disclosure control.
  await summary.focus();
  await expect(summary).toBeFocused();
});

test('the lock page says what one unlock opens, following the unlock setting, and that settings ask again', async ({
  context,
  sw,
  extensionId,
  origin,
}) => {
  await lockDomains(sw, ['example.test']);
  const page = await context.newPage();
  const ui = await openLockPage(page, sw, extensionId, origin('www.example.test') + '/');
  await expect(page.getByText(await ui.text('unlockHintAll'), { exact: true })).toBeVisible();
  await expect(page.getByText(await ui.text('lockSettingsHint'), { exact: true })).toBeVisible();

  await sw.evaluate(() =>
    (globalThis as unknown as { __fmp: Api }).__fmp.saveSettings({ unlockScope: 'site' }),
  );
  const again = await context.newPage();
  await openLockPage(again, sw, extensionId, origin('www.example.test') + '/');
  await expect(again.getByText(await ui.text('unlockHintSite', 'www.example.test'), { exact: true })).toBeVisible();
});

test('unlock scope all opens every listed site together; scope site opens only the one asked for', async ({
  context,
  sw,
  extensionId,
  origin,
}) => {
  await lockDomains(sw, ['example.test', 'noperm.test']);

  // all (the default): unlocking example.test opens noperm.test too.
  const first = await context.newPage();
  const ui = await openLockPage(first, sw, extensionId, origin('example.test') + '/');
  await ui.field.fill(PW);
  await ui.field.press('Enter');
  await expect.poll(() => first.url()).toBe(origin('example.test') + '/');
  const together = await context.newPage();
  await together.goto(origin('noperm.test') + '/');
  await expect(together).toHaveTitle('ORIGINAL noperm.test');

  // site: lock again, then unlocking example.test leaves noperm.test locked.
  await sw.evaluate(async () => {
    const api = (globalThis as unknown as { __fmp: Api }).__fmp;
    await api.saveSettings({ unlockScope: 'site' });
    await api.handleMessage({ type: 'lockNow' }, {});
  });
  const second = await context.newPage();
  const ui2 = await openLockPage(second, sw, extensionId, origin('example.test') + '/');
  await ui2.field.fill(PW);
  await ui2.field.press('Enter');
  await expect.poll(() => second.url()).toBe(origin('example.test') + '/');
  // The guard replaces a tab that opens a locked site without access: watch every new page.
  const before = new Set(context.pages());
  const apart = await context.newPage();
  await apart.goto(origin('noperm.test') + '/').catch(() => {});
  await expect
    .poll(() =>
      context
        .pages()
        .some((page) => !before.has(page) && lockPageUrl(extensionId).test(page.url())),
    )
    .toBe(true);
});
