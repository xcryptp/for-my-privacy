import { afterEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import {
  RULE_FALLBACK_BLOCK,
  RULE_REDIRECT,
  buildBlockRules,
  domainsWithHostAccess,
  syncBlockRules,
} from '../../src/lib/rules';

const BASE = 'chrome-extension://abc/lock.html';

const redirectRule = (domains: string[]) => ({
  id: RULE_REDIRECT,
  priority: 2,
  condition: { requestDomains: domains, resourceTypes: ['main_frame'], regexFilter: '^(.*)$' },
  action: { type: 'redirect', redirect: { regexSubstitution: BASE + '#u=\\1' } },
});

const blockRule = (domains: string[]) => ({
  id: RULE_FALLBACK_BLOCK,
  priority: 1,
  condition: { requestDomains: domains, resourceTypes: ['main_frame', 'sub_frame'] },
  action: { type: 'block' },
});

describe('buildBlockRules', () => {
  it('returns [] for no domains', () => {
    expect(buildBlockRules([], [], BASE)).toEqual([]);
  });

  it('returns the redirect rule and the fallback block rule', () => {
    expect(buildBlockRules(['example.test'], ['example.test'], BASE)).toEqual([
      redirectRule(['example.test']),
      blockRule(['example.test']),
    ]);
  });

  it('redirects only the domains with host access but blocks all of them', () => {
    expect(buildBlockRules(['example.test', 'noperm.test'], ['example.test'], BASE)).toEqual([
      redirectRule(['example.test']),
      blockRule(['example.test', 'noperm.test']),
    ]);
  });

  it('returns only the block rule when no domain has host access', () => {
    expect(buildBlockRules(['noperm.test'], [], BASE)).toEqual([blockRule(['noperm.test'])]);
  });
});

describe('domainsWithHostAccess and syncBlockRules', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stubChrome(granted: string[]) {
    const contains = vi.fn(async ({ origins }: { origins: string[] }) =>
      granted.some((d) => origins.includes(`*://${d}/*`)),
    );
    const updateDynamicRules = vi.fn(async (_options: unknown) => {});
    vi.spyOn(browser.permissions, 'contains').mockImplementation(contains as never);
    (browser as unknown as { declarativeNetRequest: unknown }).declarativeNetRequest = { updateDynamicRules };
    return { contains, updateDynamicRules };
  }

  it('asks for the domain and its subdomains and keeps the granted ones', async () => {
    const { contains } = stubChrome(['example.test']);
    expect(await domainsWithHostAccess(['example.test', 'noperm.test'])).toEqual(['example.test']);
    expect(contains).toHaveBeenCalledWith({ origins: ['*://example.test/*', '*://*.example.test/*'] });
  });

  it('syncBlockRules redirects only granted domains', async () => {
    const { updateDynamicRules } = stubChrome(['example.test']);
    await syncBlockRules(['example.test', 'noperm.test']);
    const arg = updateDynamicRules.mock.calls[0]?.[0] as {
      removeRuleIds: number[];
      addRules: { id: number; condition: { requestDomains: string[] } }[];
    };
    expect(arg.removeRuleIds).toEqual([RULE_REDIRECT, RULE_FALLBACK_BLOCK]);
    expect(arg.addRules.map((r) => [r.id, r.condition.requestDomains])).toEqual([
      [RULE_REDIRECT, ['example.test']],
      [RULE_FALLBACK_BLOCK, ['example.test', 'noperm.test']],
    ]);
  });

  it('syncBlockRules([]) only removes the rules', async () => {
    const { updateDynamicRules } = stubChrome([]);
    await syncBlockRules([]);
    expect(updateDynamicRules).toHaveBeenCalledWith({
      removeRuleIds: [RULE_REDIRECT, RULE_FALLBACK_BLOCK],
      addRules: [],
    });
  });
});
