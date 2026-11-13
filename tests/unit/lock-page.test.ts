import { readFileSync } from 'node:fs';
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

const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

describe('password managers', () => {
  it('never offers to save or fill the lock password (lock and options pages)', () => {
    for (const file of ['entrypoints/lock/index.html', 'entrypoints/options/index.html']) {
      const inputs = read(file).match(/<input[^>]*type="password"[^>]*>/g) ?? [];
      expect(inputs.length, file).toBeGreaterThan(0);
      for (const input of inputs) expect(input, file).toContain('autocomplete="new-password"');
    }
  });
});

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('input border contrast (WCAG 1.4.11)', () => {
  const css = read('src/ui/base.css');
  const [light, dark] = [css.slice(0, css.indexOf('@media (prefers-color-scheme: dark)')), css.slice(css.indexOf('@media (prefers-color-scheme: dark)'))];
  const token = (block: string, name: string) => block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1] as string;

  it.each([
    ['light', light],
    ['dark', dark],
  ])('the %s field outline is at least 3:1 against the card and the field fill', (_theme, block) => {
    const border = token(block, 'input-border');
    expect(border).toBeDefined();
    expect(contrast(border, token(block, 'surface'))).toBeGreaterThanOrEqual(3);
    expect(contrast(border, token(block, 'bg'))).toBeGreaterThanOrEqual(3);
  });

  it('uses the field outline token on inputs', () => {
    expect(css).toMatch(/input\[type='password'\][\s\S]*?border: 1px solid var\(--input-border\)/);
  });
});
