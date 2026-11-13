import { browser } from 'wxt/browser';

// Messages from the extension pages (lock page, options page, popup) to the service worker.
export type Request =
  | { type: 'getState' }
  | { type: 'setup'; password: string }
  // From the lock page: unlocks the sites (all of them, or only the lock page's own site when
  // the unlock scope is 'site'). `token` is the lock page's `#t=` token; the target is resolved
  // by the service worker from the token bound to the sending tab. `returnTo` is the old form
  // (a raw URL, http(s) only) kept until the lock page sends tokens.
  | { type: 'unlock'; password: string; token?: string; returnTo?: string }
  // From the options page: unlocks the settings only; the sites stay locked.
  | { type: 'unlockSettings'; password: string }
  | { type: 'lockNow' }
  | { type: 'changePassword'; current: string; next: string }
  // From a lock page opened by the redirect rule (`#u=<raw>`): binds the target to the sending
  // tab and returns a token, so the page can replace the URL in the address bar with `#t=<token>`.
  | { type: 'claimTarget'; raw: string }
  // From a lock page with `#t=<token>`: what to show for the target (only for the token's own tab).
  | { type: 'describeTarget'; token: string };

export interface State {
  hasPassword: boolean;
  /** Some locked site is reachable (the session unlock rule exists). */
  unlocked: boolean;
  /** The listed domains reachable right now (all of them after an 'all' unlock). */
  unlockedDomains: string[];
  /** The options page may show and change the settings. */
  settingsUnlocked: boolean;
  waitMs: number;
  /** Wrong answers left before the first wait (0 once waits have started). */
  triesLeft: number;
  settingsGuardAvailable: boolean;
}

export type ErrorCode =
  | 'wrong_password'
  | 'too_many_attempts'
  | 'too_short'
  | 'already_set'
  | 'not_set'
  /** claimTarget / describeTarget: no safe target for this tab (nothing to return to). */
  | 'invalid_target';

export type Response = { ok: true; state: State } | { ok: false; error: ErrorCode; state: State };

/**
 * Answer to claimTarget and describeTarget. `host` is what the page may show: the target's host
 * name, or `chrome://extensions` for the extensions page.
 */
export type TargetResponse =
  | { ok: true; state: State; token: string; host: string }
  | { ok: false; error: ErrorCode; state: State };

export type ResponseFor<R extends Request> = R extends { type: 'claimTarget' | 'describeTarget' }
  ? TargetResponse
  : Response;

// A raw `#u=` target longer than this is refused (URLs this long are not worth storing).
export const MAX_RAW_TARGET = 16_384;

/** Runtime shape check: the worker answers only well-formed requests. */
export function isRequest(value: unknown): value is Request {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const optionalString = (x: unknown) => x === undefined || typeof x === 'string';
  switch (v.type) {
    case 'getState':
    case 'lockNow':
      return true;
    case 'setup':
    case 'unlockSettings':
      return typeof v.password === 'string';
    case 'unlock':
      return typeof v.password === 'string' && optionalString(v.returnTo) && optionalString(v.token);
    case 'changePassword':
      return typeof v.current === 'string' && typeof v.next === 'string';
    case 'claimTarget':
      return typeof v.raw === 'string' && v.raw.length <= MAX_RAW_TARGET;
    case 'describeTarget':
      return typeof v.token === 'string';
    default:
      return false;
  }
}

export async function send<R extends Request>(req: R): Promise<ResponseFor<R>> {
  const res = (await browser.runtime.sendMessage(req)) as ResponseFor<R> | undefined;
  if (!res) throw new Error('No response from the service worker');
  return res;
}
