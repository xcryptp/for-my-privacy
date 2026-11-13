# For My Privacy v0.1.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Chrome MV3 extension that sends chosen domains and all their subdomains to a password lock page, re-locks on idle, screen lock, last window closed and browser restart, and is ready for the Chrome Web Store and a public MIT GitHub repo with trilingual READMEs.

**Architecture:** Blocking is pure `declarativeNetRequest`: a dynamic redirect rule (main_frame → `lock.html#u=<original>`) over a lower-priority dynamic block rule (main_frame + sub_frame) that still works when site access is revoked. Unlocking adds one higher-priority session allow rule; that rule is the only unlocked state. A thin service worker wires idle, windows, tabs and messages to a small engine; the lock page and the options page are plain TypeScript pages that talk to the worker by `runtime.sendMessage`.

**Tech Stack:** WXT + TypeScript (no UI framework), WebCrypto PBKDF2, Vitest with `WxtVitest`, Playwright Test with bundled Chromium, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-13-site-lock-design.md` (Korean). Spike evidence for B1-B8: the spec's section 8; a throwaway spike script (not kept in the repo) showed a working Playwright launch with `--load-extension` and `--host-resolver-rules` .

## Global Constraints

- Repo root: this repository (`for-my-privacy`). Work on branch `feature/v0.1.0`.
- Subagents never commit, push or create remotes. The orchestrator commits each task after verification.
- Manifest V3, Chrome desktop on macOS and Windows, `minimum_chrome_version: "120"`.
- `permissions`: exactly `["declarativeNetRequest", "storage", "idle", "tabs"]`. `optional_host_permissions: ["*://*/*"]`. No `host_permissions` except in the `e2e` build mode.
- `web_accessible_resources`: `[{ resources: ["lock.html"], matches: ["<all_urls>"] }]` (spike B2: needed for web-initiated navigations).
- No network requests, no remote code, no analytics, no `chrome.storage.sync`. Everything lives in `chrome.storage.local`.
- Password: PBKDF2-SHA256, 600000 iterations, 16-byte random salt, minimum 8 characters, constant-time compare.
- Auto-lock: `idleMinutes` integer 1-60, default 5; `idle.setDetectionInterval(Math.max(15, idleMinutes * 60))`.
- Wrong-password wait: 0 for fewer than 5 failures, then `min(30000 * 2 ** (failures - 5), 900000)` ms.
- Build flag: `import.meta.env.VITE_FMP_SETTINGS_GUARD !== 'off'` enables the extensions-page guard. `.env.noguard` sets it to `off`. Both builds ship the guard until the store rejects it.
- Locales: `en` (default_locale), `ko`, `ja`. Every user-visible string goes through `chrome.i18n`.
- Names: manifest `name` = `__MSG_extName__` ("For My Privacy: Site Password Lock"), `short_name` = `__MSG_extShortName__` ("For My Privacy").
- Version: SemVer, `package.json` is the only source (WXT copies it to the manifest). Start at `0.1.0`.
- License MIT, `Copyright (c) 2026 xcryptp`.
- Node: `engines.node >= 22`; CI uses Node 24.
- Code comments and commit messages in English.

## Review Focus

- The service worker is stopped and restarted (MV3 does this after ~30 s idle) between unlock and the next idle event: the domain must stay unlocked and the idle interval must be set again on start. Pinned by Task 6 test `restores idle interval on worker start`.
- The domain list changes while unlocked: an added domain is unlocked too (no surprise lock), a removed domain stops being blocked at once. Pinned by Task 6 test `resyncs rules and unlock rule when domains change`.
- Password set but no domains, or domains but no password: nothing is blocked. Pinned by Task 5 test `buildBlockRules returns [] for no domains` and Task 6 test `does not block before a password exists`.
- Several tabs of locked domains in two windows, one pinned and one active: after relock each is a lock tab in its own window at the same index with the same pinned and active state. Pinned by Task 6 e2e `relock replaces tabs in place`.
- The lock page opened directly with no `#u=` or with `#u=javascript:...` / an unlisted domain: unlocking never navigates there. Pinned by Task 6 test `safeReturnTo rejects foreign and non-http targets` and the Task 8 e2e for `#u=javascript:alert(1)`.

## Execution Waves

Tasks in the same wave touch disjoint files and may run in parallel (at most two implementers at a time).

