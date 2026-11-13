import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadFlag(): Promise<boolean> {
  vi.resetModules();
  const mod = await import('../../src/lib/flags');
  return mod.SETTINGS_GUARD_BUILD;
}

describe('SETTINGS_GUARD_BUILD', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is true with no env', async () => {
    vi.stubEnv('VITE_FMP_SETTINGS_GUARD', undefined);
    expect(await loadFlag()).toBe(true);
  });

  it('is false when VITE_FMP_SETTINGS_GUARD=off', async () => {
    vi.stubEnv('VITE_FMP_SETTINGS_GUARD', 'off');
    expect(await loadFlag()).toBe(false);
  });

  it('stays true for any other value', async () => {
    vi.stubEnv('VITE_FMP_SETTINGS_GUARD', 'on');
    expect(await loadFlag()).toBe(true);
  });
});
