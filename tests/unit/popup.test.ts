import { describe, expect, it } from 'vitest';
import { LOCK_COMMAND, shortcutOf, stateLineKey } from '../../entrypoints/popup/main';

describe('shortcutOf', () => {
  it('returns the shortcut set for Lock now', () => {
    expect(LOCK_COMMAND).toBe('lock-now');
    expect(shortcutOf([{ name: '_execute_action', shortcut: '' }, { name: 'lock-now', shortcut: 'Ctrl+Shift+L' }])).toBe(
      'Ctrl+Shift+L',
    );
  });

  it('is undefined when the command has no shortcut or does not exist', () => {
    expect(shortcutOf([{ name: 'lock-now', shortcut: '' }])).toBeUndefined();
    expect(shortcutOf([{ name: 'lock-now' }])).toBeUndefined();
    expect(shortcutOf([{ name: 'other', shortcut: 'Ctrl+K' }])).toBeUndefined();
    expect(shortcutOf([])).toBeUndefined();
  });
});

describe('stateLineKey', () => {
  it('says whether some site is open right now', () => {
    expect(stateLineKey({ hasPassword: true, unlocked: false })).toBe('popupAllLocked');
    expect(stateLineKey({ hasPassword: true, unlocked: true })).toBe('popupSomeUnlocked');
    expect(stateLineKey({ hasPassword: false, unlocked: false })).toBeUndefined();
  });
});
