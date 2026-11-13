import { describe, expect, it } from 'vitest';
import { cleanStoredDomain, hostMatches, suggestRelated } from '../../src/lib/domain';

describe('cleanStoredDomain', () => {
  it('keeps a stored domain and lower-cases it', () => {
    expect(cleanStoredDomain('instagram.com')).toBe('instagram.com');
    expect(cleanStoredDomain(' User.GitHub.io. ')).toBe('user.github.io');
    expect(cleanStoredDomain('xn--3e0b707e.kr')).toBe('xn--3e0b707e.kr');
  });

  it('rejects what cannot be a host name', () => {
    for (const bad of ['', 'com', 'a.*.com', 'ex_ample.com', '-a.com', '192.168.0.1', 'a b.com', 'http://a.com']) {
      expect(cleanStoredDomain(bad), bad).toBeNull();
    }
  });
});

describe('hostMatches', () => {
  it('matches the domain and its subdomains, case-insensitively', () => {
    expect(hostMatches('www.instagram.com', 'instagram.com')).toBe(true);
    expect(hostMatches('INSTAGRAM.COM.', 'instagram.com')).toBe(true);
  });

  it('does not match look-alike hosts', () => {
    expect(hostMatches('notinstagram.com', 'instagram.com')).toBe(false);
    expect(hostMatches('instagram.com.evil.net', 'instagram.com')).toBe(false);
  });
});

describe('suggestRelated', () => {
  it('returns known related domains', () => {
    expect(suggestRelated('instagram.com')).toEqual(['instagr.am']);
  });

  it('returns an empty list for unknown domains', () => {
    expect(suggestRelated('unknown.example')).toEqual([]);
  });
});
