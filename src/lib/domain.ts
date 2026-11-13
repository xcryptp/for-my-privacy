const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

const RELATED: Record<string, string[]> = {
  'instagram.com': ['instagr.am'],
  'facebook.com': ['fb.com', 'messenger.com'],
  'twitter.com': ['x.com'],
  'x.com': ['twitter.com'],
  'youtube.com': ['youtu.be'],
  'reddit.com': ['redd.it'],
};

/**
 * Turns user input (a bare domain, a wildcard or a full URL) into the stored domain form:
 * lower-case, punycode, no trailing dot, no leading `www.`. Returns null when the input
 * is not an http(s) host with at least one dot.
 */
export function normalizeDomain(input: string): string | null {
  let value = input.trim();
  if (value.startsWith('*.')) value = value.slice(2);
  if (!value) return null;
  if (!SCHEME.test(value)) value = `http://${value}`;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  let host = url.hostname;
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.startsWith('www.')) host = host.slice(4);
  if (!host.includes('.') || host.startsWith('.') || host.endsWith('.')) return null;
  return host;
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
