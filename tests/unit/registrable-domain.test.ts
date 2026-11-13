import { describe, expect, it } from 'vitest';
import { normalizeDomain, normalizeDomains, typedHost } from '../../src/lib/registrable-domain';

describe('normalizeDomain', () => {
  it('lower-cases and strips scheme, path, query and www', () => {
    expect(normalizeDomain('Instagram.com')).toBe('instagram.com');
    expect(normalizeDomain('https://www.instagram.com/explore?x=1')).toBe('instagram.com');
  });

  it('drops a leading wildcard and a trailing dot', () => {
    expect(normalizeDomain('*.instagram.com')).toBe('instagram.com');
    expect(normalizeDomain('instagram.com.')).toBe('instagram.com');
  });

  it('strips any run of leading wildcard and dot characters', () => {
    expect(normalizeDomain('*instagram.com')).toBe('instagram.com');
    expect(normalizeDomain('**.instagram.com')).toBe('instagram.com');
    expect(normalizeDomain('*.*.instagram.com')).toBe('instagram.com');
  });

  it('rejects hosts with characters that cannot be in a hostname', () => {
    for (const bad of ['a.*.com', 'ex!ample.com', 'ex_ample.com', '-a.com', 'a-.com']) {
      expect(normalizeDomain(bad)).toBeNull();
    }
  });

  it('rejects IP literals', () => {
    for (const bad of ['192.168.0.1', '127.1', '[::1]', 'http://[::1]/x']) {
      expect(normalizeDomain(bad)).toBeNull();
    }
  });

  it('recognizes the registrable domain behind any subdomain depth', () => {
    expect(normalizeDomain('m.instagram.com')).toBe('instagram.com');
    expect(normalizeDomain('a.b.c.example.com')).toBe('example.com');
    expect(normalizeDomain('*.*.instagram.com')).toBe('instagram.com');
    expect(normalizeDomain('https://m.blog.naver.com/abc?x=1')).toBe('naver.com');
  });

  it('recognizes the domain in a full URL with port, credentials, fragment and upper case', () => {
    expect(normalizeDomain('HTTPS://user:pw@WWW.Blog.Example.COM:8443/a/b?c=d#e')).toBe('example.com');
    expect(normalizeDomain('  https://x.com/home  ')).toBe('x.com');
  });

  it('knows multi-label public suffixes, ICANN and private', () => {
    expect(normalizeDomain('www.bbc.co.uk')).toBe('bbc.co.uk');
    expect(normalizeDomain('news.bbc.co.uk')).toBe('bbc.co.uk');
    expect(normalizeDomain('user.github.io')).toBe('user.github.io');
    expect(normalizeDomain('a.user.github.io')).toBe('user.github.io');
  });

  it('treats a name under an unknown suffix like .test as a normal domain', () => {
    expect(normalizeDomain('a.b.example.test')).toBe('example.test');
    expect(normalizeDomain('noperm.test')).toBe('noperm.test');
  });

  it('rejects a bare public suffix and a single label', () => {
    for (const bad of ['co.uk', 'github.io', 'com', 'localhost', 'https://co.uk/']) {
      expect(normalizeDomain(bad)).toBeNull();
    }
  });

  it('converts internationalized names to punycode', () => {
    expect(normalizeDomain('한국.kr')).toBe('xn--3e0b707e.kr');
    expect(normalizeDomain('https://www.예시.한국.kr/path')).toBe('xn--3e0b707e.kr');
  });

  it('rejects input that is not a registrable-looking http(s) host', () => {
    for (const bad of ['', '   ', 'not a domain', 'localhost', 'chrome://extensions']) {
      expect(normalizeDomain(bad)).toBeNull();
    }
  });
});

describe('normalizeDomain, input that is not a site', () => {
  it('rejects an e-mail style input without a scheme', () => {
    for (const bad of ['me@example.com', 'user@mail.example.com', '@example.com']) {
      expect(normalizeDomain(bad)).toBeNull();
    }
  });

  it('still reads credentials in a full URL', () => {
    expect(normalizeDomain('https://user:pw@example.com/')).toBe('example.com');
  });

  it('rejects names reserved for the local machine or network', () => {
    for (const bad of ['localhost', 'a.localhost', 'printer.local', 'nas.internal', 'a.b.internal', 'router.home.arpa', 'home.arpa']) {
      expect(normalizeDomain(bad), bad).toBeNull();
    }
  });

  it('keeps .test and look-alike names that merely contain a reserved word', () => {
    expect(normalizeDomain('example.test')).toBe('example.test');
    expect(normalizeDomain('localhost.com')).toBe('localhost.com');
    expect(normalizeDomain('internal.example.com')).toBe('example.com');
  });
});

describe('typedHost', () => {
  it('is the host as typed, without www and a trailing dot', () => {
    expect(typedHost('https://m.blog.naver.com/abc')).toBe('m.blog.naver.com');
    expect(typedHost('WWW.Instagram.com')).toBe('instagram.com');
    expect(typedHost('*.example.com.')).toBe('example.com');
  });

  it('is null for input that is not a host', () => {
    expect(typedHost('not a domain')).toBeNull();
    expect(typedHost('localhost')).toBeNull();
    expect(typedHost('')).toBeNull();
  });
});

describe('normalizeDomains', () => {
  it('normalizes, deduplicates and drops what is not a domain', () => {
    expect(normalizeDomains(['m.a.com', 'A.com', 5, 'bad', null])).toEqual(['a.com']);
  });
});
