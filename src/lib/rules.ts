import { browser } from 'wxt/browser';
import type { UnlockScope } from './settings';

type Rule = Browser.declarativeNetRequest.Rule;

export const RULE_REDIRECT = 1;
export const RULE_FALLBACK_BLOCK = 2;
export const RULE_UNLOCK = 100;

/** The lock page without a target. */
export const lockPageBase = () => browser.runtime.getURL('/lock.html');

/**
 * Every declarativeNetRequest resource type Chrome 120 knows. The block and unlock rules cover
 * all of them: a page shell served by the site's own service worker never reaches the network,
 * so while locked its data requests must fail too, and while unlocked nothing may be blocked.
 */
export const ALL_RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other',
] as const satisfies readonly `${Browser.declarativeNetRequest.ResourceType}`[];

/**
 * Dynamic rules for the locked domains. `requestDomains` matches each domain and all its
 * subdomains. The redirect (priority 2) sends top-level navigations to the lock page; it lists
 * only `redirectDomains`, the domains the extension has host access to. Chrome picks the highest
 * priority match, cannot apply a redirect without host access and then does not fall back to a
 * lower rule, so a domain without access must not be in the redirect rule. The block rule
 * (priority 1) covers every domain and every resource type: it is the fallback for those domains,
 * for iframes and for anything a service-worker-served page of a locked site requests.
 * The redirect must outrank the block because block wins at equal priority.
 */
export function buildBlockRules(domains: string[], redirectDomains: string[], lockPageBase: string): Rule[] {
  if (domains.length === 0) return [];
  const rules: Rule[] = [];
  if (redirectDomains.length > 0) {
    rules.push({
      id: RULE_REDIRECT,
      priority: 2,
      condition: { requestDomains: redirectDomains, resourceTypes: ['main_frame'], regexFilter: '^(.*)$' },
      action: { type: 'redirect', redirect: { regexSubstitution: lockPageBase + '#u=\\1' } },
    } as Rule);
  }
  rules.push({
    id: RULE_FALLBACK_BLOCK,
    priority: 1,
    condition: { requestDomains: domains, resourceTypes: [...ALL_RESOURCE_TYPES] },
    action: { type: 'block' },
  } as Rule);
  return rules;
}

/** The subset of `domains` whose domain and subdomains the extension has host permission for. */
export async function domainsWithHostAccess(domains: string[]): Promise<string[]> {
  const granted = await Promise.all(
    domains.map((d) => browser.permissions.contains({ origins: [`*://${d}/*`, `*://*.${d}/*`] })),
  );
  return domains.filter((_, i) => granted[i]);
}

/** Replaces the dynamic block rules with the ones for `domains` (none removes them). */
export async function syncBlockRules(domains: string[]): Promise<void> {
  const redirectDomains = await domainsWithHostAccess(domains);
  await browser.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_REDIRECT, RULE_FALLBACK_BLOCK],
    addRules: buildBlockRules(domains, redirectDomains, lockPageBase()),
  });
}

// The session allow rule carries one marker domain that says which unlock scope created it, so
// the rule exists even with no locked domains (otherwise an unlock with an empty list would read
// as locked) and a scope change can be detected from the rule alone. `.invalid` is reserved
// (RFC 2606) and never resolves, so allowing it lets nothing through.
export const UNLOCK_MARKERS: Record<UnlockScope, string> = {
  all: 'all.unlocked.for-my-privacy.invalid',
  site: 'site.unlocked.for-my-privacy.invalid',
};
const MARKER_DOMAINS = new Set(Object.values(UNLOCK_MARKERS));

/** The session unlock: the scope that created it (null for an unknown marker) and its domains. */
export interface UnlockRule {
  scope: UnlockScope | null;
  domains: string[];
}

/**
 * Session allow rule: lets `domains` through until it is cleared or the browser restarts.
 * `scope` is recorded in the rule's marker domain.
 */
export async function setUnlocked(domains: string[], scope: UnlockScope = 'all'): Promise<void> {
  await browser.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [RULE_UNLOCK],
    addRules: [
      {
        id: RULE_UNLOCK,
        priority: 3,
        condition: {
          requestDomains: [...domains.filter((d) => !MARKER_DOMAINS.has(d)), UNLOCK_MARKERS[scope]],
          resourceTypes: [...ALL_RESOURCE_TYPES],
        },
        action: { type: 'allow' },
      },
    ] as Rule[],
  });
}

export async function clearUnlocked(): Promise<void> {
  await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE_UNLOCK] });
}

export async function isUnlocked(): Promise<boolean> {
  return (await readUnlock()) !== null;
}

/** The session unlock rule, or null while locked. Throws when the rules cannot be read. */
export async function readUnlock(): Promise<UnlockRule | null> {
  const rules = await browser.declarativeNetRequest.getSessionRules();
  const rule = rules.find((r) => r.id === RULE_UNLOCK);
  if (!rule) return null;
  const listed = rule.condition.requestDomains ?? [];
  const scope =
    (Object.keys(UNLOCK_MARKERS) as UnlockScope[]).find((s) => listed.includes(UNLOCK_MARKERS[s])) ?? null;
  return { scope, domains: listed.filter((d) => !MARKER_DOMAINS.has(d)) };
}

/** Lock page tokens: 32 lower-case hex characters (16 random bytes). */
export const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

/** The lock page URL for a target token; the private URL itself stays in the service worker. */
export function lockPageTokenUrl(token: string): string {
  return lockPageBase() + '#t=' + token;
}

/** The token inside a `#t=` lock page URL of this extension, else undefined. */
export function lockPageToken(url: string | undefined): string | undefined {
  const prefix = lockPageBase() + '#t=';
  if (!url?.startsWith(prefix)) return undefined;
  const token = url.slice(prefix.length);
  return TOKEN_PATTERN.test(token) ? token : undefined;
}
