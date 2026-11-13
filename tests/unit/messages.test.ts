import { afterEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { ExtensionUnavailableError, isUnavailable, send } from '../../src/lib/messages';

const STATE = { hasPassword: true } as never;

describe('send', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns the worker answer', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockImplementation((async () => ({ ok: true, state: STATE })) as never);
    await expect(send({ type: 'getState' })).resolves.toMatchObject({ ok: true });
  });

  it('says the extension is unavailable when the worker gives no answer (an older build)', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockImplementation((async () => undefined) as never);
    const err = await send({ type: 'unlockSettings', password: 'secret value' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtensionUnavailableError);
    expect(isUnavailable(err)).toBe(true);
    // The password never goes into the error.
    expect((err as Error).message).not.toContain('secret');
  });

  it('says the extension is unavailable when the context was invalidated', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockImplementation((async () => {
      throw new Error('Extension context invalidated.');
    }) as never);
    expect(isUnavailable(await send({ type: 'getState' }).catch((e: unknown) => e))).toBe(true);
  });

  it('says the extension is unavailable when nobody listens', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockImplementation((async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    }) as never);
    expect(isUnavailable(await send({ type: 'getState' }).catch((e: unknown) => e))).toBe(true);
  });

  it('says the extension is unavailable when runtime.id is gone, without sending anything', async () => {
    const sendMessage = vi.spyOn(browser.runtime, 'sendMessage').mockImplementation((async () => ({})) as never);
    const id = vi.spyOn(browser.runtime, 'id', 'get').mockReturnValue(undefined as never);
    expect(isUnavailable(await send({ type: 'getState' }).catch((e: unknown) => e))).toBe(true);
    expect(id).toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('passes other errors through', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockImplementation((async () => {
      throw new Error('boom');
    }) as never);
    const err = await send({ type: 'getState' }).catch((e: unknown) => e);
    expect(isUnavailable(err)).toBe(false);
    expect((err as Error).message).toBe('boom');
  });
});
