// Lock engine: unlock and relock decisions for the service worker. The unlock state lives only
// in the session allow rule (rules.ts), never in worker globals, so it survives worker restarts
// and disappears with the browser session. The rule's domains are the unlocked domains (all
// listed domains after an 'all' unlock, the ones unlocked one by one in 'site' scope) and its
// marker domain records the scope that created it.
import { browser } from 'wxt/browser';
import { hostMatches } from '../lib/domain';
import { SETTINGS_GUARD_BUILD } from '../lib/flags';
import type { ErrorCode, Request, Response, ResponseFor, State, TargetResponse } from '../lib/messages';
import { backoffMs, createRecord, validatePassword, verifyPassword } from '../lib/password';
import { isExtensionsPage, safeReturnTo } from '../lib/return-to';
import {
  clearUnlocked,
  domainsWithHostAccess,
  lockPageBase,
  lockPageToken,
  lockPageTokenUrl,
  readUnlock,
  setUnlocked,
  syncBlockRules,
  TOKEN_PATTERN,
  type UnlockRule,
} from '../lib/rules';
import { DEFAULT_SETTINGS, getAuth, getSettings as readSettings, saveAuth, type Settings } from '../lib/settings';

export { isExtensionsPage, safeReturnTo };

const MIN_IDLE_SECONDS = 15;
// storage.session key: when the screen locked without relocking (lockOnScreenLock off).
const SCREEN_LOCKED_AT_KEY = 'screenLockedAt';
// storage.session key: IDs of tabs that showed a page of a locked domain since the last relock.
// Such a tab keeps that page in its history (and maybe the back/forward cache, which needs no
// request), so a relock recreates it even when it has moved on to another site.
const SHOWN_LOCKED_KEY = 'shownLockedTabs';
// storage.session key: IDs of tabs whose page embedded a frame of a listed domain since the last
// relock. The host page itself is not private, so a relock reloads it (keeping its history) and
// the reload's frame request meets the block rule. A tab that then moves on to another page
// keeps the embedding page in its back/forward cache, so it moves to the shown-locked set.
const FRAME_HOSTS_KEY = 'frameHostTabs';
// storage.local key: origins of listed domains that tabs or frames ever showed (any subdomain or
// port). Kept apart from the tab IDs (a closed tab's site keeps its service worker) and across
// browser sessions (the worker lives on disk), so every relock and browser start removes their
// service workers; an origin is dropped once its domain is no longer listed.
const SHOWN_ORIGINS_KEY = 'shownLockedOrigins';
// storage.session key: true while the options page may show the settings. Separate from the
// site unlock: unlocking the settings never unlocks the sites, and the other way round.
const SETTINGS_UNLOCKED_KEY = 'settingsUnlocked';
// storage.session key prefix: one lock page target per token (`lockTarget:<token>`).
const TOKEN_KEY_PREFIX = 'lockTarget:';
// Longest wait for the site-data removal before a relock moves on (the removal keeps running).
const SITE_DATA_TIMEOUT_MS = 10_000;
// Wait before trying again to close a tab Chrome refuses to edit (e.g. while a tab is dragged).
const CLOSE_RETRY_MS = 500;

// Last settings read successfully. Only a fallback so a relock still sweeps tabs when storage
// fails; it is never used to decide whether the browser is unlocked.
let lastSettings: Settings | null = null;
// This worker's copies of the tab sets and the shown origins, so a failed storage read during
// a relock still covers what this worker recorded.
const shownLocked = new Set<number>();
const frameHosts = new Set<number>();
const shownOrigins = new Set<string>();

async function getSettings(): Promise<Settings> {
  const settings = await readSettings();
  lastSettings = settings;
  return settings;
}

/**
 * The stored settings, or the last known ones (else the defaults) when the read fails. `real`
 * says whether they were read now; only real settings may prune stored records.
 */
async function settingsOrFallback(): Promise<{ settings: Settings; real: boolean }> {
  try {
    return { settings: await getSettings(), real: true };
  } catch (err) {
    console.warn('for-my-privacy: settings read failed, using the last known settings', err);
    return { settings: lastSettings ?? DEFAULT_SETTINGS, real: false };
  }
}

/** Runs tasks one at a time in call order; a failed task does not stop the queue. */
function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}

// Password checks (getAuth → wait check → verify → saveAuth) run one at a time, so parallel
// attempts from several lock tabs cannot all read the same failure count and skip the wait.
const authQueue = serialQueue();
// Relocks, rule syncs and unlock-rule changes share one queue: overlapping relocks (idle and
// screen lock) replace each tab once, an older settings snapshot never overwrites a newer one,
// and a sync or an unlock that saw the unlock rule cannot re-create it after a relock cleared it.
const ruleQueue = serialQueue();

/** True only when storage positively says the settings are unlocked. */
async function isSettingsUnlocked(): Promise<boolean> {
  try {
    return (await browser.storage.session.get(SETTINGS_UNLOCKED_KEY))[SETTINGS_UNLOCKED_KEY] === true;
  } catch (err) {
    console.warn('for-my-privacy: could not read the settings unlock, treating it as locked', err);
    return false;
  }
}

async function setSettingsUnlocked(): Promise<void> {
  await browser.storage.session.set({ [SETTINGS_UNLOCKED_KEY]: true });
}

/** Locks the settings; when the key cannot be removed, overwrites it instead. */
async function clearSettingsUnlocked(): Promise<void> {
  try {
    await browser.storage.session.remove(SETTINGS_UNLOCKED_KEY);
  } catch (err) {
    console.warn('relock: could not clear the settings unlock, overwriting it', err);
    await browser.storage.session.set({ [SETTINGS_UNLOCKED_KEY]: false });
  }
}

// ---------------------------------------------------------------------------------------------
// Which domains are open

/** The unlock rule, or null while locked; a failed read counts as locked. Never throws. */
async function unlockOrLocked(): Promise<UnlockRule | null> {
  try {
    return await readUnlock();
  } catch (err) {
    console.warn('for-my-privacy: could not read the unlock rule, treating the sites as locked', err);
    return null;
  }
}

/**
 * The listed domains the unlock rule opens. A rule made under another scope than the current
 * setting opens nothing (the next settings sync relocks).
 */
