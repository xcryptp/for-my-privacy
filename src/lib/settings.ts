import { browser } from 'wxt/browser';
import { cleanStoredDomain } from './domain';
import type { PasswordRecord } from './password';

export interface Settings {
  domains: string[];
  idleMinutes: number;
  lockOnScreenLock: boolean;
  settingsGuard: boolean;
  /** Which sites a site unlock opens: every locked site together, or only the site that asked. */
  unlockScope: UnlockScope;
}

export type UnlockScope = 'all' | 'site';

export const DEFAULT_SETTINGS: Settings = {
  domains: [],
  idleMinutes: 5,
  lockOnScreenLock: true,
  settingsGuard: true,
  unlockScope: 'all',
};

export interface Auth {
  password: PasswordRecord | null;
  failures: number;
  blockedUntil: number;
}

const DEFAULT_AUTH: Auth = { password: null, failures: 0, blockedUntil: 0 };

const SETTINGS_KEY = 'settings';
const AUTH_KEY = 'auth';
const MIN_IDLE_MINUTES = 1;
const MAX_IDLE_MINUTES = 60;

/**
 * A cheap check on read and write: lower-case valid host names, no more. Reducing user input to its
 * registrable domain needs the Public Suffix List and lives in `settings-input.ts`, which only the
 * options page uses; the service worker and the lock page never load that list.
 */
function cleanStoredDomains(value: unknown[]): string[] {
  const out = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const domain = cleanStoredDomain(item);
    if (domain) out.add(domain);
  }
  return [...out];
}

// Each field validator returns the cleaned value, or undefined when the value is not
// usable. On write an unusable patch value keeps the stored value (never the default),
// so a bad call cannot unlock sites or reset the wrong-password wait.
const SETTINGS_FIELDS: { [K in keyof Settings]: (value: unknown) => Settings[K] | undefined } = {
  domains: (v) => (Array.isArray(v) ? cleanStoredDomains(v) : undefined),
  idleMinutes: (v) =>
    typeof v === 'number' && Number.isFinite(v)
      ? Math.min(MAX_IDLE_MINUTES, Math.max(MIN_IDLE_MINUTES, Math.round(v)))
      : undefined,
  lockOnScreenLock: (v) => (typeof v === 'boolean' ? v : undefined),
  settingsGuard: (v) => (typeof v === 'boolean' ? v : undefined),
  unlockScope: (v) => (v === 'all' || v === 'site' ? v : undefined),
};

function isPasswordRecord(value: unknown): value is PasswordRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  // Same acceptance rule as verifyPassword, so a corrupted record reads as null.
  return (
    r.v === 1 &&
    typeof r.salt === 'string' &&
    r.salt.length > 0 &&
    typeof r.hash === 'string' &&
    r.hash.length > 0 &&
    typeof r.iterations === 'number' &&
    Number.isInteger(r.iterations) &&
    r.iterations >= 1
  );
}

const AUTH_FIELDS: { [K in keyof Auth]: (value: unknown) => Auth[K] | undefined } = {
  password: (v) => (v === null ? null : isPasswordRecord(v) ? v : undefined),
  failures: (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined),
  blockedUntil: (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined),
};

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

/** Per field: the cleaned value when usable, otherwise the fallback's value. */
function cleanFields<T extends object>(
  raw: unknown,
  validators: { [K in keyof T]: (value: unknown) => T[K] | undefined },
  fallback: (key: keyof T) => T[keyof T],
): T {
  const r = asRecord(raw);
  const out = {} as T;
  for (const key of Object.keys(validators) as (keyof T)[]) {
    const cleaned = validators[key](r[key as string]);
    out[key] = (cleaned === undefined ? fallback(key) : cleaned) as T[keyof T];
  }
  return out;
}

function cleanSettings(raw: unknown): Settings {
  return cleanFields<Settings>(raw, SETTINGS_FIELDS, (key) =>
    key === 'domains' ? [] : DEFAULT_SETTINGS[key],
  );
}

function cleanAuth(raw: unknown): Auth {
  return cleanFields<Auth>(raw, AUTH_FIELDS, (key) => DEFAULT_AUTH[key]);
}

/** Overlay the usable fields of a patch on the current value; skip undefined and invalid ones. */
function applyPatch<T extends object>(
  current: T,
  patch: Partial<T>,
  validators: { [K in keyof T]: (value: unknown) => T[K] | undefined },
): T {
  const next = { ...current };
  for (const key of Object.keys(validators) as (keyof T)[]) {
    const cleaned = validators[key](asRecord(patch)[key as string]);
    if (cleaned !== undefined) next[key] = cleaned;
  }
  return next;
}

export async function getSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  return cleanSettings(stored[SETTINGS_KEY]);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = applyPatch(await getSettings(), patch, SETTINGS_FIELDS);
  await browser.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function getAuth(): Promise<Auth> {
  const stored = await browser.storage.local.get(AUTH_KEY);
  return cleanAuth(stored[AUTH_KEY]);
}

export async function saveAuth(patch: Partial<Auth>): Promise<Auth> {
  const next = applyPatch(await getAuth(), patch, AUTH_FIELDS);
  await browser.storage.local.set({ [AUTH_KEY]: next });
  return next;
}
