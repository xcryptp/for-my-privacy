import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LEARN_MORE_URL,
  ONBOARDING_STEPS,
  PRESET_SITES,
  addCustomSite,
  doneTipText,
  nextStep,
  prevStep,
  selectedOrigins,
  toggleSite,
  ONBOARDING_KEY,
  parseProgress,
  previewFor,
  resumeStep,
  wildcardForm,
  commitTypedSite,
  doneTipKey,
  limitsUrl,
  nextLabelKey,
  readmeLang,
} from '../../entrypoints/options/onboarding';

describe('step navigation', () => {
  it('has four steps and never leaves 1..4', () => {
    expect(ONBOARDING_STEPS).toBe(4);
    expect(nextStep(1)).toBe(2);
    expect(nextStep(4)).toBe(4);
    expect(prevStep(4)).toBe(3);
    expect(prevStep(1)).toBe(1);
  });
});

describe('preset sites', () => {
  it('are the five from the brief, already in stored form', () => {
    expect(PRESET_SITES).toEqual(['instagram.com', 'facebook.com', 'x.com', 'tiktok.com', 'youtube.com']);
  });
});

describe('toggleSite', () => {
  it('adds a missing site and removes a present one, without touching the input', () => {
    const selected = ['x.com'];
    expect(toggleSite(selected, 'youtube.com')).toEqual(['x.com', 'youtube.com']);
    expect(toggleSite(selected, 'x.com')).toEqual([]);
    expect(selected).toEqual(['x.com']);
  });
});

describe('addCustomSite', () => {
  it('normalizes the input, lists it as a chip and selects it', () => {
    const res = addCustomSite(PRESET_SITES, [], ' *.Example.com ');
    expect(res).toEqual({ domain: 'example.com', chips: [...PRESET_SITES, 'example.com'], selected: ['example.com'] });
  });

  it('selects an existing chip instead of listing it twice', () => {
    const res = addCustomSite(PRESET_SITES, [], 'https://www.x.com/home');
    expect(res?.chips).toEqual(PRESET_SITES);
    expect(res?.selected).toEqual(['x.com']);
  });

  it('keeps an already selected site selected once', () => {
    const res = addCustomSite(PRESET_SITES, ['x.com'], 'x.com');
    expect(res?.selected).toEqual(['x.com']);
  });

  it('returns null for input that is not a domain', () => {
    expect(addCustomSite(PRESET_SITES, [], 'not a domain')).toBeNull();
    expect(addCustomSite(PRESET_SITES, [], '')).toBeNull();
  });
});

describe('selectedOrigins', () => {
  it('lists the domain and subdomain pattern of every site, in one flat list', () => {
    expect(selectedOrigins(['x.com', 'youtube.com'])).toEqual([
      '*://x.com/*',
      '*://*.x.com/*',
      '*://youtube.com/*',
      '*://*.youtube.com/*',
    ]);
  });

  it('is empty for no site and drops duplicates', () => {
    expect(selectedOrigins([])).toEqual([]);
    expect(selectedOrigins(['x.com', 'x.com'])).toEqual(['*://x.com/*', '*://*.x.com/*']);
  });
});

describe('wildcardForm', () => {
  it('is the single wildcard notation', () => {
    expect(wildcardForm('instagram.com')).toBe('*.instagram.com');
  });
});

describe('previewFor', () => {
  it('is empty for blank input', () => {
    expect(previewFor('')).toEqual({ kind: 'empty' });
    expect(previewFor('   ')).toEqual({ kind: 'empty' });
  });

  it('names the recognized domain', () => {
    expect(previewFor('https://WWW.Example.com/a?b=1')).toEqual({ kind: 'ok', domain: 'example.com' });
  });

  it('is invalid for input that is not a site', () => {
    expect(previewFor('not a domain')).toEqual({ kind: 'invalid' });
    expect(previewFor('me@example.com')).toEqual({ kind: 'invalid' });
    expect(previewFor('printer.local')).toEqual({ kind: 'invalid' });
  });

  it('says so when the locked domain is wider than the address typed', () => {
    expect(previewFor('https://m.blog.naver.com/someone/123')).toEqual({
      kind: 'ok',
      domain: 'naver.com',
      typed: 'm.blog.naver.com',
    });
  });

  it('says nothing extra when only www was dropped', () => {
    expect(previewFor('www.instagram.com')).toEqual({ kind: 'ok', domain: 'instagram.com' });
    expect(previewFor('instagram.com')).toEqual({ kind: 'ok', domain: 'instagram.com' });
  });
});

