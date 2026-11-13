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
  'second.test',
  '*.second.test',
];
const HOST_RESOLVER_RULES = HOST_MAP.map((h) => `MAP ${h} 127.0.0.1`).join(', ');
// Origins treated as secure so their pages can register a service worker (other.test too: a
// frame is a secure context only inside a secure page).
const SW_HOSTS = ['example.test', 'www.example.test', 'm.example.test', 'a.b.c.example.test', 'noperm.test', 'other.test'];

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
        const pathname = req.url?.split('?')[0];
        if (pathname === '/sw.js') {
          // The site's own service worker: caches /sw-page and answers navigations from the
          // cache, so a navigation it serves never reaches the network (or declarativeNetRequest).
          res.setHeader('content-type', 'text/javascript');
          res.end(`
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open('fmp-e2e').then((c) => c.add('/sw-page')));
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode === 'navigate') {
    e.respondWith(caches.match('/sw-page').then((r) => r || fetch(e.request)));
  }
});`);
          return;
        }
        if (pathname === '/api') {
          res.setHeader('content-type', 'application/json');
          res.setHeader('access-control-allow-origin', '*');
          res.end('{"data":"SECRET"}');
          return;
        }
        res.setHeader('content-type', 'text/html; charset=utf-8');
        if (pathname === '/sw-page') {
          res.end(
            `<!doctype html><title>ORIGINAL ${host}</title><body>ORIGINAL-PAGE<script>navigator.serviceWorker.register('/sw.js')</script></body>`,
          );
          return;
        }
        if (pathname === '/frame-sw') {
          // A page of the site that embeds a deeper subdomain, which registers its own service
          // worker from inside the frame (that origin never shows as a top-level tab).
          res.end(
            `<!doctype html><title>ORIGINAL ${host}</title><body><iframe src="http://a.b.c.example.test:${port}/sw-page"></iframe></body>`,
          );
          return;
        }
        if (pathname === '/frame-deep') {
          // Another site embedding the locked site's deeper subdomain, which registers its own
          // (partitioned) service worker from inside the frame.
          res.end(
            `<!doctype html><title>HOST ${host}</title><body><iframe src="http://a.b.c.example.test:${port}/sw-page"></iframe></body>`,
          );
          return;
        }
        if (pathname === '/frame-unload') {
          // A host page that asks before it is left, so a reload can be held back by a dialog.
          res.end(
            `<!doctype html><title>HOST ${host}</title><body><iframe src="http://example.test:${port}/"></iframe><script>addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; });</script></body>`,
          );
          return;
        }
        if (pathname === '/frame') {
          res.end(
            `<!doctype html><title>ORIGINAL ${host}</title><body><iframe src="http://example.test:${port}/"></iframe></body>`,
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
  browserState: async ({ server }, use) => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmp-e2e-'));
    const state = {
      async launch() {
        // Bundled Chromium only; extensions need a persistent context.
        const ctx = await chromium.launchPersistentContext(profileDir, {
          channel: 'chromium',
          headless: true,
          // Playwright turns the back/forward cache off by default; real Chrome has it on, and a
          // page restored from it needs no request, so the redirect rule never sees it.
          ignoreDefaultArgs: ['--disable-back-forward-cache'],
          args: [
            `--disable-extensions-except=${EXTENSION_DIR}`,
            `--load-extension=${EXTENSION_DIR}`,
            `--host-resolver-rules=${HOST_RESOLVER_RULES}`,
            // navigator.serviceWorker needs a secure context; the test server is plain http.
            `--unsafely-treat-insecure-origin-as-secure=${SW_HOSTS.map((h) => `http://${h}:${server.port}`).join(',')}`,
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

/**
 * The target of a lock page URL: the raw `#u=` text, or for `#t=<token>` the target the service
 * worker stored for that token (undefined when it has none). Other URLs give undefined.
 */
export async function lockTargetOf(sw: Worker, extensionId: string, url: string): Promise<string | undefined> {
  const base = `chrome-extension://${extensionId}/lock.html`;
  if (url.startsWith(base + '#u=')) return url.slice(base.length + 3);
  if (!url.startsWith(base + '#t=')) return undefined;
  const key = 'lockTarget:' + url.slice(base.length + 3);
  return sw.evaluate(
    async (k) => ((await chrome.storage.session.get(k))[k] as { url?: string } | undefined)?.url,
    key,
  );
}

/** True when some open page is a lock page for `target` (either URL form). */
export async function hasLockPageFor(
  context: BrowserContext,
  sw: Worker,
  extensionId: string,
  target: string,
): Promise<boolean> {
  for (const p of context.pages()) {
    if (p.isClosed()) continue;
    if ((await lockTargetOf(sw, extensionId, p.url())) === target) return true;
  }
  return false;
}

// The callbacks passed to sw.evaluate run inside the service worker, where `chrome` exists.
declare const chrome: typeof import('wxt/browser').browser;
