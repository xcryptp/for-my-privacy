import { describe, expect, it } from 'vitest';
import { viewFor } from '../../entrypoints/options/main';

const state = (patch: Partial<Parameters<typeof viewFor>[0]>) => ({
  hasPassword: true,
  unlocked: false,
  waitMs: 0,
  settingsGuardAvailable: true,
  ...patch,
});

describe('viewFor', () => {
  it('asks for a password first, whatever the unlock flag says', () => {
    expect(viewFor(state({ hasPassword: false }))).toBe('setup');
    expect(viewFor(state({ hasPassword: false, unlocked: true }))).toBe('setup');
  });

  it('shows only the unlock form while locked, the settings once unlocked', () => {
    expect(viewFor(state({}))).toBe('locked');
    expect(viewFor(state({ unlocked: true }))).toBe('settings');
  });
});