| Wave | Tasks | Why this order |
| --- | --- | --- |
| 1 | 1 | Everything needs the scaffold and the e2e fixture |
| 2 | 2 · 3 | Pure libraries, no shared files |
| 3 | 4 · 5 | Settings needs Tasks 2-3; rules needs Task 2 |
| 4 | 6 · 7 | Engine needs 2-5; locales are independent (Task 7 runs unit tests only, no build) |
| 5 | 8 · 11 | Lock page needs 6-7; CI scripts are independent. Only one e2e-running task per wave |
| 6 | 9 · 10 | Options page needs 8's `base.css`; docs need `RELEASING.md` from 11. Screenshots run after 9 lands |
| 7 | 12 | Whole-branch review |

All tasks share one working tree on `feature/v0.1.0`; two tasks in one wave never edit the same file, and only one of them runs e2e or a build.

---

### Task 1: Scaffold, build modes and e2e fixture

**Files:**
- Create: `package.json`, `wxt.config.ts`, `tsconfig.json`, `vitest.config.ts`, `playwright.config.ts`, `.gitignore`, `.env.noguard`, `.nvmrc` (`24`), `LICENSE`, `src/lib/flags.ts`, `entrypoints/background.ts` (placeholder that only logs nothing), `tests/unit/flags.test.ts`, `tests/e2e/fixtures.ts`, `tests/e2e/smoke.spec.ts`

**Interfaces:**
- Produces: `SETTINGS_GUARD_BUILD: boolean` in `src/lib/flags.ts`.
- Produces: npm scripts `dev`, `build` (`wxt build`), `build:noguard` (`wxt build --mode noguard`), `build:e2e` (`wxt build --mode e2e`), `zip`, `zip:noguard`, `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `test:e2e` (`npm run build:e2e && playwright test`).
- Produces: Playwright fixture `test` from `tests/e2e/fixtures.ts` with `context`, `extensionId: string`, `sw: Worker`, `origin(host: string): string` (e.g. `origin('www.example.test')` → `http://www.example.test:<port>`), `relaunch(): Promise<void>` (closes and relaunches with the same profile, refreshing `context` and `sw`). The local server answers every path with `<title>ORIGINAL <host></title>` and, for `/frame`, a page embedding `<iframe src="http://example.test:<port>/">`. Host map: `example.test`, `*.example.test`, `notexample.test`, `*.notexample.test`, `noperm.test`, `other.test` → 127.0.0.1. Extension dir: `.output/chrome-mv3-e2e` (set `outDirTemplate` or equivalent so the e2e build does not overwrite the normal build).

- [ ] **Step 1:** `git switch -c feature/v0.1.0`; `npm init` + `npm i -D wxt typescript vitest @playwright/test`; `npx playwright install chromium`.
- [ ] **Step 2:** `wxt.config.ts` manifest function: the Global Constraints manifest values; when `mode === 'e2e'` add `host_permissions: ["*://example.test/*", "*://*.example.test/*"]` and nothing for `noperm.test` (Task 5 uses it to test the fallback block).
- [ ] **Step 3:** Write `tests/unit/flags.test.ts`: `SETTINGS_GUARD_BUILD` is `true` with no env and `false` when `VITE_FMP_SETTINGS_GUARD=off` (stub `import.meta.env` with `vi.stubEnv`). Run `npm test` → FAIL, implement `flags.ts`, run → PASS.
- [ ] **Step 4:** Write `tests/e2e/smoke.spec.ts`: the extension loads and `extensionId` matches `/^[a-p]{32}$/`. Run `npm run test:e2e` → PASS.
- [ ] **Step 5:** Verify `npm run build && npm run build:noguard && npm run typecheck` all exit 0, and `.output/chrome-mv3/manifest.json` has the exact permissions above and no `host_permissions`.

### Task 2: Domain rules

**Files:**
- Create: `src/lib/domain.ts`, `tests/unit/domain.test.ts`

**Interfaces:**
- Produces: `normalizeDomain(input: string): string | null`, `hostMatches(host: string, domain: string): boolean`, `suggestRelated(domain: string): string[]`.

- [ ] **Step 1: Write the failing tests**

