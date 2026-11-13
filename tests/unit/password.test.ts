import { pbkdf2Sync } from 'node:crypto';
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

  it('measures the minimum on the NFC form', () => {
    const nfd = '한국어비밀번호'.normalize('NFD');
    expect(nfd.length).toBeGreaterThan(MIN_PASSWORD_LENGTH);
    expect(validatePassword(nfd)).toBe('too_short');
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

  it('treats NFC and NFD forms of the same password as equal', async () => {
    const nfc = '한국어비밀번호입니다';
    const nfd = nfc.normalize('NFD');
    expect(nfd).not.toBe(nfc);
    expect(await verifyPassword(nfc, await createRecord(nfd, 1000))).toBe(true);
    expect(await verifyPassword(nfd, await createRecord(nfc, 1000))).toBe(true);
  });

  it('backoffMs never returns NaN or a negative number', () => {
    expect(backoffMs(NaN)).toBe(900000);
    expect(backoffMs(Infinity)).toBe(900000);
    expect(backoffMs(-3)).toBe(0);
  });

  it('stores a 16-byte salt and a 32-byte hash', async () => {
    const r = await createRecord('correct horse', 1000);
    expect(Buffer.from(r.salt, 'base64')).toHaveLength(16);
    expect(Buffer.from(r.hash, 'base64')).toHaveLength(32);
  });

  it('matches a PBKDF2-SHA256 known answer from node:crypto', async () => {
    const r = await createRecord('correct horse', 1000);
    const expected = pbkdf2Sync('correct horse', Buffer.from(r.salt, 'base64'), 1000, 32, 'sha256');
    expect(r.hash).toBe(expected.toString('base64'));
  });
});
