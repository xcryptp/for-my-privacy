// Takes the README screenshots from the built extension. Run it after `npm run build`:
//
//   node scripts/screenshots.ts
//
// It builds nothing itself. It loads `.output/chrome-mv3` the way tests/e2e/fixtures.ts does,
// creates a demo password and the demo site `instagram.com`, and saves 1280x800 light-mode PNGs
// to docs/assets/ for each README language: screenshot-lock.<lang>.png and
// screenshot-options.<lang>.png with <lang> = en, ko, ja (one browser launch per language).
// The demo site is never visited: the host name is mapped to a local server with
// --host-resolver-rules, so no request leaves this machine.
//
// The language is chosen per page, not per browser: Chromium on macOS takes its UI language from
// the system and ignores --lang, and Playwright refuses the -AppleLanguages launch argument. So an
// init script replaces chrome.i18n.getMessage / getUILanguage on every page, answering from the
// extension's own public/_locales/<lang>/messages.json. The script then checks the rendered
// headings against that file and exits with an error if a page is not in the requested language.
//
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
const OUT_DIR = path.join(ROOT, 'docs/assets');
const DEMO_DOMAIN = 'instagram.com';
const LANGUAGES = ['en', 'ko', 'ja'] as const;
const LOCALES = { en: 'en-US', ko: 'ko-KR', ja: 'ja-JP' } as const;
const DEMO_PASSWORD = 'demo password 123';
const VIEWPORT = { width: 1280, height: 800 };

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

type ChromeApi = {
  runtime: { sendMessage: (message: unknown) => Promise<unknown> };
  storage: { local: { get: (key: string) => Promise<Record<string, unknown>>; set: (items: object) => Promise<void> } };
  i18n: { getUILanguage: () => string };
};

try {
  for (const lang of LANGUAGES) await shoot(lang);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function shoot(lang: Language): Promise<void> {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `fmp-shots-${lang}-`));
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
  ) as Record<string, { message: string }>;
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

  try {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
    const extensionId = new URL(sw.url()).host;
    const base = `chrome-extension://${extensionId}`;

    // First install opens the options page by itself; close it so only our pages remain.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const page = await context.newPage();
    await page.goto(`${base}/lock.html`);
    for (const other of context.pages()) if (other !== page) await other.close();

    // The same calls the pages make: choose a password (this also starts unlocked), then save the site.
    await page.evaluate(
      async ({ password, domain }) => {
        const c = (globalThis as unknown as { chrome: ChromeApi }).chrome;
        await c.runtime.sendMessage({ type: 'setup', password });
        const stored = await c.storage.local.get('settings');
        const settings = (stored.settings ?? {}) as Record<string, unknown>;
        await c.storage.local.set({ settings: { ...settings, domains: [domain], idleMinutes: 5 } });
      },
      { password: DEMO_PASSWORD, domain: DEMO_DOMAIN },
    );

    // 1. Settings page (unlocked, with the demo site listed).
    await page.goto(`${base}/options.html`);
    await page.getByText(DEMO_DOMAIN, { exact: false }).first().waitFor({ timeout: 10_000 });
    await settle(page);
    // The store build has no site access for the demo domain (Chrome asks for it with a click, which
    // a script cannot give), so the page shows its "Site access was removed" banner. The banner is
    // real behaviour but not what the picture should lead with, so it is hidden for the shot only.
    await page.addStyleTag({ content: '#permission-lost { display: none !important; }' });
    await expectText(page, '#domains-title', messages.domainsTitle.message, lang);
    await page.screenshot({ path: path.join(OUT_DIR, `screenshot-options.${lang}.png`) });

    // 2. Lock screen, as if the demo site had been opened.
    await page.evaluate(async () => {
      await (globalThis as unknown as { chrome: ChromeApi }).chrome.runtime.sendMessage({ type: 'lockNow' });
    });
    await page.goto(`${base}/lock.html#u=http://${DEMO_DOMAIN}:${port}/`);
    await page.locator('input[type="password"]').waitFor({ timeout: 10_000 });
    await settle(page);
    await expectText(page, 'h1', messages.lockTitle.message, lang);
    await page.screenshot({ path: path.join(OUT_DIR, `screenshot-lock.${lang}.png`) });

    console.log(`Saved screenshot-options.${lang}.png and screenshot-lock.${lang}.png in ${path.relative(ROOT, OUT_DIR)}`);
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
