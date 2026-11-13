import { browser } from 'wxt/browser';

/** Look up a localized message; falls back to the key where `chrome.i18n` is unavailable or has no entry. */
export function t(key: string, subs?: string | string[]): string {
  try {
    const getMessage = (
      browser as unknown as { i18n?: { getMessage?: (key: string, subs?: string | string[]) => string } }
    ).i18n?.getMessage;
    const message = getMessage?.call(browser.i18n, key, subs);
    return message || key;
  } catch {
    return key;
  }
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