```ts
expect(normalizeDomain('Instagram.com')).toBe('instagram.com');
expect(normalizeDomain('https://www.instagram.com/explore?x=1')).toBe('instagram.com');
expect(normalizeDomain('*.instagram.com')).toBe('instagram.com');
expect(normalizeDomain('m.instagram.com')).toBe('m.instagram.com'); // a subdomain stays as given
expect(normalizeDomain('instagram.com.')).toBe('instagram.com');
expect(normalizeDomain('한국.kr')).toBe('xn--3e0b707e.kr');
for (const bad of ['', '   ', 'not a domain', 'localhost', 'chrome://extensions']) expect(normalizeDomain(bad)).toBeNull();
expect(hostMatches('www.instagram.com', 'instagram.com')).toBe(true);
expect(hostMatches('INSTAGRAM.COM.', 'instagram.com')).toBe(true);
expect(hostMatches('notinstagram.com', 'instagram.com')).toBe(false);
expect(hostMatches('instagram.com.evil.net', 'instagram.com')).toBe(false);
expect(suggestRelated('instagram.com')).toEqual(['instagr.am']);
expect(suggestRelated('unknown.example')).toEqual([]);
```

- [ ] **Step 2:** Run `npx vitest run tests/unit/domain.test.ts` → FAIL.
- [ ] **Step 3:** Implement. `normalizeDomain`: trim, drop a leading `*.`, prefix `http://` when there is no scheme, accept only `http:`/`https:`, take `URL.hostname` (lower-case and punycode come from `URL`), drop a trailing `.` and a leading `www.`, reject hosts without a dot. `suggestRelated` map: `instagram.com → [instagr.am]`, `facebook.com → [fb.com, messenger.com]`, `twitter.com → [x.com]`, `x.com → [twitter.com]`, `youtube.com → [youtu.be]`, `reddit.com → [redd.it]`.
- [ ] **Step 4:** Run → PASS.

### Task 3: Password and wait time

**Files:**
- Create: `src/lib/password.ts`, `tests/unit/password.test.ts`

**Interfaces:**
- Produces: `interface PasswordRecord { v: 1; salt: string; iterations: number; hash: string }` (base64 strings), `PBKDF2_ITERATIONS = 600000`, `MIN_PASSWORD_LENGTH = 8`, `validatePassword(pw: string): 'ok' | 'too_short'`, `createRecord(pw: string, iterations?: number): Promise<PasswordRecord>`, `verifyPassword(pw: string, record: PasswordRecord): Promise<boolean>`, `backoffMs(failures: number): number`.

- [ ] **Step 1: Write the failing tests** (`iterations = 1000` in tests for speed, plus one test that the default record has `iterations === 600000`)