export function openDomains(unlock: UnlockRule | null, settings: Settings): string[] {
  if (!unlock || unlock.scope !== settings.unlockScope) return [];
  return settings.domains.filter((d) => unlock.domains.includes(d));
}

/**
 * The extensions page counts as unlocked only after an unlock in 'all' scope (in 'site' scope
 * the guard stays on).
 */
function extensionsOpen(unlock: UnlockRule | null, settings: Settings): boolean {
  return unlock !== null && unlock.scope === 'all' && settings.unlockScope === 'all';
}

/** Wrong answers left before the first wait: 5 - failures, 0 once waits have started. */
export function triesLeft(failures: number): number {
  let n = 0;
  while (n < 100 && backoffMs(failures + n) === 0) n++;
  return n;
}

async function getState(): Promise<State> {
  const auth = await getAuth();
  const unlock = await readUnlock();
  let unlockedDomains: string[] = [];
  if (unlock) {
    try {
      unlockedDomains = openDomains(unlock, await getSettings());
    } catch (err) {
      console.warn('getState: settings read failed', err);
    }
  }
  return {
    hasPassword: auth.password !== null,
    unlocked: unlock !== null,
    unlockedDomains,
    settingsUnlocked: await isSettingsUnlocked(),
    waitMs: Math.max(0, auth.blockedUntil - Date.now()),
    triesLeft: triesLeft(auth.failures),
    settingsGuardAvailable: SETTINGS_GUARD_BUILD,
  };
}

async function ok(): Promise<Response> {
  return { ok: true, state: await getState() };
}

async function fail(error: ErrorCode): Promise<Response> {
  return { ok: false, error, state: await getState() };
}

type Check = 'ok' | 'not_set' | 'too_many_attempts' | 'wrong_password';

/** Checks `password` against the stored record and books a wrong answer. Call inside authQueue. */
async function checkPassword(password: string): Promise<Check> {
  const auth = await getAuth();
  if (!auth.password) return 'not_set';
  if (Date.now() < auth.blockedUntil) return 'too_many_attempts';
  if (!(await verifyPassword(password, auth.password))) {
    const failures = auth.failures + 1;
    await saveAuth({ failures, blockedUntil: Date.now() + backoffMs(failures) });
    return 'wrong_password';
  }
  return 'ok';
}

async function applyNow(settings: Settings): Promise<void> {
  const auth = await getAuth();
  // Nothing is blocked before a password exists (there would be no way to unlock).
  await syncBlockRules(auth.password ? settings.domains : []);
  const unlock = await readUnlock();
  if (unlock !== null) {
    if (unlock.scope !== settings.unlockScope) {
      // The unlock scope changed while unlocked: fail closed, everything locks again.
      await relockNow();
    } else if (settings.unlockScope === 'all') {
      await setUnlocked(settings.domains, 'all');
    } else {
      // 'site': only the domains unlocked one by one stay open; an added domain stays locked.
      const keep = openDomains(unlock, settings);
      if (keep.length === 0) await clearUnlocked();
      else if (keep.length !== unlock.domains.length) await setUnlocked(keep, 'site');
    }
  }
  await browser.idle.setDetectionInterval(Math.max(MIN_IDLE_SECONDS, settings.idleMinutes * 60));
  // Real settings (saved or read now): drop stored origins of domains no longer listed.
  await listedShownOrigins(settings.domains, true);
}

/** Syncs the block rules, refreshes the unlock rule when unlocked and sets the idle interval. */
export function applySettings(settings: Settings): Promise<void> {
  return ruleQueue(() => applyNow(settings));
}

/** applySettings with the settings read when its turn comes (for event listeners). */
export function resync(): Promise<void> {
  return ruleQueue(async () => applyNow(await getSettings()));
}

const VIEW_SOURCE = 'view-source:';

function parseHttp(url: string | undefined): { inner: string; parsed: URL } | null {
  if (!url) return null;
  const inner = url.startsWith(VIEW_SOURCE) ? url.slice(VIEW_SOURCE.length) : url;
  let parsed: URL;
  try {
    parsed = new URL(inner);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return { inner, parsed };
}

/**
 * `url` (without a view-source: prefix) when it is an http(s) page on one of `domains` and on
 * none of the `open` ones (the unlock rule lets those through), else null.
 */
function lockedTarget(url: string | undefined, domains: string[], open: string[] = []): string | null {
  const p = parseHttp(url);
  if (!p) return null;
  const host = p.parsed.hostname;
  if (!domains.some((d) => hostMatches(host, d))) return null;
  if (open.some((d) => hostMatches(host, d))) return null;
  return p.inner;
}

/** The origin of `url` (after any view-source: prefix) when it is http(s), else null. */
function httpOrigin(url: string | undefined): string | null {
  return parseHttp(url)?.parsed.origin ?? null;
}

/** The listed domain `url` belongs to (http(s) only), else null. */
function listedDomainOf(url: string, domains: string[]): string | null {
  const host = parseHttp(url)?.parsed.hostname;
  if (host === undefined) return null;
  return domains.find((d) => hostMatches(host, d)) ?? null;
}

/**
 * Origins whose service workers and caches a relock removes: http and https for each listed
 * domain and its `www.` and `m.` hosts, plus `extra` (origins tabs showed, any port or host).
 */
export function siteDataOrigins(domains: string[], extra: Iterable<string> = []): string[] {
  const origins = new Set<string>();
  for (const d of domains) {
    for (const host of [d, `www.${d}`, `m.${d}`]) {
      origins.add(`http://${host}`);
      origins.add(`https://${host}`);
    }
  }
  for (const o of extra) {
    const origin = httpOrigin(o);
    if (origin) origins.add(origin);
  }
  return [...origins];
}

/**
 * Removes the service workers and CacheStorage (never cookies or other data) of `origins`, so
 * a site cannot answer a navigation from its cache, which declarativeNetRequest never sees.
 * Never throws; returns false when the removal failed or took too long.
 */
async function removeSiteData(origins: string[]): Promise<boolean> {
  if (origins.length === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), SITE_DATA_TIMEOUT_MS);
  });
  const removal = (async () => {
    await browser.browsingData.remove(
      // protectedWeb too: an installed web app's origin is "protected" and skipped otherwise.
      { origins: origins as [string, ...string[]], originTypes: { unprotectedWeb: true, protectedWeb: true } },
      { serviceWorkers: true, cacheStorage: true },
    );
    return true;
  })().catch((err: unknown) => {
    console.warn('relock: could not remove the service workers and caches of the locked sites', err);
    return false;
  });
  try {
    const done = await Promise.race([removal, timeout]);
    if (!done) console.warn('relock: removing the locked sites\' service workers failed or is still running');
    return done;
  } finally {
    clearTimeout(timer);
  }
}

