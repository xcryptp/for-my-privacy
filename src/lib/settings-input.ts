import { normalizeDomains } from './registrable-domain';
import { saveSettings, type Settings } from './settings';

/**
 * Saves settings that came from user input: `domains` are first reduced to their registrable domain
 * (and deduplicated, invalid ones dropped), then stored by `saveSettings`. Only the options page uses
 * this, so the Public Suffix List stays out of the service worker and the lock page.
 */
export function saveSettingsFromInput(patch: Partial<Settings>): Promise<Settings> {
  const domains = Array.isArray(patch.domains) ? normalizeDomains(patch.domains) : patch.domains;
  return saveSettings({ ...patch, domains });
}
