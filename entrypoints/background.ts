import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import {
  applySettings,
  handleMessage,
  onIdleStateChanged,
  onInstalled,
  onPermissionsRemoved,
  onTabUpdated,
  onWindowRemoved,
  relock,
  resync,
} from '../src/background/engine';
import { isRequest } from '../src/lib/messages';
import { clearUnlocked, isUnlocked, setUnlocked, syncBlockRules } from '../src/lib/rules';
import { getSettings, saveSettings } from '../src/lib/settings';

function logErrors(label: string) {
  return (err: unknown) => console.error(`for-my-privacy: ${label} failed`, err);
}

export default defineBackground(() => {
  // Listeners are registered synchronously at the top level so Chrome can wake the worker for them.
  browser.runtime.onInstalled.addListener((details) => {
    onInstalled(details).catch(logErrors('onInstalled'));
  });
  browser.runtime.onStartup.addListener(() => {
    resync().catch(logErrors('onStartup'));
  });
  browser.idle.onStateChanged.addListener((state) => {
    onIdleStateChanged(state).catch(logErrors('idle'));
  });
  browser.windows.onRemoved.addListener(() => {
    onWindowRemoved().catch(logErrors('windows.onRemoved'));
  });
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    onTabUpdated(tabId, changeInfo).catch(logErrors('tabs.onUpdated'));
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'settings' in changes) resync().catch(logErrors('storage.onChanged'));
  });
  browser.permissions.onAdded.addListener(() => {
    resync().catch(logErrors('permissions.onAdded'));
  });
  browser.permissions.onRemoved.addListener(() => {
    onPermissionsRemoved().catch(logErrors('permissions.onRemoved'));
  });
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isRequest(message)) return false;
    handleMessage(message, sender).then(sendResponse, (err) => {
      logErrors('message')(err);
      sendResponse(undefined);
    });
    return true; // keep the channel open for the async answer (Chrome 120 has no promise return)
  });

  // Every worker start re-applies the rules and the idle interval (both can drift, e.g. after a
  // permission change while the worker slept). An existing unlock is kept, not relocked.
  resync().catch(logErrors('start'));

  // Test-only hook for the e2e build; Vite drops this branch from normal builds.
  if (import.meta.env.MODE === 'e2e') {
    (globalThis as Record<string, unknown>).__fmp = {
      syncBlockRules,
      setUnlocked,
      clearUnlocked,
      isUnlocked,
      handleMessage,
      relock,
      applySettings,
      getSettings,
      saveSettings,
    };
  }
});