/** Tabs showing (or loading) a page of a locked domain, including view-source of one. */
export function tabsToRelock<T extends { url?: string; pendingUrl?: string }>(
  tabs: T[],
  domains: string[],
  open: string[] = [],
): T[] {
  return tabs.filter(
    (t) => lockedTarget(t.url, domains, open) !== null || lockedTarget(t.pendingUrl, domains, open) !== null,
  );
}

type Tab = Browser.tabs.Tab;

// ---------------------------------------------------------------------------------------------
// Recorded tabs and origins (fail closed: storage failures fall back to this worker's copies)

type TabSet = { ids: Set<number>; complete: boolean };

/** The stored tab set joined with this worker's copy. Never throws. */
async function readTabSet(key: string, memory: Set<number>): Promise<TabSet> {
  const ids = new Set(memory);
  try {
    const stored: unknown = (await browser.storage.session.get(key))[key];
    if (Array.isArray(stored)) for (const id of stored) if (typeof id === 'number') ids.add(id);
    return { ids, complete: true };
  } catch (err) {
    console.warn(`tabs: could not read ${key}`, err);
    return { ids, complete: false };
  }
}

/** Saves the set; after an incomplete read only this worker's copy changes, so stored IDs stay. */
async function writeTabSet(key: string, memory: Set<number>, { ids, complete }: TabSet): Promise<void> {
  memory.clear();
  for (const id of ids) memory.add(id);
  if (complete) await browser.storage.session.set({ [key]: [...ids] });
}

async function clearTabSet(key: string, memory: Set<number>): Promise<void> {
  memory.clear();
  await browser.storage.session.remove(key).catch((err) => console.warn('relock: clear failed', err));
}

const readShownLocked = () => readTabSet(SHOWN_LOCKED_KEY, shownLocked);
const writeShownLocked = (set: TabSet) => writeTabSet(SHOWN_LOCKED_KEY, shownLocked, set);
const readFrameHosts = () => readTabSet(FRAME_HOSTS_KEY, frameHosts);
const writeFrameHosts = (set: TabSet) => writeTabSet(FRAME_HOSTS_KEY, frameHosts, set);

/** The stored shown origins joined with this worker's copy. Never throws. */
async function readShownOrigins(): Promise<{ origins: Set<string>; complete: boolean }> {
  const origins = new Set(shownOrigins);
  try {
    const stored: unknown = (await browser.storage.local.get(SHOWN_ORIGINS_KEY))[SHOWN_ORIGINS_KEY];
    if (Array.isArray(stored)) for (const o of stored) if (typeof o === 'string') origins.add(o);
    return { origins, complete: true };
  } catch (err) {
    console.warn('tabs: could not read the origins of locked sites tabs showed', err);
    return { origins, complete: false };
  }
}

async function writeShownOrigins({ origins, complete }: { origins: Set<string>; complete: boolean }) {
  shownOrigins.clear();
  for (const o of origins) shownOrigins.add(o);
  if (complete) await browser.storage.local.set({ [SHOWN_ORIGINS_KEY]: [...origins] });
}

const hostOf = (origin: string): string | null => {
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
};

/**
 * The shown origins whose host is on one of `domains`. With `prune` (only for settings that
 * were really read or saved, never the fallback), origins of domains no longer listed are
 * dropped from storage too (best effort; a failed write is logged). Never throws.
 */
async function listedShownOrigins(domains: string[], prune: boolean): Promise<string[]> {
  const set = await readShownOrigins();
  const listed = new Set(
    [...set.origins].filter((o) => {
      const host = hostOf(o);
      return host !== null && domains.some((d) => hostMatches(host, d));
    }),
  );
  if (prune && listed.size !== set.origins.size) {
    await writeShownOrigins({ origins: listed, complete: set.complete }).catch((err) =>
      console.warn('relock: could not prune the shown origins', err),
    );
  }
  return [...listed];
}

/** Adds `origin` to the shown origins. Throws when it cannot be stored. */
async function addShownOrigin(origin: string): Promise<void> {
  if (shownOrigins.has(origin)) return;
  const set = await readShownOrigins();
  set.origins.add(origin);
  await writeShownOrigins(set);
}

/**
 * Records `tabId` in a tab set and `origin` (when known; null when the domain list could not be
 * read, so no other site's data is ever removed) in the shown origins. The tab ID is recorded
 * even when the origin cannot be stored. Runs in ruleQueue, after any relock.
 */
function trackTab(
  read: () => Promise<TabSet>,
  write: (set: TabSet) => Promise<void>,
  memory: Set<number>,
  tabId: number,
  origin: string | null,
): Promise<void> {
  return ruleQueue(async () => {
    let originError: unknown = null;
    if (origin !== null) {
      try {
        await addShownOrigin(origin);
      } catch (err) {
        originError = err;
      }
    }
    if (!memory.has(tabId)) {
      const set = await read();
      set.ids.add(tabId);
      await write(set);
    }
    if (originError) throw originError;
  });
}

const trackShownLocked = (tabId: number, origin: string | null) =>
  trackTab(readShownLocked, writeShownLocked, shownLocked, tabId, origin);
const trackFrameHost = (tabId: number, origin: string | null) =>
  trackTab(readFrameHosts, writeFrameHosts, frameHosts, tabId, origin);

// ---------------------------------------------------------------------------------------------
// Lock page targets (tokens)

/**
 * A lock page target. `source` 'engine': a lock tab the service worker opened (relock sweep,
 * tab guard, start sweep); only those are restored by another tab's unlock, and only those may
 * target the extensions page. 'claimed': a target a lock page claimed from its `#u=` URL.
 * `tabId` is the tab the token belongs to (null until the new tab exists).
 */
interface TokenRecord {
  url: string;
  tabId: number | null;
  source: 'engine' | 'claimed';
}

