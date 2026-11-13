import { browser } from 'wxt/browser';

/** The command the worker listens for (`commands` in the manifest); its shortcut is shown when one is set. */
export const LOCK_COMMAND = 'lock-now';

/** The shortcut text of a command list: the one set for Lock now, or undefined when none is set. */
export function shortcutOf(commands: readonly { name?: string; shortcut?: string }[]): string | undefined {
  const found = commands.find((command) => command.name === LOCK_COMMAND)?.shortcut;
  return found ? found : undefined;
}

/** The Lock now shortcut Chrome has now, or undefined when none is set or it cannot be read. */
export async function lockShortcut(): Promise<string | undefined> {
  try {
    return shortcutOf(await browser.commands.getAll());
  } catch (err) {
    console.warn('commands.getAll failed', err);
    return undefined;
  }
}
