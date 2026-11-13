import { describe, expect, it } from 'vitest';
import { hostMatches, normalizeDomain, suggestRelated } from '../../src/lib/domain';

describe('normalizeDomain', () => {
  it('lower-cases and strips scheme, path, query and www', () => {
    expect(normalizeDomain('Instagram.com')).toBe('instagram.com');
    expect(normalizeDomain('https://www.instagram.com/explore?x=1')).toBe('instagram.com');
  });

  it('drops a leading wildcard and a trailing dot', () => {
    expect(normalizeDomain('*.instagram.com')).toBe('instagram.com');
    expect(normalizeDomain('instagram.com.')).toBe('instagram.com');
  });

  it('keeps a subdomain as given', () => {
    expect(normalizeDomain('m.instagram.com')).toBe('m.instagram.com');
  });

  it('converts internationalized names to punycode', () => {
    expect(normalizeDomain('한국.kr')).toBe('xn--3e0b707e.kr');
  });

  it('rejects input that is not a registrable-looking http(s) host', () => {
    for (const bad of ['', '   ', 'not a domain', 'localhost', 'chrome://extensions']) {
      expect(normalizeDomain(bad)).toBeNull();
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