// This worker's copy of the records (a failed storage write still leaves the token usable) and
// the bindings still waiting for their new tab's ID.
const tokenMemory = new Map<string, TokenRecord>();
const pendingBindings = new Map<string, Promise<void>>();

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function writeToken(token: string, record: TokenRecord): Promise<void> {
  tokenMemory.set(token, record);
  try {
    await browser.storage.session.set({ [TOKEN_KEY_PREFIX + token]: record });
  } catch (err) {
    console.warn('lock page: could not store a target', err);
  }
}

function isTokenRecord(value: unknown): value is TokenRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.url === 'string' &&
    (v.tabId === null || typeof v.tabId === 'number') &&
    (v.source === 'engine' || v.source === 'claimed')
  );
}

/** The record of `token` once its binding is done (stored, else this worker's copy). */
async function readToken(token: string): Promise<TokenRecord | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  await pendingBindings.get(token);
  try {
    const stored: unknown = (await browser.storage.session.get(TOKEN_KEY_PREFIX + token))[TOKEN_KEY_PREFIX + token];
    if (isTokenRecord(stored)) return stored;
  } catch (err) {
    console.warn('lock page: could not read a target', err);
  }
  return tokenMemory.get(token) ?? null;
}

async function deleteTokens(tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  for (const t of tokens) tokenMemory.delete(t);
  await browser.storage.session
    .remove(tokens.map((t) => TOKEN_KEY_PREFIX + t))
    .catch((err) => console.warn('lock page: could not delete targets', err));
}

/** Drops the tokens of a closed tab. Never throws. */
async function forgetTokensOf(tabId: number): Promise<void> {
  const tokens = new Set<string>();
  for (const [t, r] of tokenMemory) if (r.tabId === tabId) tokens.add(t);
  try {
    const all = await browser.storage.session.get(null);
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith(TOKEN_KEY_PREFIX) && isTokenRecord(value) && value.tabId === tabId) {
        tokens.add(key.slice(TOKEN_KEY_PREFIX.length));
      }
    }
  } catch (err) {
    console.warn('tabs: could not list the lock page targets', err);
  }
  await deleteTokens([...tokens]);
}

/** A lock page URL for a tab that already exists, its token bound to `tabId`. */
async function engineLockUrlFor(tabId: number, target: string): Promise<string> {
  if (!target) return lockPageBase();
  const token = newToken();
  await writeToken(token, { url: target, tabId, source: 'engine' });
  return lockPageTokenUrl(token);
}

/** What the lock page may show for a target: its host, or the extensions page. */
function hostLabel(url: string): string {
  if (isExtensionsPage(url)) return 'chrome://extensions';
  return parseHttp(url)?.parsed.hostname ?? '';
}

/**
 * The URL a token may return to: an http(s) URL on a listed domain, or the extensions page for
 * a target the service worker created itself. Null otherwise.
 */
function safeTokenTarget(record: TokenRecord, domains: string[]): string | null {
  const url = safeReturnTo(record.url, domains);
  if (url === null) return null;
  if (url.startsWith('chrome:') && record.source !== 'engine') return null;
  return url;
}

// ---------------------------------------------------------------------------------------------
// Replacing tabs

async function closeTab(tab: Tab & { id: number }, returnTo: string): Promise<void> {
  try {
    await browser.tabs.remove(tab.id);
    return;
  } catch (err) {
    console.warn('relock: could not close a tab, trying again', err);
  }
  await new Promise((resolve) => setTimeout(resolve, CLOSE_RETRY_MS));
  try {
    await browser.tabs.remove(tab.id);
    return;
  } catch (err) {
    console.warn('relock: could not close a tab, sending it to the lock page', err);
  }
  // Last resort: the page at least leaves the screen, though this tab keeps its history.
  try {
    await browser.tabs.update(tab.id, { url: await engineLockUrlFor(tab.id, returnTo) });
  } catch (err) {
    console.warn('relock: could not send a tab to the lock page', err);
  }
}

/**
 * Opens `url` (the new tab page when undefined) in a new tab at `tab`'s place, then closes `tab`.
 * A new tab, not tabs.update: an updated tab keeps the page in the back/forward cache, so Back
 * would show it again (spike B5). The original is closed even if the replacement fails. Returns
 * the new tab's ID (undefined when it could not be opened).
 */
async function recreateTab(tab: Tab, url: string | undefined, returnTo: string): Promise<number | undefined> {
  if (tab.id === undefined) return undefined;
  let created: number | undefined;
  try {
    created = (
      await browser.tabs.create({
        windowId: tab.windowId,
        index: tab.index,
        pinned: tab.pinned,
        active: tab.active,
        ...(url === undefined ? {} : { url }),
      })
    )?.id;
  } catch (err) {
    console.warn('relock: could not open the replacement tab', err);
  }
  await closeTab(tab as Tab & { id: number }, returnTo);
  return created;
}

/**
 * Replaces `tab` with a lock page for `target`. The page carries only a token; the target stays
 * in the service worker, bound to the new tab once it exists (a request that arrives before that
 * waits for the binding).
 */
async function replaceWithLockPage(tab: Tab, target: string): Promise<void> {
  const token = newToken();
  let done!: () => void;
  pendingBindings.set(token, new Promise<void>((resolve) => (done = resolve)));
  try {
    await writeToken(token, { url: target, tabId: null, source: 'engine' });
    const created = await recreateTab(tab, lockPageTokenUrl(token), target);
    if (created === undefined) await deleteTokens([token]);
    else await writeToken(token, { url: target, tabId: created, source: 'engine' });
  } finally {
    pendingBindings.delete(token);
    done();
  }
}

function guardActive(settings: Settings): boolean {
  return SETTINGS_GUARD_BUILD && settings.settingsGuard;
}

async function queryTabs(): Promise<Tab[] | null> {
  try {
    return await browser.tabs.query({});
  } catch (err) {
    console.warn('relock: could not list tabs', err);
    return null;
  }
}

/** False only when storage positively says no password exists; a failed read counts as set. */
async function passwordMaybeSet(): Promise<boolean> {
  try {
    return (await getAuth()).password !== null;
  } catch (err) {
    console.warn('relock: auth read failed, treating the password as set', err);
    return true;
  }
}

