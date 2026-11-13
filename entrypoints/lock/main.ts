import { browser } from 'wxt/browser';
import { applyI18n, t } from '../../src/lib/i18n';
import { send } from '../../src/lib/messages';
import { isExtensionsPage, safeReturnTo } from '../../src/lib/return-to';
import { getSettings } from '../../src/lib/settings';

/** The original URL the redirect rule put after the first `#u=` (it may itself contain `#`). */
export function parseReturnTo(hash: string): string | undefined {
  const marker = '#u=';
  if (!hash.startsWith(marker)) return undefined;
  return hash.slice(marker.length) || undefined;
}

/** Remaining wait as `m:ss`, rounded up so it never shows 0:00 while the wait is still running. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** What the subtitle calls the target: the host of an http(s) URL, or the extensions page. */
export function hostLabel(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (isExtensionsPage(url)) return 'chrome://extensions';
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname : undefined;
  } catch {
    return undefined;
  }
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

function init(): void {
  const form = byId<HTMLFormElement>('form');
  const input = byId<HTMLInputElement>('password');
  const submit = byId<HTMLButtonElement>('submit');
  const error = byId<HTMLElement>('error');
  const done = byId<HTMLElement>('done');
  const subtitle = byId<HTMLElement>('subtitle');
  const settings = byId<HTMLAnchorElement>('settings');

  const returnTo = parseReturnTo(location.hash);
  let countdownTimer: ReturnType<typeof setInterval> | undefined;
  let busy = false;
  let unlocked = false;

  applyI18n();
  document.documentElement.lang = browser.i18n.getUILanguage();
  const host = hostLabel(returnTo);
  if (host) {
    subtitle.textContent = t('lockSubtitle', host);
    subtitle.hidden = false;
  }
  // The options page is a build-time entrypoint of a later task; the cast keeps this file
  // compiling until WXT knows the path, and the click handler reuses an open options tab.
  settings.href = browser.runtime.getURL('/options.html' as never);
  settings.addEventListener('click', (event) => {
    event.preventDefault();
    browser.runtime.openOptionsPage().catch(() => window.open(settings.href));
  });

  function stopCountdown(): void {
    if (countdownTimer !== undefined) clearInterval(countdownTimer);
    countdownTimer = undefined;
    error.removeAttribute('aria-live');
  }

  function showError(message: string): void {
    stopCountdown();
    error.textContent = message;
  }

  /** Shows the wait as `m:ss`, updated every second; the button stays disabled until it ends. */
  function startCountdown(waitMs: number): void {
    stopCountdown();
    const until = Date.now() + waitMs;
    const render = () => {
      const left = until - Date.now();
      if (left <= 0) {
        stopCountdown();
        error.textContent = '';
        submit.disabled = false;
        input.focus();
        return;
      }
      error.textContent = t('tooManyAttempts', formatCountdown(left));
    };
    submit.disabled = true;
    render();
    // The alert is announced once with the first value; later ticks stay silent for screen readers.
    window.setTimeout(() => {
      if (countdownTimer !== undefined) error.setAttribute('aria-live', 'off');
    }, 100);
    countdownTimer = setInterval(render, 1000);
  }

  async function onSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy || submit.disabled) return;
    busy = true;
    submit.disabled = true;
    showError('');
    try {
      const res = await send({ type: 'unlock', password: input.value, returnTo });
      if (res.ok) {
        unlocked = true;
        // The service worker navigates this tab when the target is safe; otherwise say so.
        const target = safeReturnTo(returnTo, (await getSettings()).domains);
        if (target === null) {
          form.hidden = true;
          done.textContent = t('unlockedNoReturn');
          done.hidden = false;
        }
        return;
      }
      input.value = '';
      if (res.state.waitMs > 0) startCountdown(res.state.waitMs);
      else showError(t('wrongPassword'));
      if (res.state.waitMs <= 0) input.focus();
    } catch (err) {
      console.warn('unlock failed', err);
    } finally {
      busy = false;
      // Stay disabled while a wait runs or the tab is being sent back to the site.
      if (countdownTimer === undefined && !unlocked) submit.disabled = false;
    }
  }

  form.addEventListener('submit', (event) => void onSubmit(event));
  input.focus();

  // A wait started earlier (or on another lock page) still applies after a reload.
  send({ type: 'getState' })
    .then((res) => {
      if (res.state.waitMs > 0) startCountdown(res.state.waitMs);
    })
    .catch((err) => console.warn('getState failed', err));
}

if (typeof document !== 'undefined') init();
