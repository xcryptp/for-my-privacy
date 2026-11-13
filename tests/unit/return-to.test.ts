import { describe, expect, it } from 'vitest';
import { isExtensionsPage, safeReturnTo } from '../../src/lib/return-to';

const DOMAINS = ['example.test'];

describe('safeReturnTo', () => {
  it('safeReturnTo rejects foreign and non-http targets', () => {
    expect(safeReturnTo('javascript:alert(1)', DOMAINS)).toBeNull();
    expect(safeReturnTo('https://evil.test/', DOMAINS)).toBeNull();
    expect(safeReturnTo(undefined, DOMAINS)).toBeNull();
    expect(safeReturnTo('http://m.example.test/x', DOMAINS)).toBe('http://m.example.test/x');
    expect(safeReturnTo('chrome://extensions/?id=x', DOMAINS)).toBe('chrome://extensions/?id=x');
  });

  it('rejects look-alike hosts, other schemes and unparsable input', () => {
    expect(safeReturnTo('https://notexample.test/', DOMAINS)).toBeNull();
    expect(safeReturnTo('https://example.test.evil.test/', DOMAINS)).toBeNull();
    expect(safeReturnTo('https://evil.test/@example.test', DOMAINS)).toBeNull();
    expect(safeReturnTo('data:text/html,<p>x</p>', DOMAINS)).toBeNull();
    expect(safeReturnTo('file:///etc/passwd', DOMAINS)).toBeNull();
    expect(safeReturnTo('chrome://settings/', DOMAINS)).toBeNull();
    expect(safeReturnTo('not a url', DOMAINS)).toBeNull();
    expect(safeReturnTo('', DOMAINS)).toBeNull();
    expect(safeReturnTo('https://example.test/', [])).toBeNull();
  });

  it('accepts the domain itself, upper case and https', () => {
    expect(safeReturnTo('https://EXAMPLE.test/p?q=1#h', DOMAINS)).toBe('https://example.test/p?q=1#h');
  });
});

describe('isExtensionsPage', () => {
  it('matches chrome://extensions URLs only', () => {
    expect(isExtensionsPage('chrome://extensions')).toBe(true);
    expect(isExtensionsPage('chrome://extensions/?id=abc')).toBe(true);
    expect(isExtensionsPage('chrome://settings/')).toBe(false);
    expect(isExtensionsPage('https://example.test/chrome://extensions')).toBe(false);
  });
});
