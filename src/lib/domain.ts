import { getDomain } from 'tldts';

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

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
 * Turns user input (a bare domain, a wildcard, any full URL) into the stored domain form: the
 * registrable domain (public suffix plus one label, from the Public Suffix List), lower-case,
 * punycode, with no `www.`, subdomains or trailing dot. Locking it also locks every subdomain, at any
 * depth. Returns null when the input is not an http(s) host with a registrable domain: IP literals,
 * single labels such as `localhost` and bare public suffixes such as `co.uk` are rejected.
 */
export function normalizeDomain(input: string): string | null {
  let value = input.trim();
  value = value.replace(/^[*.]+/, '');
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
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null;
  // Sites are locked by name: an all-numeric last label is an IPv4 literal (IPv6 fails LABEL above).
  if (/^\d+$/.test(labels[labels.length - 1] ?? '')) return null;

  // Private suffixes count too: `user.github.io` is its own site, not a subdomain of github.io.
  // A host that is itself a public suffix has no registrable domain (null).
  return getDomain(host, { allowPrivateDomains: true });
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
