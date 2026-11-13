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