/** Reloads a tab that hosted a frame of a locked site; when that fails, recreates it. */
async function reloadFrameHost(tab: Tab): Promise<void> {
  if (tab.id === undefined) return;
  try {
    await browser.tabs.reload(tab.id);
    return;
  } catch (err) {
    console.warn('relock: could not reload a tab that showed a locked site in a frame', err);
  }
  const url = tab.pendingUrl || tab.url || undefined;
  await recreateTab(tab, url, url ?? '');
}

export type RelockReason = 'idle' | 'screen' | 'windows' | 'manual' | 'update' | 'command';

/**
 * Clears the unlock rule and replaces every open tab of a locked domain with the lock page.
 * Fails closed: a storage or tabs error after the rule is cleared still sweeps the tabs (with the
 * last known settings), and the first error is rethrown only after the sweep.
 */
export function relock(reason: RelockReason): Promise<void> {
  void reason;
  return ruleQueue(() => relockNow());
}

/** The relock itself; call inside ruleQueue. */
async function relockNow(): Promise<void> {
  // The sweep uses a listing taken after the rule is cleared, so a tab that opened or started
  // loading a locked site meanwhile is included. The listing taken before is only a fallback
  // for when the later one fails.
  const before = await queryTabs();
  let firstError: unknown = null;
  try {
    await clearUnlocked();
  } catch (err) {
    firstError = err;
  }
  try {
    await clearSettingsUnlocked();
  } catch (err) {
    firstError ??= err;
  }
  if (await passwordMaybeSet()) {
    const { settings, real } = await settingsOrFallback();
    const tabs = (await queryTabs()) ?? before ?? [];
    // Runs alongside the sweep; a failure is logged and the rules and the sweep still apply.
    const removed = removeSiteData(await siteDataOriginsNow(settings.domains, tabs, real));
    const reload = await sweepTabs(tabs, settings, (await readShownLocked()).ids, (await readFrameHosts()).ids);
    await clearTabSet(SHOWN_LOCKED_KEY, shownLocked);
    await clearTabSet(FRAME_HOSTS_KEY, frameHosts);
    // Frames get no tab guard, and a frame the site's service worker answers never meets the
    // block rule, so the hosts are reloaded only once the removal finished (or gave up).
    await removed;
    for (const tab of reload) await reloadFrameHost(tab);
  }
  if (firstError) throw firstError;
}

/** Listed domains' origins, the listed shown origins and the open locked tabs' origins. */
async function siteDataOriginsNow(domains: string[], tabs: Tab[], prune: boolean): Promise<string[]> {
  const tabOrigins = tabsToRelock(tabs, domains)
    .flatMap((t) => [lockedTarget(t.url, domains), lockedTarget(t.pendingUrl, domains)])
    .filter((u) => u !== null);
  return siteDataOrigins(domains, [...(await listedShownOrigins(domains, prune)), ...tabOrigins]);
}

/** Sweeps the tabs after a relock; returns the frame hosts left to reload. */
async function sweepTabs(tabs: Tab[], settings: Settings, shown: Set<number>, framed: Set<number>): Promise<Tab[]> {
  const locked = new Set(tabsToRelock(tabs, settings.domains));
  const reload: Tab[] = [];
  // Replacing a tab keeps every index stable, so tabs are handled in their original order.
  for (const tab of tabs) {
    let target: string | null = null;
    if (locked.has(tab)) {
      target = lockedTarget(tab.url, settings.domains) ?? lockedTarget(tab.pendingUrl, settings.domains);
    } else if (guardActive(settings) && tab.url && isExtensionsPage(tab.url)) {
      // An extensions page left open while unlocked would stay usable after relocking.
      target = tab.url;
    }
    if (target) {
      await replaceWithLockPage(tab, target);
    } else if (tab.id !== undefined && shown.has(tab.id)) {
      // It showed a locked site earlier and moved on: same page, but in a tab with no history.
      // If it cannot be closed, closeTab's last resort sends it to the lock page.
      const url = tab.pendingUrl || tab.url || undefined;
      await recreateTab(tab, url, url ?? '');
    } else if (tab.id !== undefined && framed.has(tab.id)) {
      reload.push(tab);
    }
  }
  return reload;
}

/**
 * Worker start and browser start: re-applies the settings and, while the extensions page counts
 * as locked with the guard on, sends any open extensions page to the lock page (a
 * session-restored tab may never fire tabs.onUpdated with a url). An existing unlock is kept.
 */
export function onWorkerStart(): Promise<void> {
  return ruleQueue(() => workerStartNow());
}

async function workerStartNow(): Promise<void> {
  const settings = await getSettings();
  await applyNow(settings);
  if (!guardActive(settings) || !(await getAuth()).password) return;
  if (extensionsOpen(await unlockOrLocked(), settings)) return;
  const tabs = (await browser.tabs.query({})).filter((t) => t.url && isExtensionsPage(t.url));
  for (const tab of tabs) await replaceWithLockPage(tab, tab.url!);
}

/**
 * Browser start, in one ruleQueue step: the worker-start work, then every open or
 * session-restored tab of a locked domain goes to the lock page (a restored tab may have been
 * answered by the site's service worker, which the rules never see) and the locked sites'
 * service workers and caches are removed (they live on disk and survive the restart). The
 * restricted steps run with the last known settings even when the worker-start work fails.
 */
export function onBrowserStart(): Promise<void> {
  return ruleQueue(async () => {
    let firstError: unknown = null;
    try {
      await workerStartNow();
    } catch (err) {
      firstError = err;
    }
    if (await passwordMaybeSet()) {
      const { settings, real } = await settingsOrFallback();
      const open = openDomains(await unlockOrLocked(), settings);
      const locked = settings.domains.filter((d) => !open.includes(d));
      if (locked.length > 0) {
        const tabs = (await queryTabs()) ?? [];
        const origins = await siteDataOriginsNow(settings.domains, tabs, real);
        // Origins of open domains keep their workers.
        const removed = removeSiteData(
          origins.filter((o) => {
            const host = hostOf(o);
            return host !== null && !open.some((d) => hostMatches(host, d));
          }),
        );
        for (const tab of tabsToRelock(tabs, settings.domains, open)) {
          const target =
            lockedTarget(tab.url, settings.domains, open) ?? lockedTarget(tab.pendingUrl, settings.domains, open);
          if (target) await replaceWithLockPage(tab, target);
        }
        await removed;
      }
    }
    if (firstError) throw firstError;
  });
}

