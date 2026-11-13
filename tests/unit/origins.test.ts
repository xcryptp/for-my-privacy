import { describe, expect, it } from 'vitest';
import { originPatterns, releasableOrigins } from '../../src/lib/origins';

describe('originPatterns', () => {
  it('covers the domain and all its subdomains on http and https', () => {
    expect(originPatterns('example.com')).toEqual(['*://example.com/*', '*://*.example.com/*']);
  });
});

describe('releasableOrigins', () => {
  it('releases the origins of a removed site nobody else needs', () => {
    expect(releasableOrigins('example.com', ['other.org'])).toEqual(['*://example.com/*', '*://*.example.com/*']);
    expect(releasableOrigins('example.com', [])).toEqual(['*://example.com/*', '*://*.example.com/*']);
  });

  it('keeps them while a remaining site is a subdomain of the removed one', () => {
    expect(releasableOrigins('example.com', ['a.example.com'])).toEqual([]);
  });

  it('keeps them while a remaining site is a parent of the removed one', () => {
    expect(releasableOrigins('a.example.com', ['example.com'])).toEqual([]);
  });

  it('does not treat look-alike names as related', () => {
    expect(releasableOrigins('example.com', ['notexample.com'])).toEqual(['*://example.com/*', '*://*.example.com/*']);
  });
});
