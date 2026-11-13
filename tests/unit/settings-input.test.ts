import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { getSettings, saveSettings } from '../../src/lib/settings';
import { saveSettingsFromInput } from '../../src/lib/settings-input';

beforeEach(() => {
  fakeBrowser.reset();
});

describe('saveSettingsFromInput', () => {
  it('normalizes, dedupes and drops invalid domains', async () => {
    const saved = await saveSettingsFromInput({ domains: ['WWW.Instagram.com', 'instagram.com', 'bad', 'me@x.com'] });
    expect(saved.domains).toEqual(['instagram.com']);
    expect((await getSettings()).domains).toEqual(['instagram.com']);
  });

  it('collapses subdomain entries into their registrable domain', async () => {
    const saved = await saveSettingsFromInput({ domains: ['m.instagram.com', 'instagram.com', 'a.b.example.test'] });
    expect(saved.domains).toEqual(['instagram.com', 'example.test']);
  });

  it('passes the other fields through and keeps the stored list for a patch without domains', async () => {
    await saveSettings({ domains: ['a.com'] });
    const saved = await saveSettingsFromInput({ idleMinutes: 9, unlockScope: 'site' });
    expect(saved).toMatchObject({ domains: ['a.com'], idleMinutes: 9, unlockScope: 'site' });
  });

  it('still clears the list with an explicit empty array', async () => {
    await saveSettings({ domains: ['a.com'] });
    expect((await saveSettingsFromInput({ domains: [] })).domains).toEqual([]);
  });
});