// ---------------------------------------------------------------------------------------------
// Messages

export interface Sender {
  tab?: { id?: number };
  frameId?: number;
  /** The sending page's URL (Chrome sets it; a lock page's own `#t=` or `#u=` URL). */
  url?: string;
}

// lock.html is web-accessible, so a web page can frame it. A message from a tab must come from
// its top frame; one without a tab (an extension page not in a tab) has nothing to navigate.
function fromTopFrame(sender: Sender): boolean {
  return sender.tab === undefined || sender.frameId === 0;
}

/**
 * The target of the unlocking lock page: from its token (sent, else the one in the sender's
 * URL) when the token belongs to that tab, else the old raw `returnTo` (http(s) only). Null
 * when there is none or it is not safe. Also returns the token to delete after use.
 */
async function unlockTarget(
  req: { token?: string; returnTo?: string },
  sender: Sender,
  domains: string[],
): Promise<{ url: string | null; token: string | null }> {
  const tabId = sender.tab?.id;
  const token = req.token ?? lockPageToken(sender.url) ?? null;
  if (token !== null) {
    const record = await readToken(token);
    if (!record || tabId === undefined || record.tabId !== tabId) return { url: null, token: null };
    return { url: safeTokenTarget(record, domains), token };
  }
  const raw = safeReturnTo(req.returnTo, domains);
  return { url: raw !== null && !raw.startsWith('chrome:') ? raw : null, token: null };
}

/** Whether `url` may be opened now: an open domain's page, or the extensions page when open. */
function reachable(url: string, settings: Settings, unlock: UnlockRule | null): boolean {
  if (url.startsWith('chrome:')) return extensionsOpen(unlock, settings);
  return lockedTarget(url, settings.domains, openDomains(unlock, settings)) === null;
}

/**
 * After an unlock, sends every other lock tab the service worker opened (never one that claimed
 * an arbitrary `#u=` target) back to its target, when that target is open now.
 */
async function returnLockTabs(settings: Settings, unlock: UnlockRule | null, senderTabId: number | undefined) {
  let tabs: Tab[];
  try {
    tabs = await browser.tabs.query({});
  } catch (err) {
    console.warn('unlock: could not list the lock tabs', err);
    return;
  }
  const used: string[] = [];
  for (const tab of tabs) {
    if (tab.id === undefined || tab.id === senderTabId) continue;
    const token = lockPageToken(tab.url);
    if (token === undefined) continue;
    const record = await readToken(token);
    if (!record || record.source !== 'engine' || record.tabId !== tab.id) continue;
    const url = safeTokenTarget(record, settings.domains);
    if (url === null || !reachable(url, settings, unlock)) continue;
    used.push(token);
    await browser.tabs.update(tab.id, { url }).catch((err) => console.warn('unlock: return failed', err));
  }
  await deleteTokens(used);
}

async function targetAnswer(token: string, url: string): Promise<TargetResponse> {
  return { ok: true, state: await getState(), token, host: hostLabel(url) };
}

/**
 * Sends lock tab `tabId` to its own target when that target is open now (an unlock in another
 * tab opened its domain, or every domain in 'all' scope). The token must belong to that tab; the
 * target must be on a listed domain, and the extensions page only for a token the worker made.
 * This brings back the lock tabs that another tab's unlock does not restore (claimed tokens).
 * Never throws; returns true when the tab was sent back.
 */
async function returnIfOpen(tabId: number, token: string): Promise<boolean> {
  try {
    const record = await readToken(token);
    if (!record || record.tabId !== tabId) return false;
    const settings = await getSettings();
    const url = safeTokenTarget(record, settings.domains);
    if (url === null) return false;
    // In ruleQueue: a relock running now finishes first, and the rule is read after it.
    const sent = await ruleQueue(async () => {
      if (!reachable(url, settings, await unlockOrLocked())) return false;
      await browser.tabs.update(tabId, { url });
      return true;
    });
    if (sent) await deleteTokens([token]);
    return sent;
  } catch (err) {
    console.warn('lock page: could not send a tab back to its open site', err);
    return false;
  }
}

/** tabs.onActivated: a lock tab brought to the front goes back to its site if it is open now. */
export async function onTabActivated(info: { tabId: number }): Promise<void> {
  let tab: Tab | undefined;
  try {
    tab = await browser.tabs.get(info.tabId);
  } catch {
    return; // closed meanwhile
  }
  const token = lockPageToken(tab?.url);
  if (token !== undefined) await returnIfOpen(info.tabId, token);
}

export async function handleMessage<R extends Request>(req: R, sender: Sender): Promise<ResponseFor<R>> {
  return (await handle(req, sender)) as ResponseFor<R>;
}

