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
import {
  DEFAULT_SETTINGS,
  getAuth,
  getSettings as readSettings,
  parseSettings,
  saveAuth,
  type Settings,
} from '../lib/settings';

export { isExtensionsPage, safeReturnTo };

const MIN_IDLE_SECONDS = 15;
// storage.session key: when the screen locked without relocking (lockOnScreenLock off).
const SCREEN_LOCKED_AT_KEY = 'screenLockedAt';
// storage.session key: IDs of tabs that showed a page of a locked domain since the last relock.
// Such a tab keeps that page in its history (and maybe the back/forward cache, which needs no
// request), so a relock recreates it even when it has moved on to another site.
const SHOWN_LOCKED_KEY = 'shownLockedTabs';
// storage.session key: IDs of tabs whose page embedded a frame of a listed domain since the last
// relock. A relock reloads only the tabs that hold such a frame right now (from
// webNavigation.getAllFrames; the host page itself is not private, so it keeps its history and
// the reload's frame request meets the block rule). This record is the fallback for a tab whose
// frames cannot be listed. A host that moved on is left alone: changing the rules on relock
// flushes the back/forward cache, so Back reloads the embedding page and its frame is blocked.
const FRAME_HOSTS_KEY = 'frameHostTabs';
// storage.local key: origins of listed domains that tabs or frames ever showed (any subdomain or
// port). Kept apart from the tab IDs (a closed tab's site keeps its service worker) and across
// browser sessions (the worker lives on disk), so every relock and browser start removes their
// service workers; an origin is dropped once its domain is no longer listed.
const SHOWN_ORIGINS_KEY = 'shownLockedOrigins';
// storage.session key: true while the options page may show the settings. Separate from the
// site unlock: unlocking the settings never unlocks the sites, and the other way round.
const SETTINGS_UNLOCKED_KEY = 'settingsUnlocked';
// storage.session key: true after a correct unlock on a guard-made extensions-page lock tab in
// 'site' scope (that scope opens no site for it). Every relock clears it.
const EXTENSIONS_UNLOCKED_KEY = 'extensionsUnlocked';
// storage.session key prefix: one lock page target per token (`lockTarget:<token>`).
const TOKEN_KEY_PREFIX = 'lockTarget:';
// storage.local key: the targets of the lock tabs the service worker opened, by token. Chrome
// restores a lock tab after a restart with the same `#t=` URL but a new tab ID (and an update
// empties storage.session), so the worker binds such a token to its new tab again. Claimed
// tokens stay session-only. Entries of lock tabs that are gone are dropped on the next relock.
const ENGINE_TARGETS_KEY = 'engineLockTargets';
// A stored target this young is kept even when no open tab carries it yet (its tab is opening).
const ENGINE_TARGET_GRACE_MS = 60_000;
// Claimed tokens kept per tab (a lock page that reloads claims again); older ones are dropped.
const CLAIMED_TOKENS_PER_TAB = 3;
// How long a frame-host reload may take to commit before the tab is recreated instead (a
// beforeunload or form-resubmission dialog keeps the old document and its frame).
const RELOAD_CONFIRM_MS = 3_000;
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

// The stored settings as this worker last heard them while its storage.onChanged listener is
// registered (from that listener, or from a read no change overtook). Only a prefilter that
// lets ordinary frames of other sites skip the queue; null when unknown.
let watched: Settings | null = null;
let settingsVersion = 0;

async function getSettings(): Promise<Settings> {
  const version = settingsVersion;
  const settings = await readSettings();
  lastSettings = settings;
  if (version === settingsVersion) watched = settings;
  return settings;
}

function watchedSettings(): Settings | null {
  return browser.storage.onChanged.hasListener(onStorageChanged) ? watched : null;
}

/**
 * storage.onChanged (registered at the top level of the background entrypoint): a settings
 * write re-applies the settings, knowing what the list was before (the write may be what woke
 * this worker, whose start already applied the new list).
 */
