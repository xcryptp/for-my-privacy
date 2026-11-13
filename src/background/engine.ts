// Lock engine: unlock and relock decisions for the service worker. The unlock state lives only
// in the session allow rule (rules.ts), never in worker globals, so it survives worker restarts
// and disappears with the browser session.
import { browser } from 'wxt/browser';
import { hostMatches } from '../lib/domain';
import { SETTINGS_GUARD_BUILD } from '../lib/flags';
import type { ErrorCode, Request, Response, State } from '../lib/messages';
import { backoffMs, createRecord, validatePassword, verifyPassword } from '../lib/password';
import { isExtensionsPage, safeReturnTo } from '../lib/return-to';
import {
  clearUnlocked,
  domainsWithHostAccess,
  isUnlocked,
  lockPageTarget,
  lockPageUrl,
  setUnlocked,
  syncBlockRules,
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
// storage.session key: origins of locked domains that tabs showed since the last successful
// site-data removal. Kept apart from the tab IDs: a closed tab's site keeps its service worker.
const SHOWN_ORIGINS_KEY = 'shownLockedOrigins';
// storage.session key: true while the options page may show the settings. Separate from the
// site unlock: unlocking the settings never unlocks the sites, and the other way round.
const SETTINGS_UNLOCKED_KEY = 'settingsUnlocked';
// Longest wait for the site-data removal before a relock moves on (the removal keeps running).
const SITE_DATA_TIMEOUT_MS = 10_000;
// Wait before trying again to close a tab Chrome refuses to edit (e.g. while a tab is dragged).
const CLOSE_RETRY_MS = 500;

// Last settings read successfully. Only a fallback so a relock still sweeps tabs when storage
// fails; it is never used to decide whether the browser is unlocked.
let lastSettings: Settings | null = null;
// This worker's copy of the shown-locked set, so a failed storage.session read during a relock
// still covers the tabs this worker recorded.
const shownLocked = new Set<number>();
// This worker's copy of the shown origins, for the same reason.
const shownOrigins = new Set<string>();

async function getSettings(): Promise<Settings> {
  const settings = await readSettings();
  lastSettings = settings;
  return settings;
}

/** The stored settings, or the last known ones (else the defaults) when the read fails. */
async function settingsOrFallback(): Promise<Settings> {
  try {
    return await getSettings();
  } catch (err) {
    console.warn('for-my-privacy: settings read failed, using the last known settings', err);
    return lastSettings ?? DEFAULT_SETTINGS;
  }
}

// The session allow rule must exist while unlocked even with no locked domains (otherwise an
// unlock with an empty list would read as locked, and the extensions-page guard would send
// chrome://extensions straight back to the lock page). `.invalid` is reserved (RFC 2606) and
// never resolves, so allowing it lets nothing through.
const UNLOCK_MARKER_DOMAIN = 'unlocked.for-my-privacy.invalid';
const unlockRuleDomains = (domains: string[]) => [...domains, UNLOCK_MARKER_DOMAIN];

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
// Relocks and rule syncs share one queue: overlapping relocks (idle and screen lock) replace each
// tab once, an older settings snapshot never overwrites a newer one, and a sync that saw the
// unlock rule cannot re-create it after a relock cleared it.
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

async function getState(): Promise<State> {
  const auth = await getAuth();
  return {
    hasPassword: auth.password !== null,
    unlocked: await isUnlocked(),
    settingsUnlocked: await isSettingsUnlocked(),
    waitMs: Math.max(0, auth.blockedUntil - Date.now()),
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
  if (await isUnlocked()) await setUnlocked(unlockRuleDomains(settings.domains));
  await browser.idle.setDetectionInterval(Math.max(MIN_IDLE_SECONDS, settings.idleMinutes * 60));
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

function lockedTarget(url: string | undefined, domains: string[]): string | null {
  if (!url) return null;
  const inner = url.startsWith(VIEW_SOURCE) ? url.slice(VIEW_SOURCE.length) : url;
  let parsed: URL;
  try {
    parsed = new URL(inner);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return domains.some((d) => hostMatches(parsed.hostname, d)) ? inner : null;
}

/** The origin of `url` (after any view-source: prefix) when it is http(s), else null. */
function httpOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url.startsWith(VIEW_SOURCE) ? url.slice(VIEW_SOURCE.length) : url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
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
      { origins: origins as [string, ...string[]] },
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
export function tabsToRelock<T extends { url?: string; pendingUrl?: string }>(tabs: T[], domains: string[]): T[] {
  return tabs.filter((t) => lockedTarget(t.url, domains) !== null || lockedTarget(t.pendingUrl, domains) !== null);
}

type Tab = Browser.tabs.Tab;

/**
 * The stored shown-locked set joined with this worker's copy. Never throws; `complete` is false
 * when the stored set could not be read.
 */
async function readShownLocked(): Promise<{ ids: Set<number>; complete: boolean }> {
  const ids = new Set(shownLocked);
  try {
    const stored: unknown = (await browser.storage.session.get(SHOWN_LOCKED_KEY))[SHOWN_LOCKED_KEY];
    if (Array.isArray(stored)) for (const id of stored) if (typeof id === 'number') ids.add(id);
    return { ids, complete: true };
  } catch (err) {
    console.warn('tabs: could not read the tabs that showed a locked site', err);
    return { ids, complete: false };
  }
}

/** Saves the set; after an incomplete read only this worker's copy changes, so stored IDs stay. */
async function writeShownLocked({ ids, complete }: { ids: Set<number>; complete: boolean }): Promise<void> {
  shownLocked.clear();
  for (const id of ids) shownLocked.add(id);
  if (complete) await browser.storage.session.set({ [SHOWN_LOCKED_KEY]: [...ids] });
}

/** Forgets `removed`; origins recorded meanwhile stay for the next relock. */
async function clearShownOrigins(removed: Set<string>): Promise<void> {
  try {
    const set = await readShownOrigins();
    for (const o of removed) set.origins.delete(o);
    await writeShownOrigins(set);
  } catch (err) {
    console.warn('relock: could not clear the shown origins', err);
  }
}

async function clearShownLocked(): Promise<void> {
  shownLocked.clear();
  await browser.storage.session.remove(SHOWN_LOCKED_KEY).catch((err) => console.warn('relock: clear failed', err));
}

/** The stored shown origins joined with this worker's copy. Never throws. */
async function readShownOrigins(): Promise<{ origins: Set<string>; complete: boolean }> {
  const origins = new Set(shownOrigins);
  try {
    const stored: unknown = (await browser.storage.session.get(SHOWN_ORIGINS_KEY))[SHOWN_ORIGINS_KEY];
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
  if (complete) await browser.storage.session.set({ [SHOWN_ORIGINS_KEY]: [...origins] });
}

/**
 * Records a tab that showed a page of a locked domain, and that page's origin when known (null
 * when the domain list could not be read, so no other site's data is ever removed). Runs in
 * ruleQueue, after any relock.
 */
function trackShownLocked(tabId: number, origin: string | null): Promise<void> {
  return ruleQueue(async () => {
    if (origin !== null && !shownOrigins.has(origin)) {
      const set = await readShownOrigins();
      set.origins.add(origin);
      await writeShownOrigins(set);
    }
    if (shownLocked.has(tabId)) return;
    const set = await readShownLocked();
    set.ids.add(tabId);
    await writeShownLocked(set);
  });
}

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
  await browser.tabs
    .update(tab.id, { url: lockPageUrl(returnTo) })
    .catch((err) => console.warn('relock: could not send a tab to the lock page', err));
}

/**
 * Opens `url` (the new tab page when undefined) in a new tab at `tab`'s place, then closes `tab`.
 * A new tab, not tabs.update: an updated tab keeps the page in the back/forward cache, so Back
 * would show it again (spike B5). The original is closed even if the replacement fails.
 */
async function recreateTab(tab: Tab, url: string | undefined, returnTo: string): Promise<void> {
  if (tab.id === undefined) return;
  try {
    await browser.tabs.create({
      windowId: tab.windowId,
      index: tab.index,
      pinned: tab.pinned,
      active: tab.active,
      ...(url === undefined ? {} : { url }),
    });
  } catch (err) {
    console.warn('relock: could not open the replacement tab', err);
  }
  await closeTab(tab as Tab & { id: number }, returnTo);
}

function replaceWithLockPage(tab: Tab, returnTo: string): Promise<void> {
  return recreateTab(tab, lockPageUrl(returnTo), returnTo);
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
 * Clears the unlock rule and replaces every open tab of a locked domain with the lock page.
 * Fails closed: a storage or tabs error after the rule is cleared still sweeps the tabs (with the
 * last known settings), and the first error is rethrown only after the sweep.
 */
export function relock(reason: 'idle' | 'screen' | 'windows' | 'manual' | 'update'): Promise<void> {
  void reason;
  return ruleQueue(async () => {
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
      const settings = await settingsOrFallback();
      const tabs = (await queryTabs()) ?? before ?? [];
      // Runs alongside the sweep; a failure is logged and the rules and the sweep still apply.
      const shown = await readShownOrigins();
      const tabOrigins = tabsToRelock(tabs, settings.domains).flatMap((t) => [
        lockedTarget(t.url, settings.domains),
        lockedTarget(t.pendingUrl, settings.domains),
      ]);
      const removed = removeSiteData(
        siteDataOrigins(settings.domains, [...shown.origins, ...tabOrigins.filter((u) => u !== null)]),
      );
      await sweepTabs(tabs, settings, (await readShownLocked()).ids);
      await clearShownLocked();
      // Forget the origins only once their data is gone, so a failed removal is tried again.
      if (await removed) await clearShownOrigins(shown.origins);
    }
    if (firstError) throw firstError;
  });
}

async function sweepTabs(tabs: Tab[], settings: Settings, shown: Set<number>): Promise<void> {
  const locked = new Set(tabsToRelock(tabs, settings.domains));
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
    }
  }
}

/**
 * Worker start and browser start: re-applies the settings and, while locked with the guard on,
 * sends any open extensions page to the lock page (a session-restored tab may never fire
 * tabs.onUpdated with a url). An existing unlock is kept.
 */
export function onWorkerStart(): Promise<void> {
  return ruleQueue(async () => {
    const settings = await getSettings();
    await applyNow(settings);
    if (!guardActive(settings) || !(await getAuth()).password || (await isUnlocked())) return;
    const tabs = (await browser.tabs.query({})).filter((t) => t.url && isExtensionsPage(t.url));
    for (const tab of tabs) await replaceWithLockPage(tab, tab.url!);
  });
}

/**
 * Browser start: onWorkerStart, then, while locked, removes the listed sites' service workers
 * and caches. They live on disk, so a restart keeps them while the unlock is gone.
 */
export async function onBrowserStart(): Promise<void> {
  // Both run in ruleQueue, so the removal starts after the worker-start sync.
  const started = onWorkerStart();
  const cleaned = ruleQueue(async () => {
    if (!(await passwordMaybeSet())) return;
    if (await isUnlocked().catch(() => false)) return;
    await removeSiteData(siteDataOrigins((await settingsOrFallback()).domains));
  });
  await Promise.all([started, cleaned]);
}

export interface Sender {
  tab?: { id?: number };
  frameId?: number;
}

// lock.html is web-accessible, so a web page can frame it. A message from a tab must come from
// its top frame; one without a tab (an extension page not in a tab) has nothing to navigate.
function fromTopFrame(sender: Sender): boolean {
  return sender.tab === undefined || sender.frameId === 0;
}

/** After an unlock, sends every other lock tab with a safe target back to it. */
async function returnLockTabs(domains: string[], senderTabId: number | undefined): Promise<void> {
  let tabs: Tab[];
  try {
    tabs = await browser.tabs.query({});
  } catch (err) {
    console.warn('unlock: could not list the lock tabs', err);
    return;
  }
  for (const tab of tabs) {
    if (tab.id === undefined || tab.id === senderTabId) continue;
    const url = safeReturnTo(lockPageTarget(tab.url), domains);
    if (url === null) continue;
    await browser.tabs.update(tab.id, { url }).catch((err) => console.warn('unlock: return failed', err));
  }
}

export async function handleMessage(req: Request, sender: Sender): Promise<Response> {
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
        if (check !== 'ok') return check;
        await saveAuth({ failures: 0, blockedUntil: 0 });
        await setUnlocked(unlockRuleDomains((await getSettings()).domains));
        return check;
      });
      if (result !== 'ok') return fail(result);
      const tabId = sender.tab?.id;
      const { domains } = await getSettings();
      const url = safeReturnTo(req.returnTo, domains);
      if (tabId !== undefined && url !== null) {
        await browser.tabs.update(tabId, { url }).catch((err) => console.warn('unlock: return failed', err));
      }
      await returnLockTabs(domains, tabId);
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

// Listener bodies, registered at the top level of entrypoints/background.ts.

export async function onInstalled(details: { reason: string }): Promise<void> {
  if (details.reason === 'install') await browser.runtime.openOptionsPage();
  // An update or reload drops the session unlock rule, but open tabs of locked sites stay as they
  // were until the next relock, so sweep them now (relock does nothing before a password exists).
  if (details.reason === 'update') await relock('update');
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
    const { idleMinutes } = await settingsOrFallback();
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

/** The listed domains, the last known ones when the read fails, else null (unknown). */
async function domainsOrLastKnown(): Promise<string[] | null> {
  try {
    return (await getSettings()).domains;
  } catch (err) {
    console.warn('tabs: settings read failed', err);
    return lastSettings?.domains ?? null;
  }
}

/** False only when the unlock rule positively exists; a failed read counts as locked. */
async function sitesMaybeLocked(): Promise<boolean> {
  try {
    return !(await isUnlocked());
  } catch (err) {
    console.warn('tabs: could not read the unlock rule, treating the sites as locked', err);
    return true;
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
  // The extensions-page guard comes first, before any storage read, so it stays fast.
  if (isExtensionsPage(url)) {
    if (!SETTINGS_GUARD_BUILD || changeInfo.url === undefined) return;
    const settings = await getSettings();
    if (!settings.settingsGuard) return;
    if (!(await getAuth()).password || (await isUnlocked())) return;
    await browser.tabs.update(tabId, { url: lockPageUrl(url) });
    return;
  }
  const domains = await domainsOrLastKnown();
  if (domains === null) {
    // Unknown list: remember the tab for the next sweep (fail closed) but no origin to remove.
    if (/^(view-source:)?https?:/i.test(url)) await trackShownLocked(tabId, null);
    return;
  }
  const target = lockedTarget(url, domains);
  if (target === null) return;
  await trackShownLocked(tabId, httpOrigin(target));
  // A locked site's page that loaded anyway (e.g. answered by the site's own service worker,
  // which declarativeNetRequest never sees) is swapped for the lock page.
  if (!(await passwordMaybeSet()) || !(await sitesMaybeLocked())) return;
  await guardLockedTab(tabId, domains);
}

/**
 * True when the extension has host access to the listed domain `url` belongs to (a failed check
 * counts as access). Without access the redirect rule skips the domain and its block rule shows
 * Chrome's blocked page, which is also a committed URL of the site; that page stays as it is.
 */
async function lockScreenAllowed(url: string, domains: string[]): Promise<boolean> {
  const host = new URL(url).hostname;
  const domain = domains.find((d) => hostMatches(host, d));
  if (domain === undefined) return false;
  try {
    return (await domainsWithHostAccess([domain])).length === 1;
  } catch (err) {
    console.warn('tabs: could not check site access, showing the lock page', err);
    return true;
  }
}

/** Replaces tab `tabId` with the lock page if it still shows a locked site while locked. */
function guardLockedTab(tabId: number, domains: string[]): Promise<void> {
  // In ruleQueue so it never races a relock sweep over the same tab.
  return ruleQueue(async () => {
    if (!(await sitesMaybeLocked())) return;
    let tab: Tab;
    try {
      tab = await browser.tabs.get(tabId);
    } catch {
      return; // closed meanwhile (e.g. by the relock sweep)
    }
    const target = lockedTarget(tab.url, domains);
    if (target !== null && (await lockScreenAllowed(target, domains))) await replaceWithLockPage(tab, target);
  });
}

/** A tab swapped for another (prerender, instant pages): the new ID inherits the old one's record. */
export function onTabReplaced(addedTabId: number, removedTabId: number): Promise<void> {
  return ruleQueue(async () => {
    const set = await readShownLocked();
    if (!set.ids.delete(removedTabId)) return;
    set.ids.add(addedTabId);
    await writeShownLocked(set);
  });
}

export function onTabRemoved(tabId: number): Promise<void> {
  return ruleQueue(async () => {
    const set = await readShownLocked();
    if (!set.ids.delete(tabId)) return;
    await writeShownLocked(set);
  });
}

export async function onPermissionsRemoved(): Promise<void> {
  await resync();
  // Ask again only when a domain still in the list lost host access.
  const { domains } = await getSettings();
  const granted = await domainsWithHostAccess(domains);
  if (granted.length === domains.length) return;
  await browser.tabs.create({ url: browser.runtime.getURL('/options.html#permission-lost') });
}