describe('commitTypedSite', () => {
  it('has nothing to add for empty text', () => {
    expect(commitTypedSite(PRESET_SITES, [], '')).toEqual({ kind: 'none' });
    expect(commitTypedSite(PRESET_SITES, [], '   ')).toEqual({ kind: 'none' });
  });

  it('adds a typed site as a selected chip, like the Add button', () => {
    expect(commitTypedSite(PRESET_SITES, ['x.com'], 'youtube.com')).toEqual({
      kind: 'added',
      domain: 'youtube.com',
      chips: [...PRESET_SITES],
      selected: ['x.com', 'youtube.com'],
    });
    const res = commitTypedSite(PRESET_SITES, [], 'https://m.naver.com');
    expect(res).toMatchObject({ kind: 'added', domain: 'naver.com', selected: ['naver.com'] });
  });

  it('is invalid for typed text that is not a site', () => {
    expect(commitTypedSite(PRESET_SITES, ['x.com'], 'not a domain')).toEqual({ kind: 'invalid' });
  });
});

describe('nextLabelKey', () => {
  it('is Skip only while nothing is chosen and nothing is typed', () => {
    expect(nextLabelKey(0, '')).toBe('skipButton');
    expect(nextLabelKey(0, '  ')).toBe('skipButton');
    expect(nextLabelKey(0, 'youtube.com')).toBe('nextButton');
    expect(nextLabelKey(2, '')).toBe('nextButton');
  });
});

describe('doneTipKey', () => {
  it('claims locked sites only when a site was saved', () => {
    expect(doneTipKey(0)).toBe('onboardingDoneTipEmpty');
    expect(doneTipKey(1)).toBe('onboardingDoneTip');
  });
});

describe('doneTipText', () => {
  const tr = (key: string, subs?: string | string[]) => `${key}(${[subs ?? []].flat().join(',')})`;
  it('names the real Lock now shortcut, or says how to set one', () => {
    expect(doneTipText('onboardingDoneTip', 'Ctrl+Shift+K', tr)).toBe('onboardingDoneTip(Ctrl+Shift+K)');
    expect(doneTipText('onboardingDoneTip', undefined, tr)).toBe('onboardingDoneTipNoShortcut()');
    expect(doneTipText('onboardingDoneTipEmpty', 'Ctrl+Shift+K', tr)).toBe('onboardingDoneTipEmpty()');
  });
});

describe('limits links', () => {
  it('point at the English README limits section by default', () => {
    expect(LEARN_MORE_URL).toBe('https://github.com/xcryptp/for-my-privacy#what-it-protects-and-what-it-does-not');
    expect(limitsUrl('en-US')).toBe(LEARN_MORE_URL);
    expect(limitsUrl('fr')).toBe(LEARN_MORE_URL);
  });

  it('follow the UI language to the Korean and Japanese README, with their own anchors', () => {
    expect(limitsUrl('ko')).toBe(
      `https://github.com/xcryptp/for-my-privacy/blob/main/README.ko.md#${encodeURI('무엇을-막고-무엇은-막지-못하나')}`,
    );
    expect(limitsUrl('ja-JP')).toBe(
      `https://github.com/xcryptp/for-my-privacy/blob/main/README.ja.md#${encodeURI('何を守り何を守れないか')}`,
    );
  });

  it('read the language from the first part of the tag', () => {
    expect(readmeLang('ko-KR')).toBe('ko');
    expect(readmeLang('JA')).toBe('ja');
    expect(readmeLang('en_GB')).toBe('en');
    expect(readmeLang('')).toBe('en');
  });

  it('use anchors that match the README headings', () => {
    const readme = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    expect(readme('README.md')).toContain('## What it protects and what it does not');
    expect(readme('README.ko.md')).toContain('## 무엇을 막고 무엇은 막지 못하나');
    expect(readme('README.ja.md')).toContain('## 何を守り何を守れないか');
  });
});

describe('onboarding progress', () => {
  it('keeps steps 3 and 4 and never goes back before the password step', () => {
    expect(ONBOARDING_KEY).toBe('onboarding');
    expect(resumeStep(1)).toBe(3);
    expect(resumeStep(2)).toBe(3);
    expect(resumeStep(3)).toBe(3);
    expect(resumeStep(4)).toBe(4);
  });

  it('reads a stored record back, cleaning the site list', () => {
    expect(parseProgress({ step: 4, sites: ['X.com', 'x.com', 5, 'bad'] })).toEqual({ step: 4, sites: ['x.com'] });
    expect(parseProgress({ step: 3 })).toEqual({ step: 3, sites: [] });
  });

  it('treats anything else as no progress', () => {
    for (const bad of [undefined, null, 'x', 3, {}, { step: 1 }, { step: 5, sites: [] }, { step: '3' }]) {
      expect(parseProgress(bad)).toBeNull();
    }
  });
});
