import { hostMatches } from './domain';

/** Host permission patterns that cover a locked domain and all of its subdomains. */
export function originPatterns(domain: string): string[] {
  return [`*://${domain}/*`, `*://*.${domain}/*`];
}

/**
 * The origins to give back after `removed` left the list. Empty while a remaining site is the
 * same family (a subdomain or a parent of it): its access may rest on the very same grant, and
 * dropping that would make the worker report lost access for a site that is still listed.
 */
export function releasableOrigins(removed: string, remaining: string[]): string[] {
  const shared = remaining.some((d) => hostMatches(d, removed) || hostMatches(removed, d));
  return shared ? [] : originPatterns(removed);
}
