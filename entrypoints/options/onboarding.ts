import { normalizeDomain } from '../../src/lib/domain';
import { originPatterns } from '../../src/lib/origins';

// Pure helpers of the first-run onboarding (no DOM, no browser API), so they can be unit tested.

export const ONBOARDING_STEPS = 4;

export type Step = 1 | 2 | 3 | 4;

export const REPO_URL = 'https://github.com/xcryptp/for-my-privacy';

export const PRIVACY_URL = `${REPO_URL}/blob/main/PRIVACY.md`;

/** The README section that lists what the extension cannot stop (anchor of the English heading). */
export const LEARN_MORE_URL = `${REPO_URL}#what-it-protects-and-what-it-does-not`;

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

/** The line shown under a listed site: it makes visible that subdomains of every depth are locked too. */
export function wildcardForms(domain: string): string {
  return `*.${domain} · *.*.${domain}`;
}

export type Preview = { kind: 'empty' } | { kind: 'ok'; domain: string } | { kind: 'invalid' };

/** What a site field's current text will lock, for the live "Will lock" line while typing. */
export function previewFor(raw: string): Preview {
  if (raw.trim() === '') return { kind: 'empty' };
  const domain = normalizeDomain(raw);
  return domain ? { kind: 'ok', domain } : { kind: 'invalid' };
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