```ts
const r = await createRecord('correct horse', 1000);
expect(await verifyPassword('correct horse', r)).toBe(true);
expect(await verifyPassword('correct horsf', r)).toBe(false);
expect(r.salt).not.toBe((await createRecord('correct horse', 1000)).salt); // random salt
expect(JSON.stringify(r)).not.toContain('correct horse');
expect(validatePassword('1234567')).toBe('too_short');
expect(validatePassword('12345678')).toBe('ok');
expect([4, 5, 6, 10, 30].map(backoffMs)).toEqual([0, 30000, 60000, 900000, 900000]);
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement with `crypto.subtle.importKey('raw', …, 'PBKDF2')` + `deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256)`; compare with a constant-time loop over equal-length byte arrays. `createRecord` throws `Error('too_short')` when validation fails.
- [ ] **Step 4:** Run → PASS.

### Task 4: Settings and auth storage

**Files:**
- Create: `src/lib/settings.ts`, `tests/unit/settings.test.ts`

**Interfaces:**
- Consumes: `normalizeDomain` (Task 2), `PasswordRecord` (Task 3).
- Produces: `interface Settings { domains: string[]; idleMinutes: number; lockOnScreenLock: boolean; settingsGuard: boolean }`, `DEFAULT_SETTINGS = { domains: [], idleMinutes: 5, lockOnScreenLock: true, settingsGuard: true }`, `interface Auth { password: PasswordRecord | null; failures: number; blockedUntil: number }`, `getSettings(): Promise<Settings>`, `saveSettings(patch: Partial<Settings>): Promise<Settings>`, `getAuth(): Promise<Auth>`, `saveAuth(patch: Partial<Auth>): Promise<Auth>`. Storage keys `settings` and `auth` in `browser.storage.local`.

- [ ] **Step 1: Write the failing tests** (WxtVitest `fakeBrowser`, reset in `beforeEach`)
  - `getSettings()` on empty storage equals `DEFAULT_SETTINGS`.
  - `saveSettings({ domains: ['WWW.Instagram.com', 'instagram.com', 'bad'] })` stores `['instagram.com']` (normalized, deduped, invalid dropped).
  - `saveSettings({ idleMinutes: 0 })` → 1; `{ idleMinutes: 99 }` → 60; `{ idleMinutes: 7.6 }` → 8.
  - `getAuth()` on empty storage equals `{ password: null, failures: 0, blockedUntil: 0 }`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.

### Task 5: Blocking rules

**Files:**
- Create: `src/lib/rules.ts`, `tests/unit/rules.test.ts`, `tests/e2e/blocking.spec.ts`
- Modify: `entrypoints/background.ts` (only the e2e-mode test global below)

**Interfaces:**
- Produces: `RULE_REDIRECT = 1`, `RULE_FALLBACK_BLOCK = 2`, `RULE_UNLOCK = 100`, `buildBlockRules(domains: string[], redirectDomains: string[], lockPageBase: string): Rule[]`, `domainsWithHostAccess(domains: string[]): Promise<string[]>` (uses `browser.permissions.contains` with `*://<d>/*` and `*://*.<d>/*`), `syncBlockRules(domains: string[]): Promise<void>` (computes the redirect domains itself), `setUnlocked(domains: string[]): Promise<void>`, `clearUnlocked(): Promise<void>`, `isUnlocked(): Promise<boolean>`, `lockPageUrl(originalUrl: string): string`.
- Rule shapes (decided):
  - `RULE_REDIRECT`: priority 2, `condition: { requestDomains: redirectDomains, resourceTypes: ['main_frame'], regexFilter: '^(.*)$' }`, `action: { type: 'redirect', redirect: { regexSubstitution: lockPageBase + '#u=\\1' } }` where `lockPageBase = browser.runtime.getURL('/lock.html')`.
  - `RULE_FALLBACK_BLOCK`: priority 1, `condition: { requestDomains: domains, resourceTypes: ['main_frame', 'sub_frame'] }`, `action: { type: 'block' }`. Redirect must outrank block because block wins at equal priority.
  - `RULE_UNLOCK` (session rule): priority 3, `condition: { requestDomains: domains, resourceTypes: ['main_frame', 'sub_frame'] }`, `action: { type: 'allow' }`.
  - `lockPageUrl(u)` = `lockPageBase + '#u=' + u` (raw, same format the redirect produces).
  - `syncBlockRules([])` removes rules 1 and 2. Ruling (Task 5 e2e B9a, Chromium 158): Chrome picks the priority-2 redirect rule for a domain without host access, cannot apply it and does not fall back to the block rule, so the redirect rule lists only domains with host access (rule 1 is omitted when that list is empty) while the block rule lists all domains. `isUnlocked()` = a session rule with id 100 exists.

- [ ] **Step 1: Write the failing unit tests:** `buildBlockRules returns [] for no domains`; for `['example.test']` it returns exactly the two rule objects above (deep equal).
- [ ] **Step 2: Write the failing e2e tests** (call `syncBlockRules` / `setUnlocked` by `sw.evaluate` through a test-only global the background exposes only when `import.meta.env.MODE === 'e2e'`, e.g. `globalThis.__fmp = { syncBlockRules, setUnlocked, clearUnlocked }`):
  - B1: with `['example.test']`, `example.test`, `www.`, `m.`, upper-case and trailing-dot hosts land on `lock.html`; `notexample.test` and `example.test.notexample.test` show `ORIGINAL`.
  - Original URL: visiting `origin('www.example.test') + '/p?q=1#h'` lands on a URL whose hash is `#u=http://www.example.test:<port>/p?q=1` followed by the original fragment or not — assert only that it starts with `#u=http://www.example.test:<port>/p?q=1`.
  - B2: navigation started by a page on `other.test` (`location.href = …`) lands on `lock.html`.
  - B3: `setUnlocked` → `ORIGINAL`; `clearUnlocked` → `lock.html` on next navigation.
  - B4: after `relaunch()`, dynamic rules remain and `isUnlocked()` is false.
  - B6: `view-source:` of a locked page shows the lock page.
  - B9: with `['example.test', 'noperm.test']` (no host permission for `noperm.test` in the e2e build), `noperm.test` does not show `ORIGINAL` (navigation error); `origin('other.test') + '/frame'` shows the outer page but the `example.test` iframe does not load `ORIGINAL`.
- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement. **Step 5:** Run `npm test && npm run test:e2e` → PASS.
- [ ] **Gate:** if Chrome rejects the `regexSubstitution` to a `chrome-extension://` URL (an `updateDynamicRules` error or the redirect not happening), stop and report the exact error; do not switch designs alone.

### Task 6: Lock engine and background wiring

**Files:**
- Create: `src/lib/messages.ts`, `src/background/engine.ts`, `tests/unit/engine.test.ts`, `tests/e2e/engine.spec.ts`
- Modify: `entrypoints/background.ts`

**Interfaces:**
- Consumes: Tasks 2-5, `SETTINGS_GUARD_BUILD`.
- Produces in `src/lib/messages.ts`:

```ts
export type Request =
  | { type: 'getState' }
  | { type: 'setup'; password: string }
  | { type: 'unlock'; password: string; returnTo?: string }
  | { type: 'lockNow' }
  | { type: 'changePassword'; current: string; next: string };
export interface State { hasPassword: boolean; unlocked: boolean; waitMs: number; settingsGuardAvailable: boolean }
export type ErrorCode = 'wrong_password' | 'too_many_attempts' | 'too_short' | 'already_set' | 'not_set';
export type Response = { ok: true; state: State } | { ok: false; error: ErrorCode; state: State };
export function send(req: Request): Promise<Response>; // wraps browser.runtime.sendMessage
```

- Produces in `src/background/engine.ts`: `handleMessage(req: Request, sender: { tab?: { id?: number } }): Promise<Response>`, `relock(reason: 'idle' | 'screen' | 'windows' | 'manual'): Promise<void>`, `tabsToRelock<T extends { url?: string }>(tabs: T[], domains: string[]): T[]`, `applySettings(settings: Settings): Promise<void>` (sync rules, refresh unlock rule if unlocked, set idle interval), `isExtensionsPage(url: string): boolean` (`url.startsWith('chrome://extensions')`), `safeReturnTo(url: string | undefined, domains: string[]): string | null`.
- Behaviour (decided):
  - Rules are synced only when a password exists; otherwise `syncBlockRules([])`.
  - `unlock`: if `Date.now() < blockedUntil` → `too_many_attempts`. Wrong → `failures + 1`, `blockedUntil = now + backoffMs(failures + 1)`, `wrong_password`. Right → `failures = 0`, `setUnlocked(domains)`, then if `sender.tab?.id` and `safeReturnTo` is not null, `tabs.update(tabId, { url })`.
  - `safeReturnTo`: allow an `http(s)` URL whose host `hostMatches` a listed domain, or an extensions-page URL; anything else → `null`.
  - `relock`: `clearUnlocked()`, then for each tab from `tabsToRelock`: `tabs.create({ windowId, index, pinned, active, url: lockPageUrl(tab.url) })` then `tabs.remove(tab.id)` (spike B5: `tabs.update` leaves the page in back/forward cache).
  - Listeners registered at the top level of `background.ts`: `runtime.onInstalled` (open the options page on `install`), `runtime.onStartup` and module start (`applySettings(await getSettings())`), `idle.onStateChanged` (`idle` → relock; `locked` → relock if `lockOnScreenLock`), `windows.onRemoved` (relock when `windows.getAll({ windowTypes: ['normal'] })` is empty), `tabs.onUpdated` (when `SETTINGS_GUARD_BUILD && settings.settingsGuard && !unlocked && isExtensionsPage(changeInfo.url)` → `tabs.update(tabId, { url: lockPageUrl(changeInfo.url) })`), `storage.onChanged` (`settings` → `applySettings`), `permissions.onRemoved` (re-run `applySettings`, then open `options.html#permission-lost`), `permissions.onAdded` (re-run `applySettings`), `runtime.onMessage` (→ `handleMessage`).

