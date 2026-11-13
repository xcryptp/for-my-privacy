import { browser } from 'wxt/browser';

type Rule = Browser.declarativeNetRequest.Rule;

export const RULE_REDIRECT = 1;
export const RULE_FALLBACK_BLOCK = 2;
export const RULE_UNLOCK = 100;

const lockPageBase = () => browser.runtime.getURL('/lock.html');

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

/** Session allow rule: lets `domains` through until it is cleared or the browser restarts. */
export async function setUnlocked(domains: string[]): Promise<void> {
  await browser.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [RULE_UNLOCK],
    addRules:
      domains.length === 0
        ? []
        : ([
            {
              id: RULE_UNLOCK,
              priority: 3,
              condition: { requestDomains: domains, resourceTypes: [...ALL_RESOURCE_TYPES] },
              action: { type: 'allow' },
            },
          ] as Rule[]),
  });
}

export async function clearUnlocked(): Promise<void> {
  await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE_UNLOCK] });
}

export async function isUnlocked(): Promise<boolean> {
  const rules = await browser.declarativeNetRequest.getSessionRules();
  return rules.some((r) => r.id === RULE_UNLOCK);
}

/** The lock page URL for `originalUrl`, in the same format the redirect rule produces. */
export function lockPageUrl(originalUrl: string): string {
  return lockPageBase() + '#u=' + originalUrl;
}

/** The original URL inside a lock page URL (everything after the first `#u=`), else undefined. */
export function lockPageTarget(url: string | undefined): string | undefined {
  const prefix = lockPageBase() + '#u=';
  if (!url?.startsWith(prefix)) return undefined;
  return url.slice(prefix.length) || undefined;
}
