import { describe, expect, it } from 'vitest';
import { viewFor } from '../../entrypoints/options/main';

const state = (patch: Partial<Parameters<typeof viewFor>[0]>): Parameters<typeof viewFor>[0] => ({
  hasPassword: true,
  unlocked: false,
  unlockedDomains: [],
  settingsUnlocked: false,
  waitMs: 0,
  triesLeft: 5,
  settingsGuardAvailable: true,
  ...patch,
});

describe('viewFor', () => {
  it('asks for a password first, whatever the unlock flags say', () => {
    expect(viewFor(state({ hasPassword: false }))).toBe('setup');
    expect(viewFor(state({ hasPassword: false, unlocked: true }))).toBe('setup');
    expect(viewFor(state({ hasPassword: false, settingsUnlocked: true }))).toBe('setup');
  });

  it('shows only the unlock form while locked', () => {
    expect(viewFor(state({}))).toBe('locked');
  });

  it('shows the settings only once the settings themselves are unlocked', () => {
    expect(viewFor(state({ settingsUnlocked: true }))).toBe('settings');
    expect(viewFor(state({ unlocked: true, settingsUnlocked: true }))).toBe('settings');
  });

  it('keeps asking for the password when only the sites are unlocked', () => {
    expect(viewFor(state({ unlocked: true }))).toBe('locked');
  });
});
