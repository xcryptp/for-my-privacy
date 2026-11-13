import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SECTION,
  SECTIONS,
  focusAfterRemove,
  hashFor,
  idleWasClamped,
  sectionFromHash,
} from '../../entrypoints/options/sections';

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

describe('focusAfterRemove', () => {
  it('moves to the button that took the removed row place', () => {
    expect(focusAfterRemove(0, 3)).toBe(0);
    expect(focusAfterRemove(1, 3)).toBe(1);
  });

  it('moves to the last button when the last row was removed', () => {
    expect(focusAfterRemove(2, 2)).toBe(1);
    expect(focusAfterRemove(5, 1)).toBe(0);
  });

  it('has no button for an empty list (the add field takes the focus)', () => {
    expect(focusAfterRemove(0, 0)).toBeNull();
  });

  it('treats an unknown index as the first row', () => {
    expect(focusAfterRemove(-1, 2)).toBe(0);
  });
});

describe('idleWasClamped', () => {
  it('is true only when the stored minutes differ from what was typed', () => {
    expect(idleWasClamped(0, 1)).toBe(true);
    expect(idleWasClamped(90, 60)).toBe(true);
    expect(idleWasClamped(-3, 1)).toBe(true);
    expect(idleWasClamped(7, 7)).toBe(false);
    expect(idleWasClamped(7.6, 8)).toBe(false);
  });
});
