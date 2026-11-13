// Takes the two README screenshots from the built extension. Run it after `npm run build`:
//
//   node scripts/screenshots.ts
//
// It builds nothing itself. It loads `.output/chrome-mv3` the way tests/e2e/fixtures.ts does,
// creates a demo password and the demo site `instagram.com`, and saves 1280x800 light-mode PNGs
// with the English UI to docs/assets/. The demo site is never visited: the host name is mapped
// to a local server with --host-resolver-rules, so no request leaves this machine.
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

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmp-shots-'));
const context = await chromium.launchPersistentContext(profileDir, {
  channel: 'chromium',
  headless: true,
  viewport: VIEWPORT,
  colorScheme: 'light',
  locale: 'en-US',
  args: [
    '--lang=en-US',
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
    `--host-resolver-rules=MAP ${DEMO_DOMAIN} 127.0.0.1, MAP *.${DEMO_DOMAIN} 127.0.0.1`,
  ],
  env: { ...process.env, LANGUAGE: 'en_US:en', LC_ALL: 'en_US.UTF-8' },
});

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
  type ChromeApi = {
    runtime: { sendMessage: (message: unknown) => Promise<unknown> };
    storage: { local: { get: (key: string) => Promise<Record<string, unknown>>; set: (items: object) => Promise<void> } };
    i18n: { getUILanguage: () => string };
  };
  const uiLanguage = await page.evaluate(() => (globalThis as unknown as { chrome: ChromeApi }).chrome.i18n.getUILanguage());
  if (!uiLanguage.toLowerCase().startsWith('en')) {
    console.warn(`Warning: the browser UI language is "${uiLanguage}", not English. The screenshots will not be in English.`);
  }
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
  await page.screenshot({ path: path.join(OUT_DIR, 'screenshot-options.png') });

  // 2. Lock screen, as if the demo site had been opened.
  await page.evaluate(async () => {
    await (globalThis as unknown as { chrome: ChromeApi }).chrome.runtime.sendMessage({ type: 'lockNow' });
  });
  await page.goto(`${base}/lock.html#u=http://${DEMO_DOMAIN}:${port}/`);
  await page.locator('input[type="password"]').waitFor({ timeout: 10_000 });
  await settle(page);
  await page.screenshot({ path: path.join(OUT_DIR, 'screenshot-lock.png') });

  console.log(`Saved ${path.relative(ROOT, OUT_DIR)}/screenshot-options.png and screenshot-lock.png`);
} finally {
  await context.close().catch(() => {});
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(profileDir, { recursive: true, force: true });
}

/** Lets fonts and focus rings finish before the picture is taken. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}
