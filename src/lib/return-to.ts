// Pure helpers shared by the service worker and the extension pages (no browser APIs).
import { hostMatches } from './domain';

/** The extensions management page, guarded while locked. */
export function isExtensionsPage(url: string): boolean {
  return url.startsWith('chrome://extensions');
}

/**
 * Where a tab may go after unlocking: an http(s) URL on one of the locked domains (or their
 * subdomains), or the extensions page the guard sent to the lock page. Anything else (other
 * hosts, `javascript:`, `data:`, unparsable text) returns null, so the lock page URL cannot be
 * turned into an open redirect or script injection.
 */
export function safeReturnTo(url: string | undefined, domains: string[]): string | null {
  if (!url) return null;
  if (isExtensionsPage(url)) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!domains.some((d) => hostMatches(parsed.hostname, d))) return null;
  return parsed.href;
}
