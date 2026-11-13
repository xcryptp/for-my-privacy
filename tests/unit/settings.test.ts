import { beforeEach, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DEFAULT_SETTINGS, getAuth, getSettings, saveAuth, saveSettings } from '../../src/lib/settings';

beforeEach(() => {
  fakeBrowser.reset();
});

describe('settings', () => {
  it('returns the defaults on empty storage', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('normalizes, dedupes and drops invalid domains', async () => {
    const saved = await saveSettings({ domains: ['WWW.Instagram.com', 'instagram.com', 'bad'] });
    expect(saved.domains).toEqual(['instagram.com']);
    expect((await getSettings()).domains).toEqual(['instagram.com']);
  });

  it('clamps and rounds idleMinutes to an integer from 1 to 60', async () => {
    expect((await saveSettings({ idleMinutes: 0 })).idleMinutes).toBe(1);
    expect((await saveSettings({ idleMinutes: 99 })).idleMinutes).toBe(60);
    expect((await saveSettings({ idleMinutes: 7.6 })).idleMinutes).toBe(8);
    expect((await getSettings()).idleMinutes).toBe(8);
  });

  it('keeps fields that are not in the patch', async () => {
    await saveSettings({ domains: ['example.com'], lockOnScreenLock: false });
    const saved = await saveSettings({ idleMinutes: 10 });
    expect(saved).toEqual({ domains: ['example.com'], idleMinutes: 10, lockOnScreenLock: false, settingsGuard: true });
  });

  it('falls back to defaults field by field for bad stored values', async () => {
    await browser.storage.local.set({
      settings: { domains: 'nope', idleMinutes: 'x', lockOnScreenLock: false, settingsGuard: 1 },
    });
    expect(await getSettings()).toEqual({ ...DEFAULT_SETTINGS, lockOnScreenLock: false });
  });

  it('cleans stored values that are the right type but out of range', async () => {
    await browser.storage.local.set({ settings: { domains: ['WWW.A.com', 5, 'a.com'], idleMinutes: 500 } });
    const s = await getSettings();
    expect(s.domains).toEqual(['a.com']);
    expect(s.idleMinutes).toBe(60);
  });

  it('keeps the stored value for an undefined or wrongly typed patch field', async () => {
    await saveSettings({ domains: ['a.com'], idleMinutes: 10, lockOnScreenLock: false });
    expect((await saveSettings({ domains: undefined })).domains).toEqual(['a.com']);
    expect((await saveSettings({ domains: 'x' as any })).domains).toEqual(['a.com']);
    expect((await saveSettings({ idleMinutes: Number.NaN })).idleMinutes).toBe(10);
    expect((await saveSettings({ idleMinutes: undefined })).idleMinutes).toBe(10);
    expect((await saveSettings({ lockOnScreenLock: 'no' as any })).lockOnScreenLock).toBe(false);
    expect(await getSettings()).toEqual({
      domains: ['a.com'],
      idleMinutes: 10,
      lockOnScreenLock: false,
      settingsGuard: true,
    });
  });

  it('still clears the list with an explicit empty array', async () => {
    await saveSettings({ domains: ['a.com'] });
    expect((await saveSettings({ domains: [] })).domains).toEqual([]);
  });

  it('does not mutate DEFAULT_SETTINGS', async () => {
    const s = await getSettings();
    s.domains.push('x.com');
    expect(DEFAULT_SETTINGS.domains).toEqual([]);
  });
});

describe('auth', () => {
  it('returns the defaults on empty storage', async () => {
    expect(await getAuth()).toEqual({ password: null, failures: 0, blockedUntil: 0 });
  });

  it('merges a patch and persists it', async () => {
    const password = { v: 1 as const, salt: 'c2FsdA==', iterations: 600000, hash: 'aGFzaA==' };
    const saved = await saveAuth({ password, failures: 2 });
    expect(saved).toEqual({ password, failures: 2, blockedUntil: 0 });
    expect(await getAuth()).toEqual(saved);
    expect(await saveAuth({ blockedUntil: 123 })).toEqual({ password, failures: 2, blockedUntil: 123 });
  });

  it('keeps the stored password and counters for undefined or invalid patch fields', async () => {
    const password = { v: 1 as const, salt: 'c2FsdA==', iterations: 600000, hash: 'aGFzaA==' };
    await saveAuth({ password, failures: 4, blockedUntil: 99 });
    expect((await saveAuth({ password: undefined })).password).toEqual(password);
    expect((await saveAuth({ password: { v: 1, salt: '', iterations: 1, hash: 'x' } })).password).toEqual(password);
    expect((await saveAuth({ failures: Number.NaN })).failures).toBe(4);
    expect((await saveAuth({ failures: -1 })).failures).toBe(4);
    expect((await saveAuth({ blockedUntil: 'x' as any })).blockedUntil).toBe(99);
    expect(await getAuth()).toEqual({ password, failures: 4, blockedUntil: 99 });
  });

  it('clears the password only with an explicit null', async () => {
    const password = { v: 1 as const, salt: 'c2FsdA==', iterations: 600000, hash: 'aGFzaA==' };
    await saveAuth({ password });
    expect((await saveAuth({ password: null })).password).toBeNull();
  });

  it('reads a record verifyPassword would reject as null', async () => {
    for (const bad of [
      { v: 1, salt: 'c2FsdA==', iterations: 0, hash: 'aGFzaA==' },
      { v: 1, salt: 'c2FsdA==', iterations: 1.5, hash: 'aGFzaA==' },
      { v: 1, salt: '', iterations: 1, hash: 'aGFzaA==' },
      { v: 1, salt: 'c2FsdA==', iterations: 1, hash: '' },
      { v: 2, salt: 'c2FsdA==', iterations: 1, hash: 'aGFzaA==' },
    ]) {
      await browser.storage.local.set({ auth: { password: bad, failures: 1, blockedUntil: 0 } });
      expect((await getAuth()).password).toBeNull();
    }
  });

  it('falls back to defaults for bad stored values', async () => {
    await browser.storage.local.set({ auth: { password: 'x', failures: -3, blockedUntil: 'y' } });
    expect(await getAuth()).toEqual({ password: null, failures: 0, blockedUntil: 0 });
  });
});
