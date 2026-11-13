import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { applyI18n, t } from '../../src/lib/i18n';

type Messages = Record<string, { message: string }>;

function load(locale: string): Messages {
  const file = resolve(__dirname, '../../public/_locales', locale, 'messages.json');
  return JSON.parse(readFileSync(file, 'utf8')) as Messages;
}

const en = load('en');
const others = ['ko', 'ja'] as const;

describe('locale files', () => {
  it('have identical key sets', () => {
    const keys = Object.keys(en).sort();
    for (const locale of others) {
      expect(Object.keys(load(locale)).sort(), locale).toEqual(keys);
    }
  });

  it('hold a non-empty string message for every key', () => {
    for (const locale of ['en', ...others]) {
      for (const [key, entry] of Object.entries(load(locale))) {
        expect(typeof entry.message, `${locale}.${key}`).toBe('string');
        expect(entry.message.trim().length, `${locale}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('use $1 in a translation exactly when English does', () => {
    for (const locale of others) {
      const messages = load(locale);
      for (const [key, entry] of Object.entries(en)) {
        expect(messages[key]?.message.includes('$1'), `${locale}.${key}`).toBe(
          entry.message.includes('$1'),
        );
      }
    }
  });

  it('keep the short name unchanged in every locale', () => {
    for (const locale of ['en', ...others]) {
      expect(load(locale).extShortName?.message).toBe('For My Privacy');
    }
  });
});

describe('t', () => {
  afterEach(() => vi.restoreAllMocks());

  it('falls back to the bundled English when no i18n API is available', () => {
    expect(t('lockTitle')).toBe(en.lockTitle?.message);
    expect(t('lockSubtitle', 'a.test')).toBe('Enter your password to open a.test.');
  });

  it('falls back to the bundled English when chrome.i18n has no entry for a key of this build', () => {
    vi.spyOn(browser.i18n, 'getMessage').mockImplementation((() => '') as never);
    expect(t('settingsUnlockHint')).toBe(en.settingsUnlockHint?.message);
    expect(t('forgotSummary')).toBe(en.forgotSummary?.message);
  });

  it('uses chrome.i18n when it answers', () => {
    vi.spyOn(browser.i18n, 'getMessage').mockImplementation((() => '잠김') as never);
    expect(t('lockTitle')).toBe('잠김');
  });

  it('never shows a key name: an unknown key gives an empty string and a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(t('noSuchKey')).toBe('');
    expect(warn).toHaveBeenCalled();
  });

  it('has an English message for every key the pages ask for', () => {
    const pages = ['entrypoints/options/index.html', 'entrypoints/lock/index.html', 'entrypoints/popup/index.html'];
    for (const page of pages) {
      const html = readFileSync(resolve(__dirname, '../..', page), 'utf8');
      for (const [, key] of html.matchAll(/data-i18n(?:-placeholder|-aria)?="([^"]+)"/g)) {
        expect(en[key as string], `${page}: ${key}`).toBeDefined();
      }
    }
  });
});

describe('applyI18n', () => {
  it('is exported as a function', () => {
    expect(typeof applyI18n).toBe('function');
  });
});
