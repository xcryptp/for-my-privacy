import { browser } from 'wxt/browser';

// Messages from the extension pages (lock page, options page) to the service worker.
export type Request =
  | { type: 'getState' }
  | { type: 'setup'; password: string }
  // From the lock page: unlocks the sites and the settings.
  | { type: 'unlock'; password: string; returnTo?: string }
  // From the options page: unlocks the settings only; the sites stay locked.
  | { type: 'unlockSettings'; password: string }
  | { type: 'lockNow' }
  | { type: 'changePassword'; current: string; next: string };

export interface State {
  hasPassword: boolean;
  /** The locked sites are reachable (the session unlock rule exists). */
  unlocked: boolean;
  /** The options page may show and change the settings. */
  settingsUnlocked: boolean;
  waitMs: number;
  settingsGuardAvailable: boolean;
}

export type ErrorCode = 'wrong_password' | 'too_many_attempts' | 'too_short' | 'already_set' | 'not_set';

export type Response = { ok: true; state: State } | { ok: false; error: ErrorCode; state: State };

/** Runtime shape check: the worker answers only well-formed requests. */
export function isRequest(value: unknown): value is Request {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case 'getState':
    case 'lockNow':
      return true;
    case 'setup':
    case 'unlockSettings':
      return typeof v.password === 'string';
    case 'unlock':
      return typeof v.password === 'string' && (v.returnTo === undefined || typeof v.returnTo === 'string');
    case 'changePassword':
      return typeof v.current === 'string' && typeof v.next === 'string';
    default:
      return false;
  }
}

export async function send(req: Request): Promise<Response> {
  const res = (await browser.runtime.sendMessage(req)) as Response | undefined;
  if (!res) throw new Error('No response from the service worker');
  return res;
}
