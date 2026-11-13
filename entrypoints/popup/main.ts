import { browser } from 'wxt/browser';
import { applyI18n, t } from '../../src/lib/i18n';
import { send } from '../../src/lib/messages';

/** The command the worker listens for (`commands` in the manifest); its shortcut is shown when one is set. */
export const LOCK_COMMAND = 'lock-now';

/** How long "Locked" stays on screen, readable, before the popup closes. */
const CLOSE_MS = 2000;

/** The shortcut text of a command list: the one set for Lock now, or undefined when none is set. */
export function shortcutOf(commands: readonly { name?: string; shortcut?: string }[]): string | undefined {
  const found = commands.find((command) => command.name === LOCK_COMMAND)?.shortcut;
  return found ? found : undefined;
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
      if (res.state.hasPassword) return;
      lock.disabled = true;
      status.classList.add('note');
      status.textContent = t('popupNotSet');
      settings.classList.remove('secondary');
      settings.focus();
    })
    .catch((err) => console.warn('getState failed', err));

  browser.commands
    .getAll()
    .then((commands) => {
      const keys = shortcutOf(commands);
      if (!keys) return;
      shortcut.textContent = t('popupShortcut', keys);
      shortcut.hidden = false;
    })
    .catch((err) => console.warn('commands.getAll failed', err));
}

if (typeof document !== 'undefined') init();