export function onStorageChanged(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string): void {
  if (area !== 'local' || !('settings' in changes)) return;
  const change = changes.settings!;
  settingsVersion++;
  watched = parseSettings(change.newValue);
  resync(change.oldValue ?? null).catch((err) => console.error('for-my-privacy: storage.onChanged failed', err));
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
 * The extensions page counts as unlocked after an unlock in 'all' scope, or in 'site' scope
 * after a correct unlock on its own (guard-made) lock tab. A failed read counts as locked.
 */
async function extensionsOpen(unlock: UnlockRule | null, settings: Settings): Promise<boolean> {
  if (settings.unlockScope === 'all') return unlock !== null && unlock.scope === 'all';
  try {
    return (await browser.storage.session.get(EXTENSIONS_UNLOCKED_KEY))[EXTENSIONS_UNLOCKED_KEY] === true;
  } catch (err) {
    console.warn('for-my-privacy: could not read the extensions unlock, treating it as locked', err);
    return false;
  }
}

/** Clears the 'site'-scope extensions unlock; when the key cannot be removed, overwrites it. */
async function clearExtensionsUnlocked(): Promise<void> {
  try {
    await browser.storage.session.remove(EXTENSIONS_UNLOCKED_KEY);
  } catch (err) {
    console.warn('relock: could not clear the extensions unlock, overwriting it', err);
    await browser.storage.session.set({ [EXTENSIONS_UNLOCKED_KEY]: false });
  }
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
  // A rule made under another scope than the setting opens nothing (the next sync relocks).
  let unlocked = unlock !== null && unlock.scope !== null;
  if (unlock) {
    try {
      const settings = await getSettings();
      unlockedDomains = openDomains(unlock, settings);
      unlocked = unlock.scope === settings.unlockScope;
    } catch (err) {
      console.warn('getState: settings read failed', err);
    }
  }
  return {
    hasPassword: auth.password !== null,
    unlocked,
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

// The domains locked at the last settings apply in this worker (null: none yet). A domain that
// becomes locked by a settings change (added while locked, or in 'site' scope, or by the first
// password) may already be open in tabs and frames, which are swept then.
let appliedLocked: Set<string> | null = null;

/**
 * Applies `settings`; call inside ruleQueue. `previous`: the settings before the write that led
 * here, when known (a write can wake the worker, whose start already applied the new list).
 */
async function applyNow(settings: Settings, previous?: Settings): Promise<Followup> {
  lastSettings = settings;
  const auth = await getAuth();
  // Nothing is blocked before a password exists (there would be no way to unlock).
  await syncBlockRules(auth.password ? settings.domains : []);
  if (settings.unlockScope !== 'site') {
    await clearExtensionsUnlocked().catch((err) => console.warn('settings: clear failed', err));
  }
  const unlock = await readUnlock();
  if (unlock !== null) {
    if (unlock.scope !== settings.unlockScope) {
      // The unlock scope changed while unlocked: fail closed, the sites lock again. The
      // settings stay open (the owner is in the settings page changing the scope).
      const followup = await relockNow({ keepSettings: true });
      appliedLocked = new Set(auth.password ? settings.domains : []);
      await browser.idle.setDetectionInterval(Math.max(MIN_IDLE_SECONDS, settings.idleMinutes * 60));
      await listedShownOrigins(settings.domains, true);
      return followup;
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
  const open = openDomains(await unlockOrLocked(), settings);
  const lockedNow = new Set(auth.password ? settings.domains.filter((d) => !open.includes(d)) : []);
  // What was locked before: this worker's record and, when known, the list before the write
  // (the smaller of the two, so a sweep is never skipped).
  let before: Set<string> | null = appliedLocked;
  if (previous !== undefined) {
    const prev = new Set(auth.password ? previous.domains.filter((d) => !open.includes(d)) : []);
    before = before === null ? prev : new Set([...before].filter((d) => prev.has(d)));
  }
  const newly = before === null ? [] : [...lockedNow].filter((d) => !before.has(d));
  appliedLocked = lockedNow;
  if (newly.length > 0) return sweepNewlyLocked(newly);
  return NO_FOLLOWUP;
}

/**
 * Domains that just became locked: their open tabs get the lock page, their service workers
 * and caches are removed, and tabs that show them in a frame are reloaded after that (outside
 * the queue). Call inside ruleQueue.
 */
async function sweepNewlyLocked(domains: string[]): Promise<Followup> {
  const tabs = (await queryTabs()) ?? [];
  const { found: frames } = await lockedFrames(tabs, domains, []);
  const origins = [...frames.values()].flat();
  const tabOrigins = tabs.map((t) => lockedTarget(t.url, domains) ?? '');
  const removed = removeSiteData(siteDataOrigins(domains, [...origins, ...tabOrigins]));
  // Committed pages only: the rules are already synced, so a navigation still pending meets
  // the redirect (replacing that tab now would only race it).
  const relocked = new Set(tabs.filter((t) => lockedTarget(t.url, domains) !== null));
  const reloads = planReloads(tabs.filter((t) => t.id !== undefined && frames.has(t.id) && !relocked.has(t)));
  for (const tab of relocked) {
    const target = lockedTarget(tab.url, domains);
    if (target) await replaceWithLockPage(tab, target);
  }
  return followupOf(removed.then(reloads));
}

/** Syncs the block rules, refreshes the unlock rule when unlocked and sets the idle interval. */
export function applySettings(settings: Settings): Promise<void> {
  return runQueued(() => applyNow(settings));
}

/**
 * applySettings with the settings read when its turn comes (for event listeners). `previous`:
 * the stored settings before the change that led here, when the event says (storage.onChanged).
 */
export function resync(previous?: unknown): Promise<void> {
  const before = previous === undefined ? undefined : parseSettings(previous);
  return runQueued(async () => applyNow(await getSettings(), before));
}

const VIEW_SOURCE = 'view-source:';

/**
 * The http(s) page `url` shows, after any view-source: prefix. A `blob:` document belongs to the
 * origin that made it (a file a site opened in a tab of its own), so it stands for that origin's
 * front page: `inner` is the origin then, never the blob URL. Null for anything else.
 */
function parseHttp(url: string | undefined): { inner: string; parsed: URL } | null {
  if (!url) return null;
  let inner = url.startsWith(VIEW_SOURCE) ? url.slice(VIEW_SOURCE.length) : url;
  let parsed: URL;
  try {
    parsed = new URL(inner);
    if (parsed.protocol === 'blob:') {
      // An opaque origin ("null") does not parse and is no site.
      parsed = new URL(parsed.origin);
      inner = parsed.href;
    }
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return { inner, parsed };
}

/** Matches the URLs parseHttp may accept, without parsing (http(s), blob: of one, view-source:). */
const HTTP_LIKE = /^(view-source:)?(blob:)?https?:/i;

/** An empty top-level document another tab can write into (window.open('about:blank')). */
function isBlankDocument(url: string | undefined): boolean {
  return !!url && (url.startsWith('about:blank') || url.startsWith('about:srcdoc'));
}

/**
 * `url` (without a view-source: prefix; a blob: URL as its origin) when it is an http(s) page on
 * one of `domains` and on none of the `open` ones (the unlock rule lets those through), else null.
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
async function trackTabNow(
  read: () => Promise<TabSet>,
  write: (set: TabSet) => Promise<void>,
  memory: Set<number>,
  tabId: number,
  origin: string | null,
): Promise<void> {
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
}

const trackShownLocked = (tabId: number, origin: string | null) =>
  ruleQueue(() => trackTabNow(readShownLocked, writeShownLocked, shownLocked, tabId, origin));
/** The frame-host record itself; call inside ruleQueue. */
const trackFrameHostNow = (tabId: number, origin: string | null) =>
  trackTabNow(readFrameHosts, writeFrameHosts, frameHosts, tabId, origin);

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
  /** When a claimed token was made (Date.now()), to keep only the newest per tab. */
  at?: number;
}

// This worker's copy of the records (a failed storage write still leaves the token usable) and
// the bindings still waiting for their new tab's ID.
const tokenMemory = new Map<string, TokenRecord>();
const pendingBindings = new Map<string, Promise<void>>();
// Tokens whose storage.session write failed: only this worker's copy holds them.
const unsavedTokens = new Set<string>();
// Engine tokens this worker already stored in storage.local.
const storedEngineTokens = new Set<string>();
// Writes to the stored engine targets, and bindings of restored lock tabs, one at a time.
const targetsQueue = serialQueue();

type StoredTarget = { url: string; at: number };

/** The stored engine targets, or null when they cannot be read. Never throws. */
async function readEngineTargets(): Promise<Record<string, StoredTarget> | null> {
  try {
    const raw: unknown = (await browser.storage.local.get(ENGINE_TARGETS_KEY))[ENGINE_TARGETS_KEY];
    const out: Record<string, StoredTarget> = {};
    if (raw && typeof raw === 'object') {
      for (const [token, v] of Object.entries(raw as Record<string, unknown>)) {
        const r = v as Partial<StoredTarget> | null;
        if (TOKEN_PATTERN.test(token) && r && typeof r.url === 'string' && typeof r.at === 'number') {
          out[token] = { url: r.url, at: r.at };
        }
      }
    }
    return out;
  } catch (err) {
    console.warn('lock page: could not read the stored targets', err);
    return null;
  }
}

/** Changes the stored engine targets in targetsQueue. Never throws. */
function editEngineTargets(edit: (all: Record<string, StoredTarget>) => boolean): Promise<void> {
  return targetsQueue(async () => {
    const all = await readEngineTargets();
    if (all === null || !edit(all)) return;
    await browser.storage.local.set({ [ENGINE_TARGETS_KEY]: all });
  }).catch((err) => console.warn('lock page: could not store the targets', err));
}

async function storeEngineTarget(token: string, url: string): Promise<void> {
  if (storedEngineTokens.has(token)) return;
  storedEngineTokens.add(token);
  await editEngineTargets((all) => {
    all[token] = { url, at: Date.now() };
    return true;
  });
}

/**
 * Drops the stored targets that no open tab carries any more (older than a short grace, so a
 * lock tab still opening keeps its own). Skipped when the tabs cannot be listed. Never throws.
 */
async function pruneEngineTargets(): Promise<void> {
  const tabs = await queryTabs();
  if (tabs === null) return;
  const live = new Set(tabs.flatMap((t) => [lockPageToken(t.url), lockPageToken(t.pendingUrl)]));
  const now = Date.now();
  await editEngineTargets((all) => {
    let changed = false;
    for (const [token, target] of Object.entries(all)) {
      if (live.has(token) || now - target.at < ENGINE_TARGET_GRACE_MS) continue;
      delete all[token];
      storedEngineTokens.delete(token);
      changed = true;
    }
    return changed;
  });
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function writeToken(token: string, record: TokenRecord): Promise<void> {
  tokenMemory.set(token, record);
  try {
    await browser.storage.session.set({ [TOKEN_KEY_PREFIX + token]: record });
    unsavedTokens.delete(token);
  } catch (err) {
    console.warn('lock page: could not store a target', err);
    unsavedTokens.add(token);
  }
  if (record.source === 'engine') await storeEngineTarget(token, record.url);
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

/**
 * The record of `token` once its binding is done: stored, else this worker's copy when storage
 * failed (the read now, or the write then).
 */
async function readToken(token: string): Promise<TokenRecord | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  await pendingBindings.get(token);
  try {
    const stored: unknown = (await browser.storage.session.get(TOKEN_KEY_PREFIX + token))[TOKEN_KEY_PREFIX + token];
    if (isTokenRecord(stored)) return stored;
    if (!unsavedTokens.has(token)) return null;
  } catch (err) {
    console.warn('lock page: could not read a target', err);
  }
  return tokenMemory.get(token) ?? null;
}

/**
 * The record of `token` as seen from tab `tabId`. A token this browser session does not know
 * but storage.local does is a lock tab the worker opened before a restart or an update: it is
 * bound to the first tab that carries it now (the restored one), and only that tab.
 */
async function readTokenFor(token: string, tabId: number | undefined): Promise<TokenRecord | null> {
  const record = await readToken(token);
  if (record !== null || tabId === undefined || !TOKEN_PATTERN.test(token)) return record;
  return targetsQueue(async () => {
    const again = await readToken(token);
    if (again !== null) return again;
    const stored = (await readEngineTargets())?.[token];
    if (!stored) return null;
    const bound: TokenRecord = { url: stored.url, tabId, source: 'engine' };
    // Already in storage.local: only this session's record is written.
    storedEngineTokens.add(token);
    await writeToken(token, bound);
    return bound;
  });
}

/** Binds the lock tabs restored after a restart (or kept over an update) to their targets. */
async function rebindLockTabs(tabs: Tab[]): Promise<void> {
  for (const tab of tabs) {
    const token = lockPageToken(tab.url) ?? lockPageToken(tab.pendingUrl);
    if (token !== undefined && tab.id !== undefined) await readTokenFor(token, tab.id);
  }
}

async function deleteTokens(tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  for (const t of tokens) {
    tokenMemory.delete(t);
    unsavedTokens.delete(t);
  }
  await browser.storage.session
    .remove(tokens.map((t) => TOKEN_KEY_PREFIX + t))
    .catch((err) => console.warn('lock page: could not delete targets', err));
  for (const t of tokens) storedEngineTokens.delete(t);
  await editEngineTargets((all) => {
    let changed = false;
    for (const t of tokens) {
      if (!(t in all)) continue;
      delete all[t];
      changed = true;
    }
    return changed;
  });
}

/** Keeps only the newest few claimed tokens of `tabId`. Never throws. */
async function capClaimedTokens(tabId: number): Promise<void> {
  const claimed = new Map<string, number>();
  const add = (token: string, r: TokenRecord) => {
    if (r.tabId === tabId && r.source === 'claimed') claimed.set(token, r.at ?? 0);
  };
  try {
    const all = await browser.storage.session.get(null);
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith(TOKEN_KEY_PREFIX) && isTokenRecord(value)) add(key.slice(TOKEN_KEY_PREFIX.length), value);
    }
  } catch (err) {
    // Storage cannot be listed: this worker's copies are all there is.
    console.warn('lock page: could not list the targets', err);
    for (const [t, r] of tokenMemory) add(t, r);
  }
  const old = [...claimed.entries()].sort((a, b) => b[1] - a[1]).slice(CLAIMED_TOKENS_PER_TAB);
  await deleteTokens(old.map(([t]) => t));
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
  // No known target (an empty tab a locked site may have written into): a plain lock page.
  if (target === '') {
    await recreateTab(tab, lockPageBase(), '');
    return;
  }
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

/**
 * Work a ruleQueue step started and left to finish after the queue moved on (the site-data
 * removal and the frame-host reloads), so the tab guard never waits behind it. `error` is the
 * step's first error, reported once `wait` settled. `wait` never rejects.
 */
type Followup = { wait: Promise<void>; error?: unknown };
const NO_FOLLOWUP: Followup = { wait: Promise.resolve() };

/** Runs `step` in ruleQueue, then waits for its follow-up work outside the queue. */
async function runQueued(step: () => Promise<Followup>): Promise<void> {
  const followup = await ruleQueue(step);
  await followup.wait;
  if (followup.error !== undefined && followup.error !== null) throw followup.error;
}

function followupOf(work: Promise<unknown>, error?: unknown): Followup {
  return {
    wait: work.then(
      () => undefined,
      (err: unknown) => console.warn('relock: follow-up work failed', err),
    ),
    error,
  };
}

// Tabs waiting for their reload to commit (resolved from webNavigation.onCommitted, outside
// ruleQueue, so a relock holding the queue still sees it).
const reloadWaiters = new Map<number, () => void>();

/**
 * Tabs whose host page was reloaded because of a locked frame since the last relock or unlock:
 * 'reloading' while the reload is on its way, 'reloaded' once it committed. A locked frame that
 * commits in a 'reloaded' tab came back although its site's data was removed and the host
 * reloaded (its service worker survived): the second strike gives that tab the lock page.
 */
type GuardEntry = { phase: 'reloading' | 'reloaded' };
const frameGuarded = new Map<number, GuardEntry>();
// The reloads still on their way, by tab (they outlive a relock that clears frameGuarded).
const reloadsInFlight = new Map<number, GuardEntry>();

/**
 * Marks tab `tabId` as reloading for the frame guard. Returns the entry for reloadFrameHost, or
 * null when a reload of that tab is already on its way (the entry carries over; no second one).
 * Call inside ruleQueue.
 */
function markReloading(tabId: number): GuardEntry | null {
  const inFlight = reloadsInFlight.get(tabId);
  if (inFlight) {
    frameGuarded.set(tabId, inFlight);
    return null;
  }
  const entry: GuardEntry = { phase: 'reloading' };
  frameGuarded.set(tabId, entry);
  reloadsInFlight.set(tabId, entry);
  return entry;
}

/**
 * Reloads a tab that hosted a frame of a locked site and waits for the reload to commit. When
 * the reload fails or does not commit in time (a beforeunload or resubmission dialog keeps the
 * old document and its frame), the tab is recreated instead (closing a tab never asks). Runs
 * outside ruleQueue (the recreation itself is queued). Never throws.
 */
async function reloadFrameHost(tabId: number, entry: GuardEntry): Promise<void> {
  let settle!: (committed: boolean) => void;
  const committed = new Promise<boolean>((resolve) => (settle = resolve));
  const timer = setTimeout(() => settle(false), RELOAD_CONFIRM_MS);
  reloadWaiters.set(tabId, () => settle(true));
  // Not awaited on its own: while a dialog holds the reload back, the call may not return.
  browser.tabs.reload(tabId).catch((err: unknown) => {
    console.warn('relock: could not reload a tab that showed a locked site in a frame', err);
    settle(false);
  });
  let reloaded: boolean;
  try {
    reloaded = await committed;
  } finally {
    clearTimeout(timer);
    reloadWaiters.delete(tabId);
    if (reloadsInFlight.get(tabId) === entry) reloadsInFlight.delete(tabId);
  }
  if (reloaded) {
    entry.phase = 'reloaded';
    return;
  }
  console.warn('relock: the reload did not commit, recreating the tab');
  await ruleQueue(async () => {
    let tab: Tab | undefined;
    try {
      tab = await browser.tabs.get(tabId);
    } catch {
      return; // closed meanwhile (e.g. by a sweep)
    }
    if (!tab) return;
    const url = tab.pendingUrl || tab.url || undefined;
    const created = await recreateTab(tab, url, url ?? '');
    if (frameGuarded.get(tabId) === entry) {
      frameGuarded.delete(tabId);
      // The new tab holds the same host page: a locked frame there is the second strike.
      if (created !== undefined) frameGuarded.set(created, { phase: 'reloaded' });
    }
  }).catch((err: unknown) => console.warn('relock: could not recreate a tab', err));
}

/** Marks `tabs` as reloading (call inside ruleQueue); the returned work reloads them later. */
function planReloads(tabs: Tab[]): () => Promise<void> {
  const marked: [number, GuardEntry][] = [];
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    const entry = markReloading(tab.id);
    if (entry) marked.push([tab.id, entry]);
  }
  return async () => {
    await Promise.all(marked.map(([id, entry]) => reloadFrameHost(id, entry)));
  };
}

/**
 * Frames (not top frames) that show a page of a locked domain right now, by tab: their origins.
 * Blocked frames (errorOccurred) are left out. `unlisted`: tabs whose frames could not be listed.
 * Never throws.
 */
async function lockedFrames(
  tabs: Tab[],
  domains: string[],
  open: string[],
): Promise<{ found: Map<number, string[]>; unlisted: Set<number> }> {
  const found = new Map<number, string[]>();
  const unlisted = new Set<number>();
  if (domains.length === 0) return { found, unlisted };
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      let frames: { frameId: number; url: string; errorOccurred?: boolean }[] | null | undefined;
      try {
        frames = await browser.webNavigation.getAllFrames({ tabId: tab.id });
      } catch {
        unlisted.add(tab.id);
        return;
      }
      if (!frames) {
        unlisted.add(tab.id);
        return;
      }
      const origins = frames
        .filter((f) => f.frameId !== 0 && !f.errorOccurred)
        .map((f) => httpOrigin(lockedTarget(f.url, domains, open) ?? undefined))
        .filter((o) => o !== null);
      if (origins.length > 0) found.set(tab.id, origins);
    }),
  );
  return { found, unlisted };
}

export type RelockReason = 'idle' | 'screen' | 'windows' | 'manual' | 'update' | 'command';

/**
 * Clears the unlock rule and replaces every open tab of a locked domain with the lock page.
 * Fails closed: a storage or tabs error after the rule is cleared still sweeps the tabs (with the
 * last known settings), and the first error is rethrown only after the sweep. The site-data
 * removal and the frame-host reloads finish after the queue moved on; this waits for them.
 */
export function relock(reason: RelockReason): Promise<void> {
  void reason;
  return runQueued(() => relockNow());
}

/** The relock itself; call inside ruleQueue. `keepSettings`: the settings unlock stays. */
async function relockNow({ keepSettings = false }: { keepSettings?: boolean } = {}): Promise<Followup> {
  // The sweep uses a listing taken after the rule is cleared, so a tab that opened or started
  // loading a locked site meanwhile is included. The listing taken before is only a fallback
  // for when the later one fails.
  const before = await queryTabs();
  // The frame guard counts from this relock on.
  frameGuarded.clear();
  let firstError: unknown = null;
  try {
    await clearUnlocked();
  } catch (err) {
    firstError = err;
  }
  try {
    await clearExtensionsUnlocked();
  } catch (err) {
    firstError ??= err;
  }
  if (!keepSettings) {
    try {
      await clearSettingsUnlocked();
    } catch (err) {
      firstError ??= err;
    }
  }
  let work: Promise<unknown> = Promise.resolve();
  if (await passwordMaybeSet()) {
    const { settings, real } = await settingsOrFallback();
    const tabs = (await queryTabs()) ?? before ?? [];
    // Only tabs that show a locked site in a frame right now are reloaded (a reload throws away
    // unsaved work). A recorded host whose frames cannot be listed is reloaded too (fail closed).
    const { found: frames, unlisted } = await lockedFrames(tabs, settings.domains, []);
    const frameOrigins = [...frames.values()].flat();
    for (const o of frameOrigins) await addShownOrigin(o).catch((err) => console.warn('relock: record failed', err));
    const framed = new Set(frames.keys());
    for (const id of (await readFrameHosts()).ids) if (unlisted.has(id)) framed.add(id);
    // Runs alongside the sweep; a failure is logged and the rules and the sweep still apply.
    const removed = removeSiteData([
      ...new Set([...(await siteDataOriginsNow(settings.domains, tabs, real)), ...frameOrigins]),
    ]);
    const plan = planSweep(tabs, settings, (await readShownLocked()).ids, framed);
    // Frames get no tab guard, and a frame the site's service worker answers never meets the
    // block rule, so the hosts are reloaded once the removal finished (or gave up).
    const reloads = planReloads(plan.reload);
    await sweepTabs(plan);
    await clearTabSet(SHOWN_LOCKED_KEY, shownLocked);
    await clearTabSet(FRAME_HOSTS_KEY, frameHosts);
    await pruneEngineTargets();
    work = removed.then(reloads);
  }
  return followupOf(work, firstError);
}

/** Listed domains' origins, the listed shown origins and the open locked tabs' origins. */
async function siteDataOriginsNow(domains: string[], tabs: Tab[], prune: boolean): Promise<string[]> {
  const tabOrigins = tabsToRelock(tabs, domains)
    .flatMap((t) => [lockedTarget(t.url, domains), lockedTarget(t.pendingUrl, domains)])
    .filter((u) => u !== null);
  return siteDataOrigins(domains, [...(await listedShownOrigins(domains, prune)), ...tabOrigins]);
}

// Sweep order: what shows a locked site on screen first, then other locked tabs, then the
// extensions page, then the tabs recreated only for their history.
type SweepStep = { tab: Tab; action: 'lock'; target: string; rank: number } | { tab: Tab; action: 'recreate'; rank: number };

/** The extensions page `tab` shows or is loading, else null. */
function extensionsUrlOf(tab: Tab): string | null {
  if (tab.url && isExtensionsPage(tab.url)) return tab.url;
  if (tab.pendingUrl && isExtensionsPage(tab.pendingUrl)) return tab.pendingUrl;
  return null;
}

/**
 * What a relock does to each tab; the frame hosts to reload come separately. Locked targets
 * include blob: documents (as their origin) and empty about:blank/about:srcdoc tabs that a tab
 * which showed a locked site opened (it may have written that site's content into them).
 */
function planSweep(
  tabs: Tab[],
  settings: Settings,
  shown: Set<number>,
  framed: Set<number>,
): { steps: SweepStep[]; reload: Tab[] } {
  const domains = settings.domains;
  const locked = new Set(tabsToRelock(tabs, domains));
  const byId = new Map(tabs.filter((t) => t.id !== undefined).map((t) => [t.id!, t]));
  const targetOf = (t: Tab) => lockedTarget(t.url, domains) ?? lockedTarget(t.pendingUrl, domains);
  const steps: SweepStep[] = [];
  const reload: Tab[] = [];
  for (const tab of tabs) {
    let target: string | null = null;
    let rank = 1;
    const opener = tab.openerTabId === undefined ? undefined : byId.get(tab.openerTabId);
    if (locked.has(tab)) {
      target = targetOf(tab);
    } else if (
      isBlankDocument(tab.url) &&
      tab.openerTabId !== undefined &&
      (shown.has(tab.openerTabId) || (opener !== undefined && locked.has(opener)))
    ) {
      // The opener's site when it shows one now (its origin, as for blob:), else no target.
      const openerTarget = opener !== undefined && locked.has(opener) ? targetOf(opener) : null;
      const origin = httpOrigin(openerTarget ?? undefined);
      target = origin === null ? '' : `${origin}/`;
    } else if (guardActive(settings) && extensionsUrlOf(tab) !== null) {
      // An extensions page left open while unlocked would stay usable after relocking.
      target = extensionsUrlOf(tab);
      rank = 2;
    }
    if (target !== null) {
      steps.push({ tab, action: 'lock', target, rank: rank === 1 && tab.active ? 0 : rank });
    } else if (tab.id !== undefined && shown.has(tab.id)) {
      // It showed a locked site earlier and moved on: same page, but in a tab with no history.
      steps.push({ tab, action: 'recreate', rank: 3 });
    } else if (tab.id !== undefined && framed.has(tab.id)) {
      reload.push(tab);
    }
  }
  steps.sort((a, b) => a.rank - b.rank);
  return { steps, reload };
}

/** Runs the sweep steps; replacing a tab keeps every index stable, so any order works. */
async function sweepTabs({ steps }: { steps: SweepStep[] }): Promise<void> {
  for (const step of steps) {
    if (step.action === 'lock') {
      await replaceWithLockPage(step.tab, step.target);
    } else {
      // If it cannot be closed, closeTab's last resort sends it to the lock page.
      const url = step.tab.pendingUrl || step.tab.url || undefined;
      await recreateTab(step.tab, url, url ?? '');
    }
  }
}

/**
 * Worker start and browser start: binds restored lock tabs to their targets, re-applies the
 * settings and, while the extensions page counts as locked with the guard on, sends any open
 * extensions page to the lock page (a session-restored tab may never fire tabs.onUpdated with a
 * url). An existing unlock is kept.
 */
export function onWorkerStart(): Promise<void> {
  return runQueued(() => workerStartNow());
}

async function workerStartNow(): Promise<Followup> {
  const tabs = await queryTabs();
  if (tabs) await rebindLockTabs(tabs);
  const settings = await getSettings();
  // A start is a new baseline: nothing counts as newly locked (the start sweeps cover tabs). A
  // settings write that woke the worker is swept by its own resync, which knows the list before.
  appliedLocked = null;
  const followup = await applyNow(settings);
  if (!guardActive(settings) || !(await getAuth()).password) return followup;
  if (await extensionsOpen(await unlockOrLocked(), settings)) return followup;
  const pages = (await browser.tabs.query({})).filter((t) => extensionsUrlOf(t) !== null);
  for (const tab of pages) await replaceWithLockPage(tab, extensionsUrlOf(tab)!);
  return followup;
}

/**
 * Browser start, in one ruleQueue step: the worker-start work, then every open or
 * session-restored tab of a locked domain goes to the lock page (a restored tab may have been
 * answered by the site's service worker, which the rules never see) and the locked sites'
 * service workers and caches are removed (they live on disk and survive the restart). The
 * restricted steps run with the last known settings even when the worker-start work fails.
 */
export function onBrowserStart(): Promise<void> {
  return runQueued(async () => {
    let firstError: unknown = null;
    let start = NO_FOLLOWUP;
    try {
      start = await workerStartNow();
    } catch (err) {
      firstError = err;
    }
    let work: Promise<unknown> = Promise.resolve();
    if (await passwordMaybeSet()) {
      const { settings, real } = await settingsOrFallback();
      const open = openDomains(await unlockOrLocked(), settings);
      const locked = settings.domains.filter((d) => !open.includes(d));
      if (locked.length > 0) {
        const tabs = (await queryTabs()) ?? [];
        // Restored tabs that show a locked site in a frame (the session-only record is gone).
        const { found: frames } = await lockedFrames(tabs, settings.domains, open);
        const origins = [...(await siteDataOriginsNow(settings.domains, tabs, real)), ...[...frames.values()].flat()];
        // Origins of open domains keep their workers.
        const removed = removeSiteData([
          ...new Set(
            origins.filter((o) => {
              const host = hostOf(o);
              return host !== null && !open.some((d) => hostMatches(host, d));
            }),
          ),
        ]);
        const relocked = new Set(tabsToRelock(tabs, settings.domains, open));
        const reloads = planReloads(tabs.filter((t) => t.id !== undefined && frames.has(t.id) && !relocked.has(t)));
        for (const tab of relocked) {
          const target =
            lockedTarget(tab.url, settings.domains, open) ?? lockedTarget(tab.pendingUrl, settings.domains, open);
          if (target) await replaceWithLockPage(tab, target);
        }
        work = removed.then(reloads);
      }
    }
    return followupOf(Promise.all([start.wait, work]), firstError);
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
 * URL) when the token belongs to that tab. Null when there is none or it is not safe. Also
 * returns the token to delete after use.
 */
async function unlockTarget(
  req: { token?: string },
  sender: Sender,
  domains: string[],
): Promise<{ url: string | null; token: string | null }> {
  const tabId = sender.tab?.id;
  const token = req.token ?? lockPageToken(sender.url) ?? null;
  if (token === null || tabId === undefined) return { url: null, token: null };
  const record = await readTokenFor(token, tabId);
  if (!record || record.tabId !== tabId) return { url: null, token: null };
  return { url: safeTokenTarget(record, domains), token };
}

/** Whether `url` may be opened now: an open domain's page, or the extensions page when open. */
async function reachable(url: string, settings: Settings, unlock: UnlockRule | null): Promise<boolean> {
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
    const record = await readTokenFor(token, tab.id);
    if (!record || record.source !== 'engine' || record.tabId !== tab.id) continue;
    const url = safeTokenTarget(record, settings.domains);
    if (url === null || !(await reachable(url, settings, unlock))) continue;
    used.push(token);
    await browser.tabs.update(tab.id, { url }).catch((err) => console.warn('unlock: return failed', err));
  }
  await deleteTokens(used);
}

/**
 * The answer for a lock page target: the host to show, and what an unlock there opens: the
 * extensions page, or a site (with its listed domain, which a 'site' unlock opens).
 */
async function targetAnswer(token: string, url: string, domains: string[]): Promise<TargetResponse> {
  const base = { ok: true as const, state: await getState(), token, host: hostLabel(url) };
  if (url.startsWith('chrome:')) return { ...base, kind: 'extensions' };
  return { ...base, kind: 'site', domain: listedDomainOf(url, domains) ?? '' };
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
    const record = await readTokenFor(token, tabId);
    if (!record || record.tabId !== tabId) return false;
    // In ruleQueue: a relock running now finishes first, and the settings and the rule are
    // read after it.
    const sent = await ruleQueue(async () => {
      const settings = await getSettings();
      const url = safeTokenTarget(record, settings.domains);
      if (url === null || !(await reachable(url, settings, await unlockOrLocked()))) return false;
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
      const check = await authQueue(async () => {
        const c = await checkPassword(req.password);
        if (c === 'ok') await saveAuth({ failures: 0, blockedUntil: 0 });
        return c;
      });
      if (check !== 'ok') return fail(check);
      // One ruleQueue step: the settings, the rule change, this tab's navigation and the other
      // lock tabs all see the same state, and no relock can run in between. `opened`: this tab
      // was sent to its page (else the lock page says what to do).
      const opened = await ruleQueue(async () => {
        // The frame guard counts strikes from one relock or unlock to the next.
        frameGuarded.clear();
        let sent = false;
        const settings = await getSettings();
        const tabId = sender.tab?.id;
        const { url, token } = await unlockTarget(req, sender, settings.domains);
        if (settings.unlockScope === 'all') {
          await setUnlocked(settings.domains, 'all');
        } else if (url !== null && url.startsWith('chrome:')) {
          // 'site': a correct unlock on the guard's extensions-page lock tab opens that page
          // (until the next relock); no site opens.
          await browser.storage.session.set({ [EXTENSIONS_UNLOCKED_KEY]: true });
        } else {
          // 'site': this lock page's own domain joins the domains unlocked so far.
          const domain = url === null ? null : listedDomainOf(url, settings.domains);
          if (domain !== null) {
            const current = openDomains(await unlockOrLocked(), settings);
            await setUnlocked([...new Set([...current, domain])], 'site');
          }
        }
        const unlock = await unlockOrLocked();
        if (tabId !== undefined && url !== null && (await reachable(url, settings, unlock))) {
          try {
            await browser.tabs.update(tabId, { url });
            sent = true;
          } catch (err) {
            console.warn('unlock: return failed', err);
          }
          if (token !== null) await deleteTokens([token]);
        }
        await returnLockTabs(settings, unlock, tabId);
        return sent;
      });
      return { ok: true, state: await getState(), opened };
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
      const { domains } = await getSettings();
      const url = safeReturnTo(req.raw, domains);
      if (url === null || url.startsWith('chrome:')) return fail('invalid_target');
      const token = newToken();
      await writeToken(token, { url, tabId, source: 'claimed', at: Date.now() });
      await capClaimedTokens(tabId);
      const answer = await targetAnswer(token, url, domains);
      // Redirected just before an unlock elsewhere opened the site: go straight there (after
      // the answer, which must not wait for a relock in progress).
      void returnIfOpen(tabId, token);
      return answer;
    }

    case 'describeTarget': {
      const tabId = sender.tab?.id;
      if (!fromTopFrame(sender) || tabId === undefined) return fail('invalid_target');
      const record = await readTokenFor(req.token, tabId);
      if (!record || record.tabId !== tabId) return fail('invalid_target');
      const { domains } = await getSettings();
      const url = safeTokenTarget(record, domains);
      if (url === null) return fail('invalid_target');
      const answer = await targetAnswer(req.token, url, domains);
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
  // The extensions-page guard comes first, before any other storage read.
  if (isExtensionsPage(url)) {
    if (!SETTINGS_GUARD_BUILD || changeInfo.url === undefined) return;
    return guardExtensionsPage(tabId, url);
  }
  let settings: Settings;
  try {
    settings = await getSettings();
  } catch (err) {
    // The list may have changed since the last read: remember the tab for the next sweep (fail
    // closed; an origin only when the last known list has it), then guard with the settings read
    // again when the guard's turn comes.
    console.warn('tabs: settings read failed', err);
    if (!HTTP_LIKE.test(url)) return;
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
 * Sends tab `tabId` (now on the extensions page `url`) to the lock page while that page counts
 * as locked. In ruleQueue, so it reads the extensions unlock after any unlock or relock before
 * it. Fails closed: unreadable settings are the last known ones (else the defaults, guard on),
 * an unreadable password counts as set.
 */
function guardExtensionsPage(tabId: number, url: string): Promise<void> {
  return ruleQueue(async () => {
    let settings: Settings;
    try {
      settings = await getSettings();
    } catch (err) {
      console.warn('tabs: settings read failed, guarding the extensions page', err);
      settings = lastSettings ?? DEFAULT_SETTINGS;
    }
    if (!settings.settingsGuard) return;
    if (!(await passwordMaybeSet()) || (await extensionsOpen(await unlockOrLocked(), settings))) return;
    // Checked again right before: the tab may have moved on while this waited its turn. When it
    // cannot be read, the update goes ahead (a closed tab just fails it).
    try {
      const now = await browser.tabs.get(tabId);
      const shown = now?.pendingUrl || now?.url;
      if (shown && !isExtensionsPage(shown)) return;
    } catch {
      // fall through
    }
    await browser.tabs.update(tabId, { url: await engineLockUrlFor(tabId, url) });
  });
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
      // The last known settings tell which domains the readable rule opens.
      return guardWith(tabId, domains, lastSettings ? openDomains(unlock, lastSettings) : []);
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
 * webNavigation.onCommitted (http and https only): a frame (frameId ≠ 0) that commits a page of
 * a listed domain marks its tab as a frame host, and its origin as shown (its service worker may
 * serve the site later). Recorded whatever the lock state, so a commit just before a relock is
 * never missed. While that domain is locked, such a commit means the frame was answered without
 * the rules (its site's service worker): the frame guard removes that origin's workers and
 * reloads the host. Ordinary frames of other sites are skipped at once while the settings are
 * known; anything else is queued and the settings are read when its turn comes.
 */
export function onFrameCommitted(details: {
  tabId: number;
  frameId: number;
  url: string;
  transitionType?: string;
}): Promise<void> {
  const { tabId, frameId, url } = details;
  // A frame-host reload waiting for its commit hears it here, even while a relock holds the queue.
  if (frameId === 0 && details.transitionType === 'reload') reloadWaiters.get(tabId)?.();
  // A main frame is the tab guard's job; the record of a frame host stays until the next relock,
  // which lists the tab's frames again.
  if (tabId < 0 || frameId === 0) return Promise.resolve();
  const known = watchedSettings();
  if (known !== null && lockedTarget(url, known.domains) === null) return Promise.resolve();
  // What the frame guard had done for this tab when the frame committed (a reload on its way
  // replaces this frame's document; after it, a locked frame is the second strike).
  const seen = frameGuarded.get(tabId);
  const seenPhase = seen?.phase;
  return ruleQueue(async (): Promise<Followup> => {
    const settings = await settingsOrLastKnown();
    if (settings === null) {
      if (/^https?:/i.test(url)) await trackFrameHostNow(tabId, null);
      return NO_FOLLOWUP;
    }
    const target = lockedTarget(url, settings.domains);
    if (target === null) return NO_FOLLOWUP;
    const origin = httpOrigin(target);
    try {
      await trackFrameHostNow(tabId, origin);
    } catch (err) {
      console.warn('frames: could not record a frame of a locked site', err);
    }
    if (!(await passwordMaybeSet())) return NO_FOLLOWUP;
    if (lockedTarget(url, settings.domains, openDomains(await unlockOrLocked(), settings)) === null) return NO_FOLLOWUP;
    return guardFrame(tabId, target, origin, seen, seenPhase);
  }).then((followup) => followup.wait);
}

/**
 * A frame of a locked site committed while locked in tab `tabId`; `seen`/`seenPhase` is what the
 * guard had done for the tab at that commit. First strike: remove that origin's service workers
 * and caches, then reload the host (recreated if the reload does not commit), after the queue
 * moved on. A commit while that reload was on its way is skipped (the reload replaces it). A
 * locked frame after the reload committed is the second strike, until the next relock or
 * unlock: the host tab gets the lock page for the frame's site. Call inside ruleQueue.
 */
async function guardFrame(
  tabId: number,
  target: string,
  origin: string | null,
  seen: GuardEntry | undefined,
  seenPhase: GuardEntry['phase'] | undefined,
): Promise<Followup> {
  const current = frameGuarded.get(tabId);
  // A reload that started after this commit, or was on its way at it, replaces that document.
  // (A relock or unlock since then cleared the record: current is undefined, a first strike.)
  if (current !== undefined && (current !== seen || seenPhase === 'reloading')) return NO_FOLLOWUP;
  const secondStrike = current !== undefined && seenPhase === 'reloaded';
  let tab: Tab | undefined;
  try {
    tab = await browser.tabs.get(tabId);
  } catch {
    return NO_FOLLOWUP; // closed meanwhile
  }
  if (!tab) return NO_FOLLOWUP;
  if (secondStrike) {
    frameGuarded.delete(tabId);
    console.warn('frames: a locked frame came back after the removal and the reload, locking its tab');
    await replaceWithLockPage(tab, target);
    return NO_FOLLOWUP;
  }
  const reload = planReloads([tab]);
  const removed = origin === null ? Promise.resolve(true) : removeSiteData([origin]);
  return followupOf(removed.then(reload));
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
