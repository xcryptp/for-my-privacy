import { describe, expect, it } from 'vitest';
import {
  MIN_PASSWORD_LENGTH,
  PBKDF2_ITERATIONS,
  backoffMs,
  createRecord,
  validatePassword,
  verifyPassword,
  type PasswordRecord,
} from '../../src/lib/password';

describe('password', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const r = await createRecord('correct horse', 1000);
    expect(await verifyPassword('correct horse', r)).toBe(true);
    expect(await verifyPassword('correct horsf', r)).toBe(false);
  });

  it('uses a random salt and never stores the password', async () => {
    const r = await createRecord('correct horse', 1000);
    expect(r.salt).not.toBe((await createRecord('correct horse', 1000)).salt);
    expect(JSON.stringify(r)).not.toContain('correct horse');
  });

  it('validates the minimum length', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
    expect(validatePassword('1234567')).toBe('too_short');
    expect(validatePassword('12345678')).toBe('ok');
  });

  it('createRecord rejects a too-short password', async () => {
    await expect(createRecord('1234567', 1000)).rejects.toThrow('too_short');
  });

  it('computes the wrong-password wait', () => {
    expect([4, 5, 6, 10, 30].map(backoffMs)).toEqual([0, 30000, 60000, 900000, 900000]);
  });

  it('defaults to 600000 iterations', async () => {
    expect(PBKDF2_ITERATIONS).toBe(600000);
    const r = await createRecord('correct horse');
    expect(r.v).toBe(1);
    expect(r.iterations).toBe(600000);
  });

  it('returns false for a malformed record instead of throwing', async () => {
    const bad = [
      { v: 1, salt: '!!!', iterations: 1000, hash: '!!!' },
      { v: 1, salt: '', iterations: 0, hash: '' },
      { v: 2, salt: 'AAAA', iterations: 1000, hash: 'AAAA' },
      null,
      {},
    ] as unknown as PasswordRecord[];
    for (const rec of bad) expect(await verifyPassword('correct horse', rec)).toBe(false);
  });
});