- [ ] **Step 1: Write the failing unit tests** (stub `browser.declarativeNetRequest`, `browser.idle` with `vi.fn()` where fakeBrowser lacks them): `handleMessage` covers setup → `already_set` on the second call, `too_short`, wrong password increments failures, the fifth wrong answer sets `blockedUntil`, `too_many_attempts` while waiting, success resets failures and calls `setUnlocked`; `does not block before a password exists`; `resyncs rules and unlock rule when domains change`; `restores idle interval on worker start` (module start calls `idle.setDetectionInterval(300)` with defaults); `tabsToRelock` picks `www.example.test` and skips `notexample.test`; `safeReturnTo rejects foreign and non-http targets` (`javascript:alert(1)`, `https://evil.test/`, `undefined` → `null`; `http://m.example.test/x` and `chrome://extensions/?id=x` pass).
- [ ] **Step 2: Write the failing e2e tests:** `relock replaces tabs in place` (two windows, a pinned and an active locked tab, plus an unlocked `other.test` tab that must stay; after `lockNow` each locked tab is `lock.html` at the same window and index with the same pinned/active state and `history.length === 1`); `extensions page shows the lock page while locked` (B7) and opens normally while unlocked.
- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement. **Step 5:** Run `npm test && npm run test:e2e && npm run typecheck` → PASS.

### Task 7: Locales and i18n helper

**Files:**
- Create: `public/_locales/en/messages.json`, `public/_locales/ko/messages.json`, `public/_locales/ja/messages.json`, `src/lib/i18n.ts`, `tests/unit/locales.test.ts`

**Interfaces:**
- Produces: `t(key: string, subs?: string | string[]): string` (falls back to the key), `applyI18n(root?: ParentNode): void` (fills `[data-i18n]` text, `[data-i18n-placeholder]` placeholder, `[data-i18n-aria]` aria-label).
- Only this task writes the locale files. Keys and English copy (ko and ja are faithful translations in plain everyday words):

| Key | English |
| --- | --- |
| extName | For My Privacy: Site Password Lock |
| extShortName | For My Privacy |
| extDescription | Lock chosen sites and all their subdomains behind a password. It locks again when you step away. |
| lockTitle | This site is locked |
| lockSubtitle | Enter your password to open $1. |
| passwordLabel | Password |
| unlockButton | Unlock |
| wrongPassword | Wrong password. |
| tooManyAttempts | Too many attempts. Try again in $1. |
| unlockedNoReturn | Unlocked. You can open your site again. |
| openSettings | Settings |
| settingsLockedTitle | Settings are locked |
| setupTitle | Create a password |
| setupHint | Use at least 8 characters. It cannot be recovered; if you forget it, reinstall the extension. |
| confirmPasswordLabel | Confirm password |
| passwordMismatch | The passwords do not match. |
| passwordTooShort | Use at least 8 characters. |
| createButton | Create password |
| domainsTitle | Locked sites |
| domainsHint | Each site also locks all of its subdomains. |
| addDomainPlaceholder | example.com |
| addButton | Add |
| removeButton | Remove |
| emptyDomains | No sites yet. |
| invalidDomain | Enter a site address such as example.com. |
| permissionDenied | Chrome did not allow access to this site, so it was not added. |
| relatedSuggestion | Also lock $1? |
| idleTitle | Lock again automatically |
| idleMinutesLabel | Minutes without keyboard or mouse input |
| screenLockLabel | Lock when the screen locks |
| guardLabel | Ask for the password before Chrome's extensions page opens |
| guardHint | Removing the extension from the toolbar menu cannot be blocked. See the README. |
| changePasswordTitle | Change password |
| currentPasswordLabel | Current password |
| newPasswordLabel | New password |
| saveButton | Save |
| saved | Saved. |
| lockNowButton | Lock now |
| permissionLostTitle | Site access was removed |
| permissionLostBody | Locked sites stay blocked, but the lock screen cannot open for them. Grant access again. |
| grantButton | Grant access |

- [ ] **Step 1:** Write `tests/unit/locales.test.ts`: the three files have identical key sets, every message is a non-empty string, and `$1` appears in a translation exactly when it appears in English. Run → FAIL.
- [ ] **Step 2:** Create the files and `i18n.ts`. Run → PASS. Verify `npm run build` keeps `default_locale: "en"` and `__MSG_extName__` in the manifest.

### Task 8: Lock page

