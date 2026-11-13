import { describe, expect, it } from 'vitest';
import {
  LEARN_MORE_URL,
  ONBOARDING_STEPS,
  PRESET_SITES,
  addCustomSite,
  nextStep,
  prevStep,
  selectedOrigins,
  toggleSite,
  ONBOARDING_KEY,
  parseProgress,
  previewFor,
  resumeStep,
  wildcardForms,
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

describe('wildcardForms', () => {
  it('shows that subdomains of every depth are included', () => {
    expect(wildcardForms('instagram.com')).toBe('*.instagram.com · *.*.instagram.com');
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
  });
});

describe('LEARN_MORE_URL', () => {
  it('points at the English README limits section', () => {
    expect(LEARN_MORE_URL).toBe('https://github.com/xcryptp/for-my-privacy#what-it-protects-and-what-it-does-not');
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
