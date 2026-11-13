import { normalizeDomain, typedHost } from '../../src/lib/registrable-domain';
import { originPatterns } from '../../src/lib/origins';

// Pure helpers of the first-run onboarding (no DOM, no browser API), so they can be unit tested.

export const ONBOARDING_STEPS = 4;

export type Step = 1 | 2 | 3 | 4;

export const REPO_URL = 'https://github.com/xcryptp/for-my-privacy';

export const PRIVACY_URL = `${REPO_URL}/blob/main/PRIVACY.md`;

export type ReadmeLang = 'en' | 'ko' | 'ja';

/** The README language for a browser UI language such as `ko`, `ko-KR` or `ja`; anything else is English. */
export function readmeLang(uiLanguage: string): ReadmeLang {
  const base = uiLanguage.toLowerCase().split(/[-_]/)[0];
  return base === 'ko' || base === 'ja' ? base : 'en';
}

// The README file of each language and the anchor of its "what it protects and what it does not" heading.
const LIMITS_SECTION: Record<ReadmeLang, { file: string; anchor: string }> = {
  en: { file: 'README.md', anchor: 'what-it-protects-and-what-it-does-not' },
  ko: { file: 'README.ko.md', anchor: '무엇을-막고-무엇은-막지-못하나' },
  ja: { file: 'README.ja.md', anchor: '何を守り何を守れないか' },
};

/** The README section that lists what the extension cannot stop, in the language of the page. */
export function limitsUrl(uiLanguage: string): string {
  const { file, anchor } = LIMITS_SECTION[readmeLang(uiLanguage)];
  const base = file === 'README.md' ? REPO_URL : `${REPO_URL}/blob/main/${file}`;
  return `${base}#${encodeURI(anchor)}`;
}

/** The English section, for places that do not know the language. */
export const LEARN_MORE_URL = limitsUrl('en');

/** Sites offered as one-tap choices on the "Choose sites" step, in stored form. */
export const PRESET_SITES: readonly string[] = ['instagram.com', 'facebook.com', 'x.com', 'tiktok.com', 'youtube.com'];

export function nextStep(step: Step): Step {
  return Math.min(ONBOARDING_STEPS, step + 1) as Step;
}

export function prevStep(step: Step): Step {
  return Math.max(1, step - 1) as Step;
}

/** The selection with `domain` flipped; the input is not changed. */
export function toggleSite(selected: readonly string[], domain: string): string[] {
  return selected.includes(domain) ? selected.filter((d) => d !== domain) : [...selected, domain];
}

/**
 * Handles the custom site field: the normalized domain joins the chips (once) and is selected.
 * Returns null when the input is not a domain.
 */
export function addCustomSite(
  chips: readonly string[],
  selected: readonly string[],
  raw: string,
): { domain: string; chips: string[]; selected: string[] } | null {
  const domain = normalizeDomain(raw);
  if (!domain) return null;
  return {
    domain,
    chips: chips.includes(domain) ? [...chips] : [...chips, domain],
    selected: selected.includes(domain) ? [...selected] : [...selected, domain],
  };
}

/** Every host permission pattern for the chosen sites, for one `permissions.request` call. */
export function selectedOrigins(domains: readonly string[]): string[] {
  return [...new Set(domains.flatMap(originPatterns))];
}

/** The notation under a listed site, for people who know it: the site and everything under it. */
export function wildcardForm(domain: string): string {
  return `*.${domain}`;
}

export type Preview =
  | { kind: 'empty' }
  /** `typed` is set when the address typed was deeper than the domain that gets locked (m.blog.naver.com → naver.com). */
  | { kind: 'ok'; domain: string; typed?: string }
  | { kind: 'invalid' };

/** What a site field's current text will lock, for the live "Will lock" line while typing. */
export function previewFor(raw: string): Preview {
  if (raw.trim() === '') return { kind: 'empty' };
  const domain = normalizeDomain(raw);
  if (!domain) return { kind: 'invalid' };
  const typed = typedHost(raw);
  return typed && typed !== domain ? { kind: 'ok', domain, typed } : { kind: 'ok', domain };
}

export type TypedSite =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'added'; domain: string; chips: string[]; selected: string[] };

/**
 * A site typed in the custom field but not yet added is added when the person moves on: the same
 * rule as the Add button. Empty text is nothing to add; text that is not a site stays put with an error.
 */
export function commitTypedSite(chips: readonly string[], selected: readonly string[], typed: string): TypedSite {
  if (typed.trim() === '') return { kind: 'none' };
  const added = addCustomSite(chips, selected, typed);
  return added ? { kind: 'added', ...added } : { kind: 'invalid' };
}

/** "Skip" while nothing is chosen and nothing is typed, "Next" otherwise. */
export function nextLabelKey(chosenCount: number, typed: string): 'skipButton' | 'nextButton' {
  return chosenCount === 0 && typed.trim() === '' ? 'skipButton' : 'nextButton';
}

/** Which tip the settings show after the first run: only a saved site makes "your sites are locked" true. */
export function doneTipKey(savedSites: number): 'onboardingDoneTip' | 'onboardingDoneTipEmpty' {
  return savedSites > 0 ? 'onboardingDoneTip' : 'onboardingDoneTipEmpty';
}

/**
 * The Finish tip: with sites saved it names the Lock now shortcut Chrome really has (the person
 * may have changed or cleared it), or says how to set one.
 */
export function doneTipText(
  key: ReturnType<typeof doneTipKey>,
  shortcut: string | undefined,
  tr: (key: string, subs?: string | string[]) => string,
): string {
  if (key !== 'onboardingDoneTip') return tr(key);
  return shortcut ? tr('onboardingDoneTip', shortcut) : tr('onboardingDoneTipNoShortcut');
}

/** Storage key of the onboarding progress; removed on Finish. */
export const ONBOARDING_KEY = 'onboarding';

/** What is kept so that a reload after the password step resumes where it was. */
export interface OnboardingProgress {
  /** Never below 3: the password exists by then, so steps 1 and 2 are not repeated. */
  step: 3 | 4;
  /** Sites saved to the list by the onboarding so far. */
  sites: string[];
}

/** The step to keep for a step the user is on once the password exists. */
export function resumeStep(step: Step): 3 | 4 {
  return step >= 4 ? 4 : 3;
}

/** Reads a stored value back; anything that is not a well-formed progress record is null. */
export function parseProgress(raw: unknown): OnboardingProgress | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.step !== 3 && r.step !== 4) return null;
  const sites = Array.isArray(r.sites)
    ? r.sites.flatMap((item) => (typeof item === 'string' ? (normalizeDomain(item) ?? []) : []))
    : [];
  return { step: r.step, sites: [...new Set(sites)] };
}