**Files:**
- Delete: `entrypoints/lock.html` (the Task 5 placeholder; WXT would build both to `/lock.html`)
- Create: `entrypoints/lock/index.html`, `entrypoints/lock/main.ts`, `entrypoints/lock/style.css`, `src/ui/base.css` (shared tokens: colours, spacing, light/dark via `prefers-color-scheme`), `tests/unit/lock-page.test.ts`, `tests/e2e/lock.spec.ts`

**Interfaces:**
- Consumes: `send` (Task 6), `t` / `applyI18n` (Task 7).
- Produces: `parseReturnTo(hash: string): string | undefined` in `entrypoints/lock/main.ts` (exported for the unit test): text after the first `#u=`, or `undefined`.
- Screen: lock icon, `lockTitle`, `lockSubtitle` with the host of `returnTo` (or nothing), one password field with a visible label, `unlockButton`, an error line with `role="alert"`, a countdown for `waitMs` that disables the button, a small `openSettings` link. Enter submits. Focus starts in the field. Calm, centred, no external fonts or images.
- On `ok: true` with no usable `returnTo` → show `unlockedNoReturn` (the worker navigates the tab when the target is safe).

- [ ] **Step 1:** Unit test `parseReturnTo` (`'#u=http://a.test/x#y'` → `'http://a.test/x#y'`; `''` and `'#x'` → `undefined`). E2E: wrong password shows `wrongPassword`; five wrong answers show the countdown and disable the button; the right password returns to the original URL; while locked, `chrome://extensions` → lock page → right password → back on the extensions page; `lock.html` with `#u=javascript:alert(1)` stays on the lock page and shows `unlockedNoReturn`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run `npm test && npm run test:e2e` → PASS.

### Task 9: Options page

**Files:**
- Create: `entrypoints/options/index.html`, `entrypoints/options/main.ts`, `entrypoints/options/style.css`, `tests/e2e/options.spec.ts`

**Interfaces:**
- Consumes: `send`, `getSettings` / `saveSettings`, `normalizeDomain` / `suggestRelated`, `t` / `applyI18n`, `SETTINGS_GUARD_BUILD`, `src/ui/base.css`.
- Three states from `getState`: no password → setup form (password + confirm, `passwordMismatch`, `passwordTooShort`); locked → the same password form as the lock page (unlock with no `returnTo`); unlocked → settings.
- Settings: domain list with remove buttons and `emptyDomains`; add field → `normalizeDomain` (else `invalidDomain`) → `browser.permissions.request({ origins: ['*://<d>/*', '*://*.<d>/*'] })` inside the click handler (else `permissionDenied`) → `saveSettings`; a `relatedSuggestion` chip per `suggestRelated` result; idle minutes number input 1-60; `screenLockLabel` and `guardLabel` switches (hide the guard switch when `!SETTINGS_GUARD_BUILD`); change-password form; `lockNowButton`; `saved` toast. `#permission-lost` shows `permissionLostTitle` / `permissionLostBody` with `grantButton` requesting the missing origins.
- Settings writes go straight through `saveSettings`; the worker reacts through `storage.onChanged`.

- [ ] **Step 1: Write the failing e2e tests:** setup with a 7-character password shows `passwordTooShort`; setup succeeds; adding `Example.TEST` lists `example.test` and `www.example.test` is then locked; `not a domain` shows `invalidDomain`; idle `0` saves as `1`; change password then unlock with the new one; `Lock now` relocks.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run `npm test && npm run test:e2e && npm run typecheck` → PASS.

### Task 10: READMEs, privacy, hardening, screenshots

**Files:**
- Create: `README.md` (English), `README.ko.md`, `README.ja.md`, `PRIVACY.md`, `CHANGELOG.md`, `THIRD_PARTY_LICENSES` (license texts of every package whose code ends up in `.output/chrome-mv3`; list how you found them), `docs/assets/banner.svg`, `docs/assets/screenshot-lock.png`, `docs/assets/screenshot-options.png`, `scripts/screenshots.ts`, `docs/hardening/macos/for-my-privacy-chrome.mobileconfig`, `docs/hardening/windows/for-my-privacy-chrome.reg`, `docs/manual-checks.md`

