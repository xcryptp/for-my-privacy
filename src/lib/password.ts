// Password hashing with WebCrypto only (service worker, extension pages and Node).
// Only a PBKDF2 hash record is ever stored; the password itself never is.

export interface PasswordRecord {
  v: 1;
  salt: string; // base64, 16 random bytes
  iterations: number;
  hash: string; // base64, 32 bytes (PBKDF2-SHA256)
}

export const PBKDF2_ITERATIONS = 600000;
export const MIN_PASSWORD_LENGTH = 8;

const SALT_BYTES = 16;
const HASH_BITS = 256;
const BACKOFF_FREE_FAILURES = 5;
const BACKOFF_BASE_MS = 30000;
const BACKOFF_MAX_MS = 900000;

// NFC so the same text typed or pasted as NFD (common for ko/ja on macOS) hashes identically.
function normalizePassword(pw: string): string {
  return pw.normalize('NFC');
}

export function validatePassword(pw: string): 'ok' | 'too_short' {
  return normalizePassword(pw).length >= MIN_PASSWORD_LENGTH ? 'ok' : 'too_short';
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function derive(pw: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, HASH_BITS);
  return new Uint8Array(bits);
}

export async function createRecord(pw: string, iterations: number = PBKDF2_ITERATIONS): Promise<PasswordRecord> {
  if (validatePassword(pw) !== 'ok') throw new Error('too_short');
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(normalizePassword(pw), salt, iterations);
  return { v: 1, salt: toBase64(salt), iterations, hash: toBase64(hash) };
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function verifyPassword(pw: string, record: PasswordRecord): Promise<boolean> {
  try {
    if (!record || record.v !== 1) return false;
    if (!Number.isInteger(record.iterations) || record.iterations < 1) return false;
    const salt = fromBase64(record.salt);
    const expected = fromBase64(record.hash);
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = await derive(normalizePassword(pw), salt, record.iterations);
    return constantTimeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Wait after a wrong password: 0 below 5 failures, then 30 s doubling up to 15 min. */
export function backoffMs(failures: number): number {
  if (!Number.isFinite(failures)) return BACKOFF_MAX_MS;
  if (failures < BACKOFF_FREE_FAILURES) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** (failures - BACKOFF_FREE_FAILURES), BACKOFF_MAX_MS);
}