async function handle(req: Request, sender: Sender): Promise<Response | TargetResponse> {
  switch (req.type) {
    case 'getState':
      return ok();

    case 'setup':
      return authQueue(async () => {
        if ((await getAuth()).password) return fail('already_set');
        if (validatePassword(req.password) !== 'ok') return fail('too_short');
        await saveAuth({ password: await createRecord(req.password), failures: 0, blockedUntil: 0 });
        // The person who just chose the password may use the settings; the sites stay locked.
        await setSettingsUnlocked();
        await applySettings(await getSettings());
        return ok();
      });

    case 'unlock': {
      // Unlocks the sites only; the settings have their own unlock (unlockSettings).
      // A framed lock page is ignored: no attempt counted, nothing unlocked or navigated.
      if (!fromTopFrame(sender)) return fail('wrong_password');
      const result = await authQueue(async () => {
        const check = await checkPassword(req.password);
        if (check !== 'ok') return { check, target: null };
        await saveAuth({ failures: 0, blockedUntil: 0 });
        const settings = await getSettings();
        const target = await unlockTarget(req, sender, settings.domains);
        await ruleQueue(async () => {
          if (settings.unlockScope === 'all') {
            await setUnlocked(settings.domains, 'all');
            return;
          }
          // 'site': this lock page's own domain joins the domains unlocked so far.
          const domain = target.url === null ? null : listedDomainOf(target.url, settings.domains);
          if (domain === null) return;
          const current = openDomains(await unlockOrLocked(), settings);
          await setUnlocked([...new Set([...current, domain])], 'site');
        });
        return { check, target };
      });
      if (result.check !== 'ok') return fail(result.check);
      const tabId = sender.tab?.id;
      const settings = await getSettings();
      const unlock = await unlockOrLocked();
      const { url, token } = result.target!;
      if (tabId !== undefined && url !== null && reachable(url, settings, unlock)) {
        await browser.tabs.update(tabId, { url }).catch((err) => console.warn('unlock: return failed', err));
        if (token !== null) await deleteTokens([token]);
      }
      await returnLockTabs(settings, unlock, tabId);
      return ok();
    }

    case 'unlockSettings': {
      // Same checks and wait as `unlock`, but it opens the settings only: no unlock rule, no navigation.
      if (!fromTopFrame(sender)) return fail('wrong_password');
      const result = await authQueue(async () => {
        const check = await checkPassword(req.password);
        if (check !== 'ok') return check;
        await saveAuth({ failures: 0, blockedUntil: 0 });
        await setSettingsUnlocked();
        return check;
      });
      return result === 'ok' ? ok() : fail(result);
    }

    case 'claimTarget': {
      // Only the dNR redirect produces `#u=`; anything else in that text is refused. A claimed
      // target is never restored by another tab's unlock and never the extensions page.
      const tabId = sender.tab?.id;
      if (!fromTopFrame(sender) || tabId === undefined) return fail('invalid_target');
      const url = safeReturnTo(req.raw, (await getSettings()).domains);
      if (url === null || url.startsWith('chrome:')) return fail('invalid_target');
      const token = newToken();
      await writeToken(token, { url, tabId, source: 'claimed' });
      const answer = await targetAnswer(token, url);
      // Redirected just before an unlock elsewhere opened the site: go straight there (after
      // the answer, which must not wait for a relock in progress).
      void returnIfOpen(tabId, token);
      return answer;
    }

    case 'describeTarget': {
      const tabId = sender.tab?.id;
      if (!fromTopFrame(sender) || tabId === undefined) return fail('invalid_target');
      const record = await readToken(req.token);
      if (!record || record.tabId !== tabId) return fail('invalid_target');
      const url = safeTokenTarget(record, (await getSettings()).domains);
      if (url === null) return fail('invalid_target');
      const answer = await targetAnswer(req.token, url);
      // The lock page asks again (load, reload) while its site is open: send it back (after
      // the answer, which must not wait for a relock in progress).
      void returnIfOpen(tabId, req.token);
      return answer;
    }

    case 'lockNow':
      await relock('manual');
      return ok();

    case 'changePassword':
      return authQueue(async () => {
        if (validatePassword(req.next) !== 'ok') {
          return fail((await getAuth()).password ? 'too_short' : 'not_set');
        }
        const check = await checkPassword(req.current);
        if (check !== 'ok') return fail(check);
        await saveAuth({ password: await createRecord(req.next), failures: 0, blockedUntil: 0 });
        return ok();
      });
  }
}

// ---------------------------------------------------------------------------------------------
// Listener bodies, registered at the top level of entrypoints/background.ts.

export async function onInstalled(details: { reason: string }): Promise<void> {
  if (details.reason === 'install') await browser.runtime.openOptionsPage();
  // An update or reload drops the session unlock rule, but open tabs of locked sites stay as they
  // were until the next relock, so sweep them now (relock does nothing before a password exists).
  if (details.reason === 'update') await relock('update');
}

/** The `lock-now` keyboard command: a relock, no password needed (like lockNow). */
export async function onCommand(command: string): Promise<void> {
  if (command === 'lock-now') await relock('command');
}

export async function onIdleStateChanged(state: string): Promise<void> {
  if (state === 'idle') {
    await browser.storage.session.remove(SCREEN_LOCKED_AT_KEY).catch(() => {});
    return relock('idle');
  }
  if (state === 'locked') {
    let lockOnScreenLock = true;
    try {
      lockOnScreenLock = (await getSettings()).lockOnScreenLock;
    } catch (err) {
      console.warn('idle: settings read failed, relocking', err);
    }
    if (lockOnScreenLock) return relock('screen');
    // While the screen is locked Chrome reports `locked`, never `idle`, so time it here.
    // If the time cannot be stored, the lock could not be timed: relock now instead.
    try {
      await browser.storage.session.set({ [SCREEN_LOCKED_AT_KEY]: Date.now() });
    } catch (err) {
      console.warn('idle: could not store the screen lock time, relocking', err);
      return relock('screen');
    }
    return;
  }
  if (state === 'active') {
    let lockedAt: unknown;
    try {
      lockedAt = (await browser.storage.session.get(SCREEN_LOCKED_AT_KEY))[SCREEN_LOCKED_AT_KEY];
    } catch (err) {
      // The stored time cannot be read, so a long screen lock cannot be ruled out.
      console.warn('idle: could not read the screen lock time, relocking', err);
      return relock('idle');
    }
    if (typeof lockedAt !== 'number') return;
    const { idleMinutes } = (await settingsOrFallback()).settings;
    const expired = Date.now() - lockedAt > idleMinutes * 60_000;
    // Decide first, then clear; a failed clear must not skip the relock.
    await browser.storage.session.remove(SCREEN_LOCKED_AT_KEY).catch((err) => console.warn('idle: clear failed', err));
    if (expired) return relock('idle');
  }
}

export async function onWindowRemoved(): Promise<void> {
  const remaining = await browser.windows.getAll({ windowTypes: ['normal'] });
  if (remaining.length === 0) await relock('windows');
}

/** The settings, the last known ones when the read fails, else null (unknown). */
async function settingsOrLastKnown(): Promise<Settings | null> {
  try {
    return await getSettings();
  } catch (err) {
    console.warn('tabs: settings read failed', err);
    return lastSettings;
  }
}

/**
 * The URL a tab update shows: the new URL, else (while loading) the tab's committed URL. Not
 * `pendingUrl`: during a navigation the redirect rule is about to send to the lock page, the
 * pending URL is the locked site, and replacing that tab would only throw its history away.
 */
