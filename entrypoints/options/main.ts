import { browser } from 'wxt/browser';
import { normalizeDomain, suggestRelated } from '../../src/lib/domain';
import { SETTINGS_GUARD_BUILD } from '../../src/lib/flags';
import { applyI18n, t } from '../../src/lib/i18n';
import { send, type ErrorCode, type State } from '../../src/lib/messages';
import { originPatterns, releasableOrigins } from '../../src/lib/origins';
import { validatePassword } from '../../src/lib/password';
import { getSettings, saveSettings, type Settings } from '../../src/lib/settings';
import { createCountdown } from '../../src/ui/countdown';

type View = 'setup' | 'locked' | 'settings';

// How often an open page re-checks whether the worker locked again (idle, screen lock, Lock now elsewhere).
const STATE_POLL_MS = 5000;
const TOAST_MS = 3000;

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

/** Which of the three screens a worker state calls for. */
export function viewFor(state: State): View {
  if (!state.hasPassword) return 'setup';
  return state.unlocked ? 'settings' : 'locked';
}

/** The message for a rejected password request. */
function errorText(code: ErrorCode): string {
  return t(code === 'too_short' ? 'passwordTooShort' : 'wrongPassword');
}

function init(): void {
  const title = byId('title');
  const lockNow = byId<HTMLButtonElement>('lock-now');
  const views: Record<View, HTMLElement> = {
    setup: byId('view-setup'),
    locked: byId('view-locked'),
    settings: byId('view-settings'),
  };
  const toast = byId('toast');

  // setup
  const setupForm = byId<HTMLFormElement>('setup-form');
  const setupPassword = byId<HTMLInputElement>('setup-password');
  const setupConfirm = byId<HTMLInputElement>('setup-confirm');
  const setupSubmit = byId<HTMLButtonElement>('setup-submit');
  const setupError = byId('setup-error');

  // unlock
  const unlockForm = byId<HTMLFormElement>('unlock-form');
  const unlockPassword = byId<HTMLInputElement>('unlock-password');
  const unlockSubmit = byId<HTMLButtonElement>('unlock-submit');
  const unlockError = byId('unlock-error');
  const unlockWait = createCountdown(unlockError, unlockSubmit, unlockPassword);

  // sites
  const addForm = byId<HTMLFormElement>('add-form');
  const domainInput = byId<HTMLInputElement>('domain');
  const domainError = byId('domain-error');
  const domainList = byId<HTMLUListElement>('domains');
  const emptyNote = byId('empty');
  const related = byId('related');
  const banner = byId('permission-lost');
  const grant = byId<HTMLButtonElement>('grant');

  // auto-lock and switches
  const idle = byId<HTMLInputElement>('idle');
  const screenLock = byId<HTMLInputElement>('screen-lock');
  const guard = byId<HTMLInputElement>('guard');
  const guardRow = byId('guard-row');

  // change password
  const changeForm = byId<HTMLFormElement>('change-form');
  const current = byId<HTMLInputElement>('current');
  const next = byId<HTMLInputElement>('next');
  const changeSubmit = byId<HTMLButtonElement>('change-submit');
  const changeError = byId('change-error');
  const changeWait = createCountdown(changeError, changeSubmit, current);

  let view: View | undefined;
  let settings: Settings | undefined;
  let missingOrigins: string[] = [];
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  applyI18n();
  document.documentElement.lang = browser.i18n.getUILanguage();
  document.title = t('extShortName');
  guardRow.hidden = !SETTINGS_GUARD_BUILD;

  function showToast(message: string): void {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toastTimer = setTimeout(() => (toast.textContent = ''), TOAST_MS);
  }

  /** Shows a worker rejection on a password form: a countdown while a wait runs, else the message. */
  function showRejection(
    alert: HTMLElement,
    wait: ReturnType<typeof createCountdown>,
    code: ErrorCode,
    waitMs: number,
  ): void {
    wait.stop();
    if (waitMs > 0) {
      wait.start(waitMs);
      return;
    }
    alert.textContent = errorText(code);
  }

  // ---- screens ----

  function showView(next: View): void {
    view = next;
    for (const [name, el] of Object.entries(views)) el.hidden = name !== next;
    lockNow.hidden = next !== 'settings';
    title.textContent = t(next === 'setup' ? 'setupTitle' : next === 'locked' ? 'settingsLockedTitle' : 'extShortName');
  }

  /** Leaves nothing of the settings behind once locked: no site names, no typed passwords. */
  function clearSettingsView(): void {
    settings = undefined;
    missingOrigins = [];
    domainList.replaceChildren();
    related.replaceChildren();
    banner.hidden = true;
    for (const input of [current, next, domainInput]) input.value = '';
    changeWait.stop();
    changeSubmit.disabled = false;
    for (const el of [changeError, domainError]) el.textContent = '';
  }

  async function applyState(state: State): Promise<void> {
    const wanted = viewFor(state);
    if (wanted === view) return;
    const previous = view;
    if (wanted === 'settings') {
      await renderSettings();
      if (view === 'settings') return; // another call got there first
    } else {
      clearSettingsView();
    }
    showView(wanted);
    if (wanted === 'locked') {
      unlockPassword.value = '';
      unlockError.textContent = '';
      if (state.waitMs > 0) unlockWait.start(state.waitMs);
      else {
        unlockWait.stop();
        unlockSubmit.disabled = false;
      }
      unlockPassword.focus();
    } else if (wanted === 'setup') {
      setupPassword.focus();
    } else if (previous !== undefined) {
      // Just unlocked or created the password: the first control is the site field.
      domainInput.focus();
    }
  }

  async function refreshState(): Promise<void> {
    try {
      await applyState((await send({ type: 'getState' })).state);
    } catch (err) {
      console.warn('getState failed', err);
    }
  }

  // ---- settings view ----

  async function renderSettings(): Promise<void> {
    settings = await getSettings();
    renderDomains();
    idle.value = String(settings.idleMinutes);
    screenLock.checked = settings.lockOnScreenLock;
    guard.checked = settings.settingsGuard;
    await renderBanner();
  }

  function renderDomains(): void {
    const domains = settings?.domains ?? [];
    domainList.replaceChildren(
      ...domains.map((domain) => {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = domain;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'secondary';
        remove.textContent = t('removeButton');
        remove.setAttribute('aria-label', `${t('removeButton')}: ${domain}`);
        remove.addEventListener('click', () => void removeDomain(domain));
        li.append(name, remove);
        return li;
      }),
    );
    emptyNote.hidden = domains.length > 0;

    const suggestions = new Set<string>();
    for (const domain of domains) {
      for (const sibling of suggestRelated(domain)) if (!domains.includes(sibling)) suggestions.add(sibling);
    }
    related.replaceChildren(
      ...[...suggestions].map((domain) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'secondary';
        chip.textContent = t('relatedSuggestion', domain);
        // Chrome only shows the permission prompt for a click, so the request starts right here.
        chip.addEventListener('click', () => addDomain(domain));
        return chip;
      }),
    );
  }

  /** Shows the "site access was removed" notice while a listed site has no host access. */
  async function renderBanner(): Promise<void> {
    const missing: string[] = [];
    for (const domain of settings?.domains ?? []) {
      const origins = originPatterns(domain);
      let has = false;
      try {
        has = await browser.permissions.contains({ origins });
      } catch (err) {
        console.warn('permissions.contains failed', err);
        has = true; // do not nag when Chrome cannot tell
      }
      if (!has) missing.push(...origins);
    }
    missingOrigins = missing;
    const wasHidden = banner.hidden;
    banner.hidden = missing.length === 0;
    if (wasHidden && !banner.hidden && location.hash === '#permission-lost') banner.scrollIntoView();
  }

  function addDomain(raw: string): void {
    domainError.textContent = '';
    const domain = normalizeDomain(raw);
    if (!domain) {
      domainError.textContent = t('invalidDomain');
      return;
    }
    if (settings?.domains.includes(domain)) {
      domainInput.value = '';
      return;
    }
    // permissions.request needs the user gesture of this click or submit: start it before any await.
    const request = browser.permissions.request({ origins: originPatterns(domain) });
    void finishAdd(domain, request);
  }

  async function finishAdd(domain: string, request: Promise<boolean>): Promise<void> {
    try {
      if (!(await request)) {
        domainError.textContent = t('permissionDenied');
        return;
      }
      const stored = await getSettings();
      settings = await saveSettings({ domains: [...stored.domains, domain] });
      domainInput.value = '';
      renderDomains();
      await renderBanner();
      showToast(t('saved'));
    } catch (err) {
      console.warn('add site failed', err);
      domainError.textContent = t('permissionDenied');
    }
  }

  async function removeDomain(domain: string): Promise<void> {
    try {
      const stored = await getSettings();
      const remaining = stored.domains.filter((d) => d !== domain);
      settings = await saveSettings({ domains: remaining });
      renderDomains();
      showToast(t('saved'));
      // Give the host access back too (best effort). The worker only reports lost access for a
      // site that is still listed, so this does not raise the notice.
      const origins = releasableOrigins(domain, settings.domains);
      if (origins.length > 0) await browser.permissions.remove({ origins }).catch(() => false);
      await renderBanner();
    } catch (err) {
      console.warn('remove site failed', err);
    }
  }

  async function saveField(patch: Partial<Settings>): Promise<void> {
    try {
      settings = await saveSettings(patch);
      idle.value = String(settings.idleMinutes);
      screenLock.checked = settings.lockOnScreenLock;
      guard.checked = settings.settingsGuard;
      showToast(t('saved'));
    } catch (err) {
      console.warn('save failed', err);
    }
  }

  // ---- events ----

  setupForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      if (setupSubmit.disabled) return;
      setupError.textContent = '';
      const password = setupPassword.value;
      if (validatePassword(password) !== 'ok') {
        setupError.textContent = t('passwordTooShort');
        return;
      }
      if (password !== setupConfirm.value) {
        setupError.textContent = t('passwordMismatch');
        return;
      }
      setupSubmit.disabled = true;
      try {
        const res = await send({ type: 'setup', password });
        if (res.ok || res.error === 'already_set') {
          setupPassword.value = '';
          setupConfirm.value = '';
          await applyState(res.state);
        } else {
          setupError.textContent = errorText(res.error);
        }
      } catch (err) {
        console.warn('setup failed', err);
      } finally {
        setupSubmit.disabled = false;
      }
    })();
  });

  let unlocking = false;
  unlockForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      if (unlocking || unlockSubmit.disabled) return;
      unlocking = true;
      unlockSubmit.disabled = true;
      unlockWait.stop();
      unlockError.textContent = '';
      try {
        const res = await send({ type: 'unlock', password: unlockPassword.value });
        unlockPassword.value = '';
        if (res.ok) {
          await applyState(res.state);
          return;
        }
        showRejection(unlockError, unlockWait, res.error, res.state.waitMs);
        if (!unlockWait.active) unlockPassword.focus();
      } catch (err) {
        console.warn('unlock failed', err);
      } finally {
        unlocking = false;
        if (!unlockWait.active) unlockSubmit.disabled = false;
      }
    })();
  });

  addForm.addEventListener('submit', (event) => {
    event.preventDefault();
    addDomain(domainInput.value);
  });

  grant.addEventListener('click', () => {
    // Started synchronously for the user gesture; the origins were worked out when the notice was drawn.
    const request = browser.permissions.request({ origins: missingOrigins });
    void request
      .then(() => renderBanner())
      .catch((err) => console.warn('grant failed', err));
  });

  idle.addEventListener('change', () => {
    const minutes = idle.valueAsNumber;
    if (Number.isNaN(minutes)) {
      idle.value = String(settings?.idleMinutes ?? '');
      return;
    }
    // saveSettings rounds and clamps to 1-60; the field then shows what was stored.
    void saveField({ idleMinutes: minutes });
  });
  screenLock.addEventListener('change', () => void saveField({ lockOnScreenLock: screenLock.checked }));
  guard.addEventListener('change', () => void saveField({ settingsGuard: guard.checked }));

  let changing = false;
  changeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      if (changing || changeSubmit.disabled) return;
      changeError.textContent = '';
      if (validatePassword(next.value) !== 'ok') {
        changeError.textContent = t('passwordTooShort');
        return;
      }
      changing = true;
      changeSubmit.disabled = true;
      changeWait.stop();
      try {
        const res = await send({ type: 'changePassword', current: current.value, next: next.value });
        if (res.ok) {
          current.value = '';
          next.value = '';
          showToast(t('saved'));
          return;
        }
        current.value = '';
        showRejection(changeError, changeWait, res.error, res.state.waitMs);
        if (!changeWait.active) current.focus();
        // The worker may have locked meanwhile; the next state check swaps the screen.
        void applyState(res.state);
      } catch (err) {
        console.warn('change password failed', err);
      } finally {
        changing = false;
        if (!changeWait.active) changeSubmit.disabled = false;
      }
    })();
  });

  lockNow.addEventListener('click', () => {
    void (async () => {
      try {
        await applyState((await send({ type: 'lockNow' })).state);
      } catch (err) {
        console.warn('lock now failed', err);
      }
    })();
  });

  // A change made on another options tab shows here too.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !('settings' in changes) || view !== 'settings') return;
    void renderSettings().catch((err) => console.warn('refresh failed', err));
  });

  // Keep the screen true to the worker: it may relock on idle, screen lock or window close.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refreshState();
  });
  window.addEventListener('focus', () => void refreshState());
  setInterval(() => {
    if (!document.hidden) void refreshState();
  }, STATE_POLL_MS);

  void refreshState();
}

if (typeof document !== 'undefined') init();
