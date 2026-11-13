// Pure helpers of the settings menu (no DOM, no browser API), so they can be unit tested.

export const SECTIONS = ['sites', 'autolock', 'security', 'about'] as const;

export type Section = (typeof SECTIONS)[number];

export const DEFAULT_SECTION: Section = 'sites';

/** The hash that opens a section. */
export function hashFor(section: Section): string {
  return `#${section}`;
}

/**
 * The section a location hash asks for. `#permission-lost` (the link of the worker's notice) opens
 * Sites, where the banner lives; an empty or unknown hash opens the default.
 */
export function sectionFromHash(hash: string): Section {
  const name = hash.replace(/^#/, '').toLowerCase();
  return (SECTIONS as readonly string[]).includes(name) ? (name as Section) : DEFAULT_SECTION;
}

/**
 * Which Remove button takes the focus after one was pressed: the one that moved into the removed
 * row's place, or the last one when the removed row was the last. Null when the list is empty (the
 * add field takes the focus then).
 */
export function focusAfterRemove(removedIndex: number, remaining: number): number | null {
  if (remaining <= 0) return null;
  return Math.min(Math.max(removedIndex, 0), remaining - 1);
}

/** True when the stored minutes differ from what was typed because the typed value was out of range. */
export function idleWasClamped(typed: number, stored: number): boolean {
  return Math.round(typed) !== stored;
}