function updatedUrl(changeInfo: { url?: string; status?: string }, tab?: { url?: string }): string | undefined {
  if (changeInfo.url) return changeInfo.url;
  return changeInfo.status === 'loading' ? tab?.url : undefined;
}

export async function onTabUpdated(
  tabId: number,
  changeInfo: { url?: string; status?: string },
  tab?: { url?: string },
): Promise<void> {
  const url = updatedUrl(changeInfo, tab);
  if (!url) return;
  // The extensions-page guard comes first, before any other storage read, so it stays fast.
  if (isExtensionsPage(url)) {
    if (!SETTINGS_GUARD_BUILD || changeInfo.url === undefined) return;
    const settings = await getSettings();
    if (!settings.settingsGuard) return;
    if (!(await getAuth()).password || extensionsOpen(await unlockOrLocked(), settings)) return;
    await browser.tabs.update(tabId, { url: await engineLockUrlFor(tabId, url) });
    return;
  }
  let settings: Settings;
  try {
    settings = await getSettings();
  } catch (err) {
    // The list may have changed since the last read: remember the tab for the next sweep (fail
    // closed; an origin only when the last known list has it), then guard with the settings read
    // again when the guard's turn comes.
    console.warn('tabs: settings read failed', err);
    if (!/^(view-source:)?https?:/i.test(url)) return;
    const known = lastSettings ? lockedTarget(url, lastSettings.domains) : null;
    await trackShownLocked(tabId, httpOrigin(known ?? undefined)).catch((e) =>
      console.warn('tabs: could not record a tab', e),
    );
    if (await passwordMaybeSet()) await guardLockedTab(tabId, lastSettings?.domains ?? null);
    return;
  }
  const target = lockedTarget(url, settings.domains);
  if (target === null) return;
  // Tracking only feeds later relocks; its storage errors must never skip the guard below.
  try {
    await trackShownLocked(tabId, httpOrigin(target));
  } catch (err) {
    console.warn('tabs: could not record a tab that showed a locked site', err);
  }
  // A locked site's page that loaded anyway (e.g. answered by the site's own service worker,
  // which declarativeNetRequest never sees) is swapped for the lock page. This covers domains
  // without host access too: their blocked page (or a worker's cached page) becomes the lock page.
  if (!(await passwordMaybeSet())) return;
  // An open domain's page needs no guard (checked again at the guard's turn).
  if (lockedTarget(url, settings.domains, openDomains(await unlockOrLocked(), settings)) === null) return;
  await guardLockedTab(tabId, settings.domains);
}

/**
 * Replaces tab `tabId` with the lock page if it still shows a locked site while that site is
 * locked. `domains` null: read the settings at its turn (the earlier read failed).
 */
function guardLockedTab(tabId: number, domains: string[] | null): Promise<void> {
  // In ruleQueue so it never races a relock sweep over the same tab.
  return ruleQueue(async () => {
    const unlock = await unlockOrLocked();
    let settings: Settings;
    try {
      settings = await getSettings();
    } catch (err) {
      if (domains === null) {
        // Still unknown: the tab stays recorded, so the next relock recreates it.
        console.warn('tabs: settings still unreadable, the tab is left for the next relock', err);
        return;
      }
      // The open domains cannot be known either: every listed domain counts as locked.
      return guardWith(tabId, domains, []);
    }
    return guardWith(tabId, settings.domains, openDomains(unlock, settings));
  });
}

async function guardWith(tabId: number, domains: string[], open: string[]): Promise<void> {
  let tab: Tab | undefined;
  try {
    tab = await browser.tabs.get(tabId);
  } catch {
    return; // closed meanwhile (e.g. by the relock sweep)
  }
  if (!tab) return;
  const target = lockedTarget(tab.url, domains, open);
  if (target !== null) await replaceWithLockPage(tab, target);
}

/**
 * webNavigation.onCommitted: a frame (frameId ≠ 0) that commits a page of a listed domain marks
 * its tab as a frame host, and its origin as shown (its service worker may serve the site later).
 * Recorded whatever the lock state, so a commit just before a relock is never missed. A main
 * frame that commits a new page (not a reload) in a frame host moves the tab to the shown-locked
 * set: the embedding page now sits in its history and back/forward cache.
 */
export async function onFrameCommitted(details: {
  tabId: number;
  frameId: number;
  url: string;
  transitionType?: string;
}): Promise<void> {
  const { tabId, frameId, url } = details;
  if (tabId < 0) return;
  if (frameId === 0) {
    if (details.transitionType === 'reload') return;
    await ruleQueue(async () => {
      const framed = await readFrameHosts();
      if (!framed.ids.delete(tabId)) return;
      const shown = await readShownLocked();
      shown.ids.add(tabId);
      await writeShownLocked(shown);
      await writeFrameHosts(framed);
    });
    return;
  }
  const settings = await settingsOrLastKnown();
  if (settings === null) {
    if (/^https?:/i.test(url)) await trackFrameHost(tabId, null);
    return;
  }
  const target = lockedTarget(url, settings.domains);
  if (target === null) return;
  await trackFrameHost(tabId, httpOrigin(target));
}

/** A tab swapped for another (prerender, instant pages): the new ID inherits the old one's record. */
export function onTabReplaced(addedTabId: number, removedTabId: number): Promise<void> {
  return ruleQueue(async () => {
    for (const [read, write] of [
      [readShownLocked, writeShownLocked],
      [readFrameHosts, writeFrameHosts],
    ] as const) {
      const set = await read();
      if (!set.ids.delete(removedTabId)) continue;
      set.ids.add(addedTabId);
      await write(set);
    }
  });
}

export async function onTabRemoved(tabId: number): Promise<void> {
  await ruleQueue(async () => {
    for (const [read, write] of [
      [readShownLocked, writeShownLocked],
      [readFrameHosts, writeFrameHosts],
    ] as const) {
      const set = await read();
      if (!set.ids.delete(tabId)) continue;
      await write(set);
    }
  });
  await forgetTokensOf(tabId);
}

export async function onPermissionsRemoved(): Promise<void> {
  await resync();
  // Ask again only when a domain still in the list lost host access.
  const { domains } = await getSettings();
  const granted = await domainsWithHostAccess(domains);
  if (granted.length === domains.length) return;
  await browser.tabs.create({ url: browser.runtime.getURL('/options.html#permission-lost') });
}
