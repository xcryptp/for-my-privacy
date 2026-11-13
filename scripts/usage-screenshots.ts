// Takes the screenshots of the user guide (docs/usage*.md) from the built extension. Run it after
// `npm run build`:
//
//   node scripts/usage-screenshots.ts   (runs a .ts file directly: Node 22.18+ or 23.6+)
//
// It builds nothing itself. Like scripts/screenshots.ts it loads `.output/chrome-mv3`, answers the
// extension's i18n calls from public/_locales/<lang>/messages.json (the language is chosen per page,
// not per browser), and maps the demo site to a local server with --host-resolver-rules, so no request
// leaves this machine. One browser launch with a fresh profile per language, light mode.
//
// It walks the real first run, then saves 1280x800 PNGs (the popup at its natural size) to
// docs/assets/usage/<name>.<lang>.png with <lang> = en, ko, ja:
//
//   onboarding-1  welcome                      onboarding-2  password and the warning
//   onboarding-3  choosing sites (chips and a pasted address, not yet added)
//   onboarding-4  auto-lock                    sites         settings, Sites, one site listed
//   security      settings, Security (unlock scope)          popup         the toolbar popup
//   lock          the lock screen              lock-wrong    the lock screen after a wrong password
//
// Chrome's own permission prompt cannot be clicked by a script, so the chips of step 3 are chosen for
// the picture and then cleared before "Next" (a request for site access would be refused here); the
// demo site is put in the list the way scripts/screenshots.ts does it, straight into storage.
// Node runs this file with its built-in type stripping, so keep it to erasable TypeScript syntax.
import { chromium } from '@playwright/test';
import type { Page } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXTENSION_DIR = path.join(ROOT, '.output/chrome-mv3');
const OUT_DIR = path.join(ROOT, 'docs/assets/usage');
const DEMO_DOMAIN = 'instagram.com';
const OTHER_CHIP = 'youtube.com';
// A blog address on a big site: the preview line then says the whole site gets locked.
const BLOG_ADDRESS = 'https://blog.naver.com/my-blog';
const LANGUAGES = ['en', 'ko', 'ja'] as const;
const LOCALES = { en: 'en-US', ko: 'ko-KR', ja: 'ja-JP' } as const;
const DEMO_PASSWORD = 'demo password 123';
const WRONG_PASSWORD = 'not the password';
const VIEWPORT = { width: 1280, height: 800 };
const POPUP_VIEWPORT = { width: 320, height: 240 };

if (!fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) {
  throw new Error(`No build at ${EXTENSION_DIR}. Run "npm run build" first.`);
}
fs.mkdirSync(OUT_DIR, { recursive: true });

