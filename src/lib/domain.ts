// Domain helpers that need no Public Suffix List: they are safe for the service worker and the lock
// page. Turning user input into a stored domain is `registrable-domain.ts` (options page and writes only).

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const RELATED: Record<string, string[]> = {
  'instagram.com': ['instagr.am'],
  'facebook.com': ['fb.com', 'messenger.com'],
  'twitter.com': ['x.com'],
  'x.com': ['twitter.com'],
  'youtube.com': ['youtu.be'],
  'reddit.com': ['redd.it'],
};

/**
 * A stored domain read back: lower-cased, without a trailing dot, kept only when every label is a
 * valid host label and there are at least two. Writes are already normalized (registrable domain), so
 * this is a cheap sanity check, not a re-normalization. Returns null for anything else.
 */
export function cleanStoredDomain(value: string): string | null {
  let domain = value.trim().toLowerCase();
  if (domain.endsWith('.')) domain = domain.slice(0, -1);
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null;
  if (/^\d+$/.test(labels[labels.length - 1] ?? '')) return null;
  return domain;
}

/** True when `host` is `domain` itself or one of its subdomains. */
export function hostMatches(host: string, domain: string): boolean {
  let h = host.toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  const d = domain.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

/** Known sibling domains the user may also want to lock. */
export function suggestRelated(domain: string): string[] {
  return [...(RELATED[domain] ?? [])];
}
