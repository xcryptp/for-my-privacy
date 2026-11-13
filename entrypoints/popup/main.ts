import { browser } from 'wxt/browser';
import { applyI18n, t } from '../../src/lib/i18n';
import { send } from '../../src/lib/messages';
import { LOCK_COMMAND, lockShortcut, shortcutOf } from '../../src/ui/shortcut';

export { LOCK_COMMAND, shortcutOf };


/** How long "Locked" stays on screen, readable, before the popup closes. */
const CLOSE_MS = 2000;


/** The line under the title: whether every site is locked now (nothing before the first run). */
export function stateLineKey(state: { hasPassword: boolean; unlocked: boolean }): 'popupAllLocked' | 'popupSomeUnlocked' | undefined {
  if (!state.hasPassword) return undefined;
  return state.unlocked ? 'popupSomeUnlocked' : 'popupAllLocked';
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

function init(): void {
  const lock = byId<HTMLButtonElement>('lock');
  const settings = byId<HTMLButtonElement>('settings');
  const status = byId('status');
  const shortcut = byId('shortcut');
  const stateLine = byId('state');

  applyI18n();
  document.documentElement.lang = browser.i18n.getUILanguage();
  document.title = t('extShortName');
  lock.focus();

  settings.addEventListener('click', () => {
    browser.runtime
      .openOptionsPage()
      .then(() => window.close())
      .catch((err) => console.warn('open settings failed', err));
  });

  let busy = false;
  lock.addEventListener('click', () => {
    void (async () => {
      if (busy) return;
      busy = true;
      lock.disabled = true;
      try {
        const res = await send({ type: 'lockNow' });
        if (res.ok) {
          status.classList.remove('note');
          status.textContent = t('popupLocked');
          stateLine.textContent = t('popupAllLocked');
          setTimeout(() => window.close(), CLOSE_MS);
          return;
        }
        // Not rejected for any reason of the person's: keep the button usable.
        lock.disabled = false;
      } catch (err) {
        console.warn('lock now failed', err);
        lock.disabled = false;
      } finally {
        busy = false;
      }
    })();
  });

  // Before the first run is finished there is nothing to lock: point at the settings instead.
  send({ type: 'getState' })
    .then((res) => {
      const line = stateLineKey(res.state);
      if (line) {
        stateLine.textContent = t(line);
        stateLine.hidden = false;
      }
      if (res.state.hasPassword) return;
      lock.disabled = true;
      status.classList.add('note');
      status.textContent = t('popupNotSet');
      settings.classList.remove('secondary');
      settings.focus();
    })
    .catch((err) => console.warn('getState failed', err));

  void lockShortcut().then((keys) => {
    if (!keys) return;
    shortcut.textContent = t('popupShortcut', keys);
    shortcut.hidden = false;
  });
}

if (typeof document !== 'undefined') init();
