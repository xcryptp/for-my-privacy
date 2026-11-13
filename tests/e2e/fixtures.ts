import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Built by `npm run build:e2e` (WXT writes each mode to its own directory).
const EXTENSION_DIR = path.resolve(import.meta.dirname, '../../.output/chrome-mv3-e2e');

// Every test host resolves to the local server. The trailing-dot form covers FQDN navigation.
const HOST_MAP = [
  'example.test',
  '*.example.test',
  'example.test.',
  'notexample.test',
  '*.notexample.test',
  'noperm.test',
  'other.test',
];
const HOST_RESOLVER_RULES = HOST_MAP.map((h) => `MAP ${h} 127.0.0.1`).join(', ');

type BrowserState = {
  context: BrowserContext;
  sw: Worker;
  launch: () => Promise<void>;
};

type TestFixtures = {
  browserState: BrowserState;
  context: BrowserContext;
  extensionId: string;
  sw: Worker;
  origin: (host: string) => string;
  relaunch: () => Promise<void>;
};

type WorkerFixtures = {
  server: { port: number };
};

// Forward every access to whatever object the getter currently returns, so a fixture value
// handed to a test keeps working after relaunch() replaced the underlying browser objects.
function live<T extends object>(get: () => T): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      const current = get();
      const value = Reflect.get(current, prop, current);
      return typeof value === 'function' ? value.bind(current) : value;
    },
  });
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  server: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const server = http.createServer((req, res) => {
        const host = (req.headers.host ?? 'unknown').replace(/:\d+$/, '');
        const port = (server.address() as AddressInfo).port;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        if (req.url?.split('?')[0] === '/frame') {
          res.end(
            `<!doctype html><title>FRAME ${host}</title><body><iframe src="http://example.test:${port}/"></iframe></body>`,
          );
          return;
        }
        res.end(`<!doctype html><title>ORIGINAL ${host}</title><body>ORIGINAL-PAGE</body>`);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      await use({ port: (server.address() as AddressInfo).port });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    { scope: 'worker' },
  ],

  // The browser state lives in one holder so relaunch() can swap context and sw in place.
  // eslint-disable-next-line no-empty-pattern
  browserState: async ({}, use) => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmp-e2e-'));
    const state = {
      async launch() {
        // Bundled Chromium only; extensions need a persistent context.
        const ctx = await chromium.launchPersistentContext(profileDir, {
          channel: 'chromium',
          headless: true,
          args: [
            `--disable-extensions-except=${EXTENSION_DIR}`,
            `--load-extension=${EXTENSION_DIR}`,
            `--host-resolver-rules=${HOST_RESOLVER_RULES}`,
          ],
        });
        state.context = ctx;
        state.sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 15_000 }));
      },
    } as BrowserState;
    await state.launch();
    try {
      await use(state);
    } finally {
      await state.context.close().catch(() => {});
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  },

  context: async ({ browserState }, use) => {
    await use(live(() => browserState.context));
  },

  sw: async ({ browserState }, use) => {
    await use(live(() => browserState.sw));
  },

  extensionId: async ({ browserState }, use) => {
    await use(new URL(browserState.sw.url()).host);
  },

  origin: async ({ server }, use) => {
    await use((host: string) => `http://${host}:${server.port}`);
  },

  relaunch: async ({ browserState }, use) => {
    await use(async () => {
      await browserState.context.close();
      await browserState.launch();
    });
  },
});

export const expect = test.expect;
