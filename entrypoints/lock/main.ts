import { browser } from 'wxt/browser';
import { applyI18n, t } from '../../src/lib/i18n';
import { send } from '../../src/lib/messages';
import { getSettings, type UnlockScope } from '../../src/lib/settings';
import { createCountdown, formatCountdown } from '../../src/ui/countdown';

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

/** The message after a wrong password: how many tries are left before the wait, while there are some. */
export function wrongPasswordText(triesLeft: number | undefined, tr: typeof t = t): string {
  if (typeof triesLeft !== 'number' || triesLeft <= 0) return tr('wrongPassword');
  return triesLeft === 1 ? tr('wrongPasswordLastTry') : tr('wrongPasswordTries', String(triesLeft));
}

/** The muted line under the Unlock button: what one unlock opens, following the unlock setting. */
export function scopeHintText(scope: UnlockScope, host: string | undefined, tr: typeof t = t): string {
  if (scope === 'site') return host ? tr('unlockHintSite', host) : tr('unlockHintThisSite');
  return tr('unlockHintAll');
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

  async function resolveTarget(): Promise<void> {
    const raw = parseReturnTo(location.hash);
    const known = parseToken(location.hash);
    try {
      if (raw !== undefined) {
        const res = await send({ type: 'claimTarget', raw });
        if (res.ok) {
          token = res.token;
          host = res.host;
          history.replaceState(null, '', `#t=${res.token}`);
        } else {
          // Nothing safe to return to: drop the address from the bar all the same.
          history.replaceState(null, '', location.pathname + location.search);
        }
      } else if (known !== undefined) {
        const res = await send({ type: 'describeTarget', token: known });
        if (res.ok) {
          token = known;
          host = res.host;
        }
      }
    } catch (err) {
      console.warn('target lookup failed', err);
    }
    if (host) {
      subtitle.textContent = t('lockSubtitle', host);
      subtitle.hidden = false;
    }
  }

  // The line under Unlock follows the unlock setting; "all" is also what a failed read means.
  const targetReady = resolveTarget();
  Promise.all([targetReady, getSettings().then((current) => current.unlockScope, () => 'all' as UnlockScope)])
    .then(([, scope]) => {
      scopeHint.textContent = scopeHintText(scope, host);
      scopeHint.hidden = false;
    })
    .catch((err) => console.warn('hint failed', err));

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
        if (token === undefined) showUnlockedNoReturn();
        else setTimeout(showUnlockedNoReturn, NO_RETURN_MS);
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
