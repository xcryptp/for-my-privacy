import { browser } from 'wxt/browser';
import { applyI18n, t } from '../../src/lib/i18n';
import { send, type TargetResponse } from '../../src/lib/messages';
import { hostMatches } from '../../src/lib/domain';
import { getSettings, type Settings, type UnlockScope } from '../../src/lib/settings';
import { createCountdown, formatCountdown } from '../../src/ui/countdown';
import { wrongPasswordText } from '../../src/ui/tries';

export { formatCountdown };

/** The original URL the redirect rule put after the first `#u=` (it may itself contain `#`); only claimed, never shown. */
export function parseReturnTo(hash: string): string | undefined {
  const marker = '#u=';
  if (!hash.startsWith(marker)) return undefined;
  return hash.slice(marker.length) || undefined;
}

/** The token of a lock page the engine opened or this page swapped to: `#t=<token>`. */
export function parseToken(hash: string): string | undefined {
  const marker = '#t=';
  if (!hash.startsWith(marker)) return undefined;
  return hash.slice(marker.length) || undefined;
}

export { wrongPasswordText };

/** What the lock page knows about its target: the host to show, and what the unlock opens. */
export interface HintTarget {
  /** The listed domain the site belongs to (an unlock in 'site' scope opens it and every address under it). */
  domain?: string;
  /** `extensions` for the extensions page that the guard sent here. */
  kind?: 'site' | 'extensions';
}

/** The listed domain of a host: the engine's answer, or else the first stored domain the host falls under. */
export function listedDomainFor(
  host: string | undefined,
  answered: string | undefined,
  domains: readonly string[],
): string | undefined {
  if (answered) return answered;
  return host ? domains.find((d) => hostMatches(host, d)) : undefined;
}

/** The muted line under the Unlock button: what one unlock opens, following the unlock setting. */
export function scopeHintText(scope: UnlockScope, target: HintTarget, tr: typeof t = t): string {
  if (scope !== 'site') return tr('unlockHintAll');
  if (target.kind === 'extensions') return tr('unlockHintExtensions');
  return target.domain ? tr('unlockHintSite', target.domain) : tr('unlockHintThisSite');
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

// How long a lock page waits for the worker to send it back before it says the site can be opened again.
const NO_RETURN_MS = 4000;

function init(): void {
  const form = byId<HTMLFormElement>('form');
  const input = byId<HTMLInputElement>('password');
  const submit = byId<HTMLButtonElement>('submit');
  const error = byId<HTMLElement>('error');
  const done = byId<HTMLElement>('done');
  const subtitle = byId<HTMLElement>('subtitle');
  const settings = byId<HTMLAnchorElement>('settings');
  const scopeHint = byId<HTMLElement>('scope-hint');

  // What this page may show and send: a token the worker issued for this tab. The raw `#u=` address
  // is handed over once and replaced in the address bar, so it never stays in the tab history.
  let token: string | undefined;
  let host: string | undefined;
  let busy = false;
  let unlocked = false;

  applyI18n();
  document.documentElement.lang = browser.i18n.getUILanguage();

  // What the worker said about the target: a listed site (with its domain) or the extensions page.
  let answeredDomain: string | undefined;
  let kind: 'site' | 'extensions' | undefined;

  function takeAnswer(res: Extract<TargetResponse, { ok: true }>): void {
    host = res.host;
    kind = res.kind;
    answeredDomain = res.kind === 'site' ? res.domain : undefined;
  }

  async function resolveTarget(): Promise<void> {
    const raw = parseReturnTo(location.hash);
    const known = parseToken(location.hash);
    try {
      if (raw !== undefined) {
        const res = await send({ type: 'claimTarget', raw });
        if (res.ok) {
          token = res.token;
          takeAnswer(res);
          history.replaceState(null, '', `#t=${res.token}`);
        }
      } else if (known !== undefined) {
        const res = await send({ type: 'describeTarget', token: known });
        if (res.ok) {
          token = known;
          takeAnswer(res);
        }
      }
    } catch (err) {
      console.warn('target lookup failed', err);
    } finally {
      // Whatever happened, the raw address does not stay in the address bar.
      if (parseReturnTo(location.hash) !== undefined) {
        history.replaceState(null, '', location.pathname + location.search);
      }
    }
    if (host) {
      subtitle.textContent = t('lockSubtitle', host);
      subtitle.hidden = false;
    }
  }

  // The line under Unlock follows the unlock setting; "all" is also what a failed read means.
  async function refreshHint(): Promise<void> {
    let current: Pick<Settings, 'unlockScope' | 'domains'> = { unlockScope: 'all', domains: [] };
    try {
      current = await getSettings();
    } catch (err) {
      console.warn('settings read failed', err);
    }
    scopeHint.textContent = scopeHintText(current.unlockScope, {
      domain: listedDomainFor(host, answeredDomain, current.domains),
      kind,
    });
    scopeHint.hidden = false;
  }

  const targetReady = resolveTarget();
  void targetReady.then(refreshHint).catch((err) => console.warn('hint failed', err));
  // A change of the unlock setting (or of the list) made on the settings page shows here at once.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'settings' in changes) void targetReady.then(refreshHint);
  });

  // The click handler reuses an open options tab; the href is the fallback.
  settings.href = browser.runtime.getURL('/options.html');
  settings.addEventListener('click', (event) => {
    event.preventDefault();
    browser.runtime.openOptionsPage().catch(() => window.open(settings.href));
  });

  const countdown = createCountdown(error, submit, input);

  function showError(message: string): void {
    countdown.stop();
    error.textContent = message;
  }

  function showUnlockedNoReturn(): void {
    form.hidden = true;
    done.textContent = t('unlockedNoReturn');
    done.hidden = false;
  }

  async function onSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy || submit.disabled) return;
    busy = true;
    submit.disabled = true;
    showError('');
    try {
      await targetReady; // the token comes from the claim, which may still be on its way
      const res = await send({ type: 'unlock', password: input.value, token });
      input.value = '';
      if (res.ok) {
        unlocked = true;
        // The service worker navigates this tab when it holds a target for the token; otherwise,
        // or if nothing happened after a moment, say that the site can be opened again.
        // The extensions page that the guard sent here is opened by the worker: never claim there is nothing to open.
        if (token === undefined) showUnlockedNoReturn();
        else if (kind !== 'extensions') setTimeout(showUnlockedNoReturn, NO_RETURN_MS);
        return;
      }
      if (res.state.waitMs > 0) countdown.start(res.state.waitMs);
      else showError(wrongPasswordText(res.state.triesLeft));
      // The disabled button had the focus after a click; keep keyboard users in the field.
      input.focus();
    } catch (err) {
      input.value = '';
      console.warn('unlock failed', err);
    } finally {
      busy = false;
      // Stay disabled while a wait runs or the tab is being sent back to the site.
      if (!countdown.active && !unlocked) submit.disabled = false;
    }
  }

  form.addEventListener('submit', (event) => void onSubmit(event));
  input.focus();

  // A wait started earlier (or on another lock page) still applies after a reload.
  send({ type: 'getState' })
    .then((res) => {
      if (res.state.waitMs > 0) countdown.start(res.state.waitMs);
    })
    .catch((err) => console.warn('getState failed', err));
}

if (typeof document !== 'undefined') init();
