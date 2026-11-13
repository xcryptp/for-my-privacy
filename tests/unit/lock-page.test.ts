import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { listedDomainFor, parseReturnTo, parseToken, scopeHintText, wrongPasswordText } from '../../entrypoints/lock/main';
import { countdownParts, formatCountdown, shouldRefocus } from '../../src/ui/countdown';

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

// A stand-in for chrome.i18n: names the key and the substitutions.
const tr = (key: string, subs?: string | string[]) => `${key}(${[subs ?? []].flat().join(',')})`;

describe('countdownParts', () => {
  it('splits into minutes and seconds and rounds partial seconds up', () => {
    expect(countdownParts(30_000)).toEqual({ minutes: 0, seconds: 30 });
    expect(countdownParts(900_000)).toEqual({ minutes: 15, seconds: 0 });
    expect(countdownParts(125_000)).toEqual({ minutes: 2, seconds: 5 });
    expect(countdownParts(1)).toEqual({ minutes: 0, seconds: 1 });
    expect(countdownParts(0)).toEqual({ minutes: 0, seconds: 0 });
    expect(countdownParts(-5)).toEqual({ minutes: 0, seconds: 0 });
  });
});

describe('formatCountdown', () => {
  it('uses unit words: seconds under a minute, minutes alone, or both', () => {
    expect(formatCountdown(30_000, tr)).toBe('waitSeconds(30)');
    expect(formatCountdown(60_000, tr)).toBe('waitMinutes(1)');
    expect(formatCountdown(900_000, tr)).toBe('waitMinutes(15)');
    expect(formatCountdown(125_000, tr)).toBe('waitMinutesSeconds(2,5)');
    expect(formatCountdown(61_000, tr)).toBe('waitMinutesSeconds(1,1)');
  });

  it('never shows zero while a wait is still running', () => {
    expect(formatCountdown(1, tr)).toBe('waitSeconds(1)');
  });
});

describe('shouldRefocus', () => {
  const [page, button, input, other] = [{}, {}, {}, {}] as Element[];

  it('refocuses the field when the focus is on the page, the disabled button, the field or nowhere', () => {
    expect(shouldRefocus(null, page!, button!, input!)).toBe(true);
    expect(shouldRefocus(page!, page!, button!, input!)).toBe(true);
    expect(shouldRefocus(button!, page!, button!, input!)).toBe(true);
    expect(shouldRefocus(input!, page!, button!, input!)).toBe(true);
  });

  it('leaves a control the person moved to alone', () => {
    expect(shouldRefocus(other!, page!, button!, input!)).toBe(false);
  });
});

describe('wrongPasswordText', () => {
  it('says how many tries are left while there are some', () => {
    expect(wrongPasswordText(4, tr)).toBe('wrongPasswordTries(4)');
    expect(wrongPasswordText(2, tr)).toBe('wrongPasswordTries(2)');
    expect(wrongPasswordText(1, tr)).toBe('wrongPasswordLastTry()');
  });

  it('is the plain message when no count is available or none is left', () => {
    expect(wrongPasswordText(0, tr)).toBe('wrongPassword()');
    expect(wrongPasswordText(undefined, tr)).toBe('wrongPassword()');
  });
});

describe('scopeHintText', () => {
  it('follows the unlock setting and names the listed domain, not the host', () => {
    expect(scopeHintText('all', { domain: 'example.test' }, tr)).toBe('unlockHintAll()');
    expect(scopeHintText('site', { domain: 'example.test' }, tr)).toBe('unlockHintSite(example.test)');
    expect(scopeHintText('site', {}, tr)).toBe('unlockHintThisSite()');
  });

  it('says the extensions page is opened for that target in site scope', () => {
    expect(scopeHintText('site', { kind: 'extensions' }, tr)).toBe('unlockHintExtensions()');
    expect(scopeHintText('all', { kind: 'extensions' }, tr)).toBe('unlockHintAll()');
  });
});

describe('listedDomainFor', () => {
  it('prefers the answered domain, else finds the stored domain the host falls under', () => {
    expect(listedDomainFor('m.example.test', 'example.test', ['other.test'])).toBe('example.test');
    expect(listedDomainFor('m.example.test', undefined, ['other.test', 'example.test'])).toBe('example.test');
    expect(listedDomainFor('m.example.test', undefined, ['other.test'])).toBeUndefined();
    expect(listedDomainFor(undefined, undefined, ['example.test'])).toBeUndefined();
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

describe('warning box contrast', () => {
  const css = read('src/ui/base.css');
  const split = css.indexOf('@media (prefers-color-scheme: dark)');
  const token = (block: string, name: string) => block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1] as string;

  it.each([
    ['light', css.slice(0, split)],
    ['dark', css.slice(split)],
  ])('the %s warning text is at least 4.5:1 on its background', (_theme, block) => {
    expect(contrast(token(block, 'warn'), token(block, 'warn-bg'))).toBeGreaterThanOrEqual(4.5);
  });
});
