import { browser } from 'wxt/browser';
import { applyI18n, t } from '../../src/lib/i18n';
import { send } from '../../src/lib/messages';
import { isExtensionsPage, safeReturnTo } from '../../src/lib/return-to';
import { getSettings } from '../../src/lib/settings';
import { createCountdown, formatCountdown } from '../../src/ui/countdown';

export { formatCountdown };

/** The original URL the redirect rule put after the first `#u=` (it may itself contain `#`). */
export function parseReturnTo(hash: string): string | undefined {
  const marker = '#u=';
  if (!hash.startsWith(marker)) return undefined;
  return hash.slice(marker.length) || undefined;
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
  let busy = false;
  let unlocked = false;

  applyI18n();
  document.documentElement.lang = browser.i18n.getUILanguage();
  const host = hostLabel(returnTo);
  if (host) {
    subtitle.textContent = t('lockSubtitle', host);
    subtitle.hidden = false;
  }
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

  async function onSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy || submit.disabled) return;
    busy = true;
    submit.disabled = true;
    showError('');
    try {
      const res = await send({ type: 'unlock', password: input.value, returnTo });
      input.value = '';
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
      if (res.state.waitMs > 0) countdown.start(res.state.waitMs);
      else showError(t('wrongPassword'));
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
