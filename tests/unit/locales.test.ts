import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
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
  it('falls back to the key when no i18n API is available', () => {
    expect(t('lockTitle')).toBe('lockTitle');
  });
});

describe('applyI18n', () => {
  it('is exported as a function', () => {
    expect(typeof applyI18n).toBe('function');
  });
});