// Stands in for the demo site; the lock page only reads the host name from the address.
const server = http.createServer((_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end('<!doctype html><title>Demo site</title><body>Demo site</body>');
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;

type Language = (typeof LANGUAGES)[number];
type Messages = Record<string, { message: string }>;

type ChromeApi = {
  runtime: { sendMessage: (message: unknown) => Promise<unknown> };
  storage: { local: { get: (key: string) => Promise<Record<string, unknown>>; set: (items: object) => Promise<void> } };
};

try {
  for (const lang of LANGUAGES) await shoot(lang);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function shoot(lang: Language): Promise<void> {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `fmp-usage-${lang}-`));
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    viewport: VIEWPORT,
    colorScheme: 'light',
    locale: LOCALES[lang],
    args: [
      `--lang=${lang}`,
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      `--host-resolver-rules=MAP ${DEMO_DOMAIN} 127.0.0.1, MAP *.${DEMO_DOMAIN} 127.0.0.1`,
    ],
    env: { ...process.env, LANGUAGE: `${lang}`, LC_ALL: `${LOCALES[lang].replace('-', '_')}.UTF-8` },
  });

  const messages = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'public/_locales', lang, 'messages.json'), 'utf8'),
  ) as Messages;
  await context.addInitScript(
    ({ messages, lang }) => {
      const i18n = (globalThis as unknown as { chrome?: { i18n?: object } }).chrome?.i18n;
      if (!i18n) return;
      const getMessage = (key: string, subs?: string | string[]): string => {
        const text = messages[key]?.message ?? '';
        const list = subs === undefined ? [] : Array.isArray(subs) ? subs : [subs];
        return text.replace(/\$(\d)/g, (_all, n: string) => list[Number(n) - 1] ?? '');
      };
      Object.defineProperty(i18n, 'getMessage', { value: getMessage, configurable: true, writable: true });
      Object.defineProperty(i18n, 'getUILanguage', { value: () => lang, configurable: true, writable: true });
    },
    { messages, lang },
  );

  const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT_DIR, `${name}.${lang}.png`) });

  try {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
    const extensionId = new URL(sw.url()).host;
    const base = `chrome-extension://${extensionId}`;

    // First install opens the options page by itself; use a page of our own and close the rest.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const page = await context.newPage();
    for (const other of context.pages()) if (other !== page) await other.close();

    // ---- First run: the four onboarding steps ----
    await page.goto(`${base}/options.html`);
    await page.locator('#step-1').waitFor({ state: 'visible', timeout: 10_000 });
    await settle(page);
    await expectText(page, '#step-1-title', messages.onboardingWelcomeTitle.message, lang);
    await shot(page, 'onboarding-1');

    await page.locator('#ob-start').click();
    await page.locator('#step-2').waitFor({ state: 'visible' });
    await page.locator('#setup-password').fill(DEMO_PASSWORD);
    await page.locator('#setup-confirm').fill(DEMO_PASSWORD);
    await settle(page);
    await expectText(page, '#step-2-title', messages.setupTitle.message, lang);
    await shot(page, 'onboarding-2');

    await page.locator('#setup-submit').click();
    await page.locator('#step-3').waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('#ob-chips').getByRole('button', { name: DEMO_DOMAIN, exact: true }).click();
    await page.locator('#ob-chips').getByRole('button', { name: OTHER_CHIP, exact: true }).click();
    await page.locator('#ob-domain').fill(BLOG_ADDRESS);
    await page.locator('#ob-preview').filter({ hasText: 'naver.com' }).waitFor();
    await settle(page);
    await expectText(page, '#step-3-title', messages.onboardingSitesTitle.message, lang);
    await shot(page, 'onboarding-3');

    // Clear the picture's choices: a site request would be refused without Chrome's prompt.
    await page.locator('#ob-chips').getByRole('button', { name: DEMO_DOMAIN, exact: true }).click();
    await page.locator('#ob-chips').getByRole('button', { name: OTHER_CHIP, exact: true }).click();
    await page.locator('#ob-domain').fill('');
    await page.locator('#next-3').click();
    await page.locator('#step-4').waitFor({ state: 'visible', timeout: 10_000 });
    await settle(page);
    await expectText(page, '#step-4-title', messages.idleTitle.message, lang);
    await shot(page, 'onboarding-4');

    await page.locator('#finish').click();
    await page.locator('#view-settings').waitFor({ state: 'visible', timeout: 10_000 });

    // The demo site goes into the list the way scripts/screenshots.ts does it.
    await page.evaluate(
      async ({ domain }) => {
        const c = (globalThis as unknown as { chrome: ChromeApi }).chrome;
        const stored = await c.storage.local.get('settings');
        const settings = (stored.settings ?? {}) as Record<string, unknown>;
        await c.storage.local.set({ settings: { ...settings, domains: [domain], idleMinutes: 5 } });
      },
      { domain: DEMO_DOMAIN },
    );

    // ---- Settings: Sites (a site listed, and what a pasted blog link would lock) ----
    await page.goto(`${base}/options.html#sites`);
    await page.locator('#domains li', { hasText: DEMO_DOMAIN }).first().waitFor({ timeout: 10_000 });
    await page.locator('#domain').fill(BLOG_ADDRESS);
    await page.locator('#domain-preview').filter({ hasText: 'naver.com' }).waitFor();
    await settle(page);
    // The store build has no site access for the demo domain (see scripts/screenshots.ts): hide the
    // "Site access was removed" banner for the shot only.
    await page.addStyleTag({ content: '#permission-lost { display: none !important; }' });
    await expectText(page, '#domains-title', messages.domainsTitle.message, lang);
    await shot(page, 'sites');

    // ---- Settings: Security (unlock scope) ----
    await page.goto(`${base}/options.html#security`);
    await page.locator('#scope-title').waitFor({ state: 'visible', timeout: 10_000 });
    // The page ends just below the unlock scope, so this is the view with that card fully in sight.
    await page.locator('#guard-row').scrollIntoViewIfNeeded();
    await page.evaluate(() => document.getElementById('guard-row')?.scrollIntoView({ block: 'start' }));
    await settle(page);
    await expectText(page, '#scope-title', messages.unlockScopeTitle.message, lang);
    await shot(page, 'security');

    // ---- Toolbar popup, at its natural size (an extension page opened as a tab here) ----
    const popup = await context.newPage();
    await popup.setViewportSize(POPUP_VIEWPORT);
    await popup.goto(`${base}/popup.html`);
    await popup.locator('#lock').waitFor({ state: 'visible' });
    await expectText(popup, '#lock', messages.lockNowButton.message, lang);
    // The line under the title ("Sites are locked") arrives after the worker answers.
    await popup.locator('#state').filter({ hasText: messages.popupAllLocked.message }).waitFor({ state: 'visible', timeout: 10_000 });
    await settle(popup);
    await popup.locator('body').screenshot({ path: path.join(OUT_DIR, `popup.${lang}.png`) });
    await popup.close();

    // ---- Lock screen, as if the demo site had been opened, then after a wrong password ----
    await page.evaluate(async () => {
      await (globalThis as unknown as { chrome: ChromeApi }).chrome.runtime.sendMessage({ type: 'lockNow' });
    });
    await page.goto(`${base}/lock.html#u=http://${DEMO_DOMAIN}:${port}/`);
    await page.locator('input[type="password"]').waitFor({ timeout: 10_000 });
    await page.locator('#scope-hint').waitFor({ state: 'visible' });
    await settle(page);
    await expectText(page, 'h1', messages.lockTitle.message, lang);
    await shot(page, 'lock');

    await page.locator('#password').fill(WRONG_PASSWORD);
    await page.locator('#submit').click();
    const triesLeftAfterOne = '4';
    const expectedError = messages.wrongPasswordTries.message.replace('$1', triesLeftAfterOne);
    await page.locator('#error').filter({ hasText: expectedError }).waitFor({ timeout: 10_000 });
    await settle(page);
    await expectText(page, '#error', expectedError, lang);
    await shot(page, 'lock-wrong');

    console.log(`Saved the usage screenshots for ${lang} in ${path.relative(ROOT, OUT_DIR)}`);
  } finally {
    await context.close().catch(() => {});
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

/** Lets fonts and focus rings finish before the picture is taken. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

/** Fails the run when the rendered text is not the requested language's own message. */
async function expectText(page: Page, selector: string, expected: string, lang: Language): Promise<void> {
  const actual = (await page.locator(selector).first().textContent())?.trim();
  if (actual !== expected) {
    throw new Error(`${lang}: "${selector}" shows "${actual}", expected "${expected}".`);
  }
}
