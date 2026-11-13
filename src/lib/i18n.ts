import { browser } from 'wxt/browser';
// The English messages of this same build. Chrome keeps the `_locales` of an extension it loaded
// earlier when the folder is replaced without a reload, so a key of this build can be missing
// from `chrome.i18n`; this copy always has it (it is bundled, nothing is fetched).
import english from '../../public/_locales/en/messages.json';

const FALLBACK: Readonly<Record<string, { message: string }>> = english;

function fill(message: string, subs?: string | string[]): string {
  const list = subs === undefined ? [] : [subs].flat();
  return message.replace(/\$([1-9])/g, (whole, n: string) => list[Number(n) - 1] ?? whole);
}

/**
 * Look up a localized message. When `chrome.i18n` is unavailable or has no entry, the bundled
 * English message is used; a key that exists nowhere gives an empty string (never the key name).
 */
export function t(key: string, subs?: string | string[]): string {
  try {
    const getMessage = (
      browser as unknown as { i18n?: { getMessage?: (key: string, subs?: string | string[]) => string } }
    ).i18n?.getMessage;
    const message = getMessage?.call(browser.i18n, key, subs);
    if (message) return message;
  } catch {
    // fall through to the bundled English
  }
  const bundled = FALLBACK[key]?.message;
  if (bundled === undefined) {
    console.warn(`missing message: ${key}`);
    return '';
  }
  return fill(bundled, subs);
}

/** Fill `[data-i18n]` text, `[data-i18n-placeholder]` placeholders and `[data-i18n-aria]` aria-labels under `root`. */
export function applyI18n(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n ?? '');
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-placeholder]')) {
    el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder ?? ''));
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-aria]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAria ?? ''));
  }
}
