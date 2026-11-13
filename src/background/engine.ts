// Lock engine: unlock and relock decisions for the service worker. The unlock state lives only
// in the session allow rule (rules.ts), never in worker globals, so it survives worker restarts
// and disappears with the browser session.
import { browser } from 'wxt/browser';
import { hostMatches } from '../lib/domain';
import { SETTINGS_GUARD_BUILD } from '../lib/flags';
import type { ErrorCode, Request, Response, State } from '../lib/messages';
import { backoffMs, createRecord, validatePassword, verifyPassword } from '../lib/password';
import { isExtensionsPage, safeReturnTo } from '../lib/return-to';
import { clearUnlocked, isUnlocked, lockPageUrl, setUnlocked, syncBlockRules } from '../lib/rules';
import { getAuth, getSettings, saveAuth, type Settings } from '../lib/settings';

export { isExtensionsPage, safeReturnTo };

const MIN_IDLE_SECONDS = 15;

// The session allow rule must exist while unlocked even with no locked domains (otherwise the
// options page could never leave the locked state). `.invalid` is reserved (RFC 2606) and never
// resolves, so allowing it lets nothing through.
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

async function getState(): Promise<State> {
  const auth = await getAuth();
  return {
    hasPassword: auth.password !== null,
    unlocked: await isUnlocked(),
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

/** Tabs showing (or loading) a page of a locked domain, including view-source of one. */
export function tabsToRelock<T extends { url?: string; pendingUrl?: string }>(tabs: T[], domains: string[]): T[] {
  return tabs.filter((t) => lockedTarget(t.url, domains) !== null || lockedTarget(t.pendingUrl, domains) !== null);
}

type Tab = Browser.tabs.Tab;

// A new tab, not tabs.update: an updated tab keeps the page in the back/forward cache, so Back
// would show it again (spike B5). The original is closed even if the replacement fails.
async function replaceWithLockPage(tab: Tab, returnTo: string): Promise<void> {
  if (tab.id === undefined) return;
  try {
    await browser.tabs.create({
      windowId: tab.windowId,
      index: tab.index,
      pinned: tab.pinned,
      active: tab.active,
      url: lockPageUrl(returnTo),
    });
  } catch (err) {
    console.warn('relock: could not open the lock page', err);
  }
  try {
    await browser.tabs.remove(tab.id);
  } catch (err) {
    console.warn('relock: could not close a locked tab', err);
  }
}

function guardActive(settings: Settings): boolean {
  return SETTINGS_GUARD_BUILD && settings.settingsGuard;
}

/** Clears the unlock rule and replaces every open tab of a locked domain with the lock page. */
export function relock(reason: 'idle' | 'screen' | 'windows' | 'manual'): Promise<void> {
  void reason;
  return ruleQueue(async () => {
    await clearUnlocked();
    const auth = await getAuth();
    if (!auth.password) return;
    const settings = await getSettings();
    const tabs = await browser.tabs.query({});
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
      if (target) await replaceWithLockPage(tab, target);
    }
  });
}

export async function handleMessage(req: Request, sender: { tab?: { id?: number } }): Promise<Response> {
  switch (req.type) {
    case 'getState':
      return ok();

    case 'setup':
      return authQueue(async () => {
        if ((await getAuth()).password) return fail('already_set');
        if (validatePassword(req.password) !== 'ok') return fail('too_short');
        await saveAuth({ password: await createRecord(req.password), failures: 0, blockedUntil: 0 });
        const settings = await getSettings();
        // The person who just chose the password starts unlocked, so the options page opens.
        await setUnlocked(unlockRuleDomains(settings.domains));
        await applySettings(settings);
        return ok();
      });

    case 'unlock': {
      const result = await authQueue(async () => {
        const check = await checkPassword(req.password);
        if (check !== 'ok') return check;
        await saveAuth({ failures: 0, blockedUntil: 0 });
        await setUnlocked(unlockRuleDomains((await getSettings()).domains));
        return check;
      });
      if (result !== 'ok') return fail(result);
      const tabId = sender.tab?.id;
      const url = safeReturnTo(req.returnTo, (await getSettings()).domains);
      if (tabId !== undefined && url !== null) {
        await browser.tabs.update(tabId, { url }).catch((err) => console.warn('unlock: return failed', err));
      }
      return ok();
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
}

export async function onIdleStateChanged(state: string): Promise<void> {
  if (state === 'idle') return relock('idle');
  if (state === 'locked' && (await getSettings()).lockOnScreenLock) return relock('screen');
}

export async function onWindowRemoved(): Promise<void> {
  const remaining = await browser.windows.getAll({ windowTypes: ['normal'] });
  if (remaining.length === 0) await relock('windows');
}

export async function onTabUpdated(tabId: number, changeInfo: { url?: string }): Promise<void> {
  const url = changeInfo.url;
  if (!SETTINGS_GUARD_BUILD || !url || !isExtensionsPage(url)) return;
  const settings = await getSettings();
  if (!settings.settingsGuard) return;
  if (!(await getAuth()).password || (await isUnlocked())) return;
  await browser.tabs.update(tabId, { url: lockPageUrl(url) });
}

export async function onPermissionsRemoved(): Promise<void> {
  await resync();
  // The cast is needed until the options entrypoint exists and WXT types its path.
  await browser.tabs.create({ url: browser.runtime.getURL('/options.html#permission-lost' as never) });
}
