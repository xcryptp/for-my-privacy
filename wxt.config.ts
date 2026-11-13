import { defineConfig } from 'wxt';

export default defineConfig({
  // Vite's modulepreload polyfill (for browsers without <link rel="modulepreload">) calls fetch().
  // Chrome supports modulepreload natively, so leave it out and keep fetch( out of the bundle.
  vite: () => ({ build: { modulePreload: { polyfill: false } } }),
  // Output dirs are per mode by default: chrome-mv3, chrome-mv3-noguard, chrome-mv3-e2e.
  manifest: ({ mode }) => ({
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    short_name: '__MSG_extShortName__',
    default_locale: 'en',
    minimum_chrome_version: '120',
    permissions: ['declarativeNetRequest', 'storage', 'idle', 'tabs'],
    optional_host_permissions: ['*://*/*'],
    web_accessible_resources: [{ resources: ['lock.html'], matches: ['<all_urls>'] }],
    // Only the e2e build gets host permissions; noperm.test deliberately gets none.
    ...(mode === 'e2e' ? { host_permissions: ['*://example.test/*', '*://*.example.test/*'] } : {}),
  }),
});
