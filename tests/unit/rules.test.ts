import { afterEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import {
  ALL_RESOURCE_TYPES,
  RULE_FALLBACK_BLOCK,
  RULE_UNLOCK,
  RULE_REDIRECT,
  TOKEN_PATTERN,
  UNLOCK_MARKERS,
  buildBlockRules,
  clearUnlocked,
  domainsWithHostAccess,
  isUnlocked,
  lockPageToken,
  lockPageTokenUrl,
  readUnlock,
  setUnlocked,
  syncBlockRules,
} from '../../src/lib/rules';

// Every declarativeNetRequest resource type Chrome 120 supports.
const EVERY_TYPE = [
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
];

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
  condition: { requestDomains: domains, resourceTypes: EVERY_TYPE },
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

describe('resource types', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists every resource type once', () => {
    expect([...ALL_RESOURCE_TYPES].sort()).toEqual([...EVERY_TYPE].sort());
  });

  it('the block rule covers every type, the redirect only top-level navigations', () => {
    const [redirect, block] = buildBlockRules(['example.test'], ['example.test'], BASE);
    expect(redirect?.condition.resourceTypes).toEqual(['main_frame']);
    expect(block?.condition.resourceTypes).toEqual(EVERY_TYPE);
  });

  it('the unlock rule allows every type, so nothing of an unlocked site is blocked', async () => {
    const updateSessionRules = vi.fn(async (_options: unknown) => {});
    (browser as unknown as { declarativeNetRequest: unknown }).declarativeNetRequest = { updateSessionRules };
    await setUnlocked(['example.test']);
    expect(updateSessionRules).toHaveBeenCalledWith({
      removeRuleIds: [RULE_UNLOCK],
      addRules: [
        {
          id: RULE_UNLOCK,
          priority: 3,
          condition: {
            requestDomains: ['example.test', 'all.unlocked.for-my-privacy.invalid'],
            resourceTypes: EVERY_TYPE,
          },
          action: { type: 'allow' },
        },
      ],
    });
  });
});

describe('unlock rule scope marker and lock page tokens', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stubSession() {
    let session: Browser.declarativeNetRequest.Rule[] = [];
    (browser as unknown as { declarativeNetRequest: unknown }).declarativeNetRequest = {
      updateSessionRules: vi.fn(async (o: { removeRuleIds?: number[]; addRules?: Browser.declarativeNetRequest.Rule[] }) => {
        session = session.filter((r) => !(o.removeRuleIds ?? []).includes(r.id)).concat(o.addRules ?? []);
      }),
      getSessionRules: vi.fn(async () => session),
    };
  }

  it('records the scope in a marker domain and reads it back without the marker', async () => {
    stubSession();
    expect(await readUnlock()).toBeNull();
    await setUnlocked(['example.test'], 'site');
    expect(await readUnlock()).toEqual({ scope: 'site', domains: ['example.test'] });
    // Even an empty list keeps the rule (an 'all' unlock with nothing listed is still unlocked).
    await setUnlocked([]);
    expect(await readUnlock()).toEqual({ scope: 'all', domains: [] });
    expect(await isUnlocked()).toBe(true);
    // A marker passed in as a domain is not doubled or mixed in.
    await setUnlocked([UNLOCK_MARKERS.all, 'a.test'], 'site');
    expect(await readUnlock()).toEqual({ scope: 'site', domains: ['a.test'] });
    await clearUnlocked();
    expect(await isUnlocked()).toBe(false);
  });

  it('builds and parses #t= lock page URLs with well-formed tokens only', () => {
    const token = '0123456789abcdef0123456789abcdef';
    const url = lockPageTokenUrl(token);
    expect(url).toBe('chrome-extension://test-extension-id/lock.html#t=' + token);
    expect(lockPageToken(url)).toBe(token);
    expect(lockPageToken(url + 'x')).toBeUndefined();
    expect(lockPageToken('chrome-extension://test-extension-id/lock.html#t=../evil')).toBeUndefined();
    expect(lockPageToken('chrome-extension://other/lock.html#t=' + token)).toBeUndefined();
    expect(lockPageToken(undefined)).toBeUndefined();
    expect(TOKEN_PATTERN.test(token.toUpperCase())).toBe(false);
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
