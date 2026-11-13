import { getDomain } from 'tldts';

// The only module that reads the Public Suffix List (tldts). The service worker and the lock page
// never import it: they work with domains that were already normalized when they were stored.

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Names reserved for the local machine or network: they are not sites on the internet. */
const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'home.arpa'];

function isLocalName(host: string): boolean {
  return LOCAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * The host named by user input (a bare domain, a wildcard, any full URL), lower-case, punycode, with
 * no trailing dot, or null when the input is not an http(s) host name. Input with `@` and no scheme
 * (an e-mail address) is not a host.
 */
function parseHost(input: string): string | null {
  let value = input.trim();
  value = value.replace(/^[*.]+/, '');
  if (!value) return null;
  if (!SCHEME.test(value)) {
    if (value.includes('@')) return null;
    value = `http://${value}`;
  }

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
  if (isLocalName(host)) return null;
  return host;
}

/**
 * Turns user input into the stored domain form: the registrable domain (public suffix plus one label,
 * from the Public Suffix List), lower-case, punycode, with no `www.`, subdomains or trailing dot.
 * Locking it also locks every subdomain, at any depth. Returns null when the input is not an http(s)
 * host with a registrable domain: IP literals, single labels, local names (`localhost`, `.local`,
 * `.internal`, `.home.arpa`), e-mail addresses and bare public suffixes such as `co.uk` are rejected.
 */
export function normalizeDomain(input: string): string | null {
  const host = parseHost(input);
  if (!host) return null;
  // Private suffixes count too: `user.github.io` is its own site, not a subdomain of github.io.
  // A host that is itself a public suffix has no registrable domain (null).
  return getDomain(host, { allowPrivateDomains: true });
}

/** The host the user typed, without `www.`; null when it is not a usable host (see `normalizeDomain`). */
export function typedHost(input: string): string | null {
  const host = parseHost(input);
  return host ? host.replace(/^www\./, '') : null;
}

/** Normalizes a list: invalid entries are dropped and the rest is deduplicated, keeping the order. */
export function normalizeDomains(values: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const item of values) {
    if (typeof item !== 'string') continue;
    const domain = normalizeDomain(item);
    if (domain) out.add(domain);
  }
  return [...out];
}
