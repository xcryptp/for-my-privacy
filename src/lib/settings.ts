import { browser } from 'wxt/browser';
import { normalizeDomain } from './domain';
import type { PasswordRecord } from './password';

export interface Settings {
  domains: string[];
  idleMinutes: number;
  lockOnScreenLock: boolean;
  settingsGuard: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  domains: [],
  idleMinutes: 5,
  lockOnScreenLock: true,
  settingsGuard: true,
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

function cleanDomains(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const domain = normalizeDomain(item);
    if (domain) out.add(domain);
  }
  return [...out];
}

function cleanIdleMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SETTINGS.idleMinutes;
  return Math.min(MAX_IDLE_MINUTES, Math.max(MIN_IDLE_MINUTES, Math.round(value)));
}

function cleanSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    domains: Array.isArray(r.domains) ? cleanDomains(r.domains) : [...DEFAULT_SETTINGS.domains],
    idleMinutes: cleanIdleMinutes(r.idleMinutes),
    lockOnScreenLock:
      typeof r.lockOnScreenLock === 'boolean' ? r.lockOnScreenLock : DEFAULT_SETTINGS.lockOnScreenLock,
    settingsGuard: typeof r.settingsGuard === 'boolean' ? r.settingsGuard : DEFAULT_SETTINGS.settingsGuard,
  };
}

function isPasswordRecord(value: unknown): value is PasswordRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    r.v === 1 &&
    typeof r.salt === 'string' &&
    typeof r.hash === 'string' &&
    typeof r.iterations === 'number' &&
    Number.isFinite(r.iterations)
  );
}

function cleanCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function cleanAuth(raw: unknown): Auth {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    password: isPasswordRecord(r.password) ? r.password : DEFAULT_AUTH.password,
    failures: cleanCount(r.failures),
    blockedUntil: cleanCount(r.blockedUntil),
  };
}

export async function getSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  return cleanSettings(stored[SETTINGS_KEY]);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = cleanSettings({ ...(await getSettings()), ...patch });
  await browser.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function getAuth(): Promise<Auth> {
  const stored = await browser.storage.local.get(AUTH_KEY);
  return cleanAuth(stored[AUTH_KEY]);
}

export async function saveAuth(patch: Partial<Auth>): Promise<Auth> {
  const next = cleanAuth({ ...(await getAuth()), ...patch });
  await browser.storage.local.set({ [AUTH_KEY]: next });
  return next;
}
