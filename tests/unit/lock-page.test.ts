import { describe, expect, it } from 'vitest';
import { formatCountdown, hostLabel, parseReturnTo } from '../../entrypoints/lock/main';

describe('parseReturnTo', () => {
  it('returns the text after the first #u=', () => {
    expect(parseReturnTo('#u=http://a.test/x#y')).toBe('http://a.test/x#y');
    expect(parseReturnTo('#u=http://a.test/?next=#u=1')).toBe('http://a.test/?next=#u=1');
  });

  it('returns undefined without a usable target', () => {
    expect(parseReturnTo('')).toBeUndefined();
    expect(parseReturnTo('#x')).toBeUndefined();
    expect(parseReturnTo('#u=')).toBeUndefined();
  });
});

describe('formatCountdown', () => {
  it('formats m:ss and rounds partial seconds up', () => {
    expect(formatCountdown(30_000)).toBe('0:30');
    expect(formatCountdown(900_000)).toBe('15:00');
    expect(formatCountdown(61_000)).toBe('1:01');
    expect(formatCountdown(1)).toBe('0:01');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-5)).toBe('0:00');
  });
});

describe('hostLabel', () => {
  it('names the host of an http(s) target', () => {
    expect(hostLabel('https://www.example.test/a?b#c')).toBe('www.example.test');
  });

  it('names the extensions page and ignores anything else', () => {
    expect(hostLabel('chrome://extensions/?id=x')).toBe('chrome://extensions');
    expect(hostLabel('javascript:alert(1)')).toBeUndefined();
    expect(hostLabel('not a url')).toBeUndefined();
    expect(hostLabel(undefined)).toBeUndefined();
  });
});