**Interfaces:**
- Consumes: the built extension and the e2e fixture approach (for screenshots).
- README layout, identical in all three languages:
  - Centred banner (`banner.svg`: lock mark + "For My Privacy"), then the language line `**English** · [한국어](README.ko.md) · [日本語](README.ja.md)` (the current language bold, the others linked), then shields.io badges: MIT license, version `0.1.0`, Manifest V3, Chrome.
  - One-line tagline, then the two screenshots side by side.
  - Sections: Features · How it works (a Mermaid flowchart: visit → redirect rule → lock page → password → session allow rule → idle/screen lock/last window/restart → relock) · Install (Chrome Web Store "coming soon"; load the release zip unpacked on macOS and Windows, step by step) · Use · What it protects and what it does not (honest list from spec sections 6-1 and 6-2: toolbar removal, launch flags and profile files, history titles, site notifications, DevTools) · Make it stronger with Chrome policies (inside `<details>`, links to the two hardening files, what each policy does, how to install on each OS) · Privacy (link `PRIVACY.md`) · Development (npm scripts) · Releasing (link `RELEASING.md`) · License.
  - Long sections in `<details>` so the page scans well on GitHub.
- `PRIVACY.md`: English, Korean and Japanese sections in one file; the extension stores the password hash, domain list and settings only in `chrome.storage.local` and sends nothing anywhere.
- Hardening files set `DeveloperToolsAvailability = 2` and `ExtensionInstallForcelist` with the placeholder `<EXTENSION_ID>;https://clients2.google.com/service/update2/crx`.
- `docs/manual-checks.md`: spec section 6-3 items as a checklist for macOS and Windows.
- `CHANGELOG.md`: Keep a Changelog format, `## [0.1.0] - <release date>` with the features.

- [ ] **Step 1:** `scripts/screenshots.ts` (run with `npx tsx`) launches the built extension like the e2e fixture, sets a demo password and domain, and saves both screenshots at 1280x800 in light mode. Run it; confirm both PNGs exist and look right (open them).
- [ ] **Step 2:** Write the docs. Verify every relative link and image path in the three READMEs exists (`node -e` or a small check script), and the Mermaid block is fenced as `mermaid`.

### Task 11: CI and release automation

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/workflows/submit.yml`, `scripts/check-version.mjs`, `scripts/changelog-section.mjs`, `RELEASING.md`
- Modify: `package.json` (scripts `release:patch`, `release:minor`, `release:major` = `npm version <level> -m "chore(release): v%s"`)

**Interfaces:**
- `ci.yml`: on push and pull_request; Node 24; `npm ci`, `typecheck`, `test`, `build`, `build:noguard`, `npx playwright install --with-deps chromium`, `test:e2e`.
- `release.yml`: on tags `v*`; `node scripts/check-version.mjs` (fails unless `GITHUB_REF_NAME === 'v' + package.json version`); `zip` and `zip:noguard`; `node scripts/changelog-section.mjs <version>` → notes file (fails when the section is missing); `gh release create "$GITHUB_REF_NAME" <both zips> --notes-file notes.md`; `permissions: contents: write`.
- `submit.yml`: `workflow_dispatch` only; builds the store zip and runs `wxt submit` for Chrome with Chrome Web Store API v2 service-account secrets. Check the exact variable names with `npx wxt submit --help` / WXT docs and list them in `RELEASING.md`. The first store upload is manual in the dashboard.

- [ ] **Step 1:** Unit-test the two scripts with `node --test` (`scripts/*.test.mjs`): version match passes and mismatch exits 1; the changelog section for `0.1.0` is extracted and a missing version exits 1. Run → FAIL, implement, run → PASS.
- [ ] **Step 2:** Validate the workflow YAML parses (`npx yaml-lint` or `node -e` with the `yaml` package) and `RELEASING.md` describes: bump with `npm run release:<level>`, push the commit and tag, the release appears with both zips, submit to the store by running `submit.yml` by hand.

### Task 12: Whole-branch review and release candidate

- [ ] **Step 1:** A fresh reviewer reads the spec, this plan and the full diff of `feature/v0.1.0`, with extra attention to Tasks 3, 5, 6 and the Review Focus list.
- [ ] **Step 2:** Fix what it confirms; rerun `npm run typecheck && npm test && npm run test:e2e && npm run build && npm run build:noguard`, all exit 0.
- [ ] **Step 3:** The orchestrator reports to the user how to load `.output/chrome-mv3` unpacked for hands-on checking, and waits for the word to create the GitHub repo and push.
