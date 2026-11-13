import { describe, expect, it } from 'vitest';
import { DEFAULT_SECTION, SECTIONS, hashFor, sectionFromHash } from '../../entrypoints/options/sections';

describe('sectionFromHash', () => {
  it('maps each menu hash to its section', () => {
    for (const section of SECTIONS) expect(sectionFromHash(`#${section}`)).toBe(section);
  });

  it('opens Sites for #permission-lost, an empty hash and anything unknown', () => {
    expect(DEFAULT_SECTION).toBe('sites');
    expect(sectionFromHash('#permission-lost')).toBe('sites');
    expect(sectionFromHash('')).toBe('sites');
    expect(sectionFromHash('#')).toBe('sites');
    expect(sectionFromHash('#nope')).toBe('sites');
  });

  it('ignores case', () => {
    expect(sectionFromHash('#About')).toBe('about');
  });
});

describe('hashFor', () => {
  it('round-trips with sectionFromHash', () => {
    for (const section of SECTIONS) expect(sectionFromHash(hashFor(section))).toBe(section);
    expect(hashFor('autolock')).toBe('#autolock');
  });
});
