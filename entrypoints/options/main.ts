import { browser } from 'wxt/browser';
import { suggestRelated } from '../../src/lib/domain';
import { SETTINGS_GUARD_BUILD } from '../../src/lib/flags';
import { applyI18n, t } from '../../src/lib/i18n';
import { isUnavailable, send, type ErrorCode, type State } from '../../src/lib/messages';
import { originPatterns, releasableOrigins } from '../../src/lib/origins';
import { validatePassword } from '../../src/lib/password';
import { normalizeDomain } from '../../src/lib/registrable-domain';
import { DEFAULT_SETTINGS, getSettings, saveSettings, type Settings } from '../../src/lib/settings';
import { saveSettingsFromInput } from '../../src/lib/settings-input';
import { createCountdown } from '../../src/ui/countdown';
import { lockShortcut } from '../../src/ui/shortcut';
import { wrongPasswordText } from '../../src/ui/tries';
import {
  ONBOARDING_KEY,
  ONBOARDING_STEPS,
  PRESET_SITES,
  PRIVACY_URL,
  REPO_URL,
  addCustomSite,
  commitTypedSite,
  doneTipKey,
  doneTipText,
  limitsUrl,
  nextLabelKey,
  nextStep,
  parseProgress,
  prevStep,
  previewFor,
  resumeStep,
  selectedOrigins,
  toggleSite,
  wildcardForm,
  type OnboardingProgress,
  type Step,
} from './onboarding';
import { focusAfterRemove, idleWasClamped, sectionFromHash, type Section } from './sections';

type View = 'setup' | 'locked' | 'settings';

// How often an open page re-checks whether the worker locked again (idle, screen lock, Lock now elsewhere).
const STATE_POLL_MS = 5000;
const TOAST_MS = 3000;
// After an unlock scope change: how often and how many times to ask whether the sites locked again.
const SCOPE_RELOCK_POLL_MS = 200;
const SCOPE_RELOCK_TRIES = 25;

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

/**
 * Which of the three screens a worker state calls for. Only the settings unlock opens the settings:
 * unlocking the sites (lock page) does not, so the options page always asks for the password itself.
 */
export function viewFor(state: State): View {
  if (!state.hasPassword) return 'setup';
  return state.settingsUnlocked ? 'settings' : 'locked';
}

/** The message for a rejected password request. */
function errorText(code: ErrorCode, triesLeft?: number): string {
  return code === 'too_short' ? t('passwordTooShort') : wrongPasswordText(triesLeft);
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

  const page = byId('page');

  // onboarding (first run)
  const progressText = byId('ob-progress');
  const progressSr = byId('ob-progress-sr');
  const progressBars = [...document.querySelectorAll<HTMLElement>('.progress-bar i')];
  const stepEls: Record<Step, HTMLElement> = {
    1: byId('step-1'),
    2: byId('step-2'),
    3: byId('step-3'),
    4: byId('step-4'),
  };
  const stepHeadings: Record<Step, HTMLElement> = {
    1: byId('step-1-title'),
    2: byId('step-2-title'),
    3: byId('step-3-title'),
    4: byId('step-4-title'),
  };
  const setupForm = byId<HTMLFormElement>('setup-form');
  const setupPassword = byId<HTMLInputElement>('setup-password');
  const setupConfirm = byId<HTMLInputElement>('setup-confirm');
  const setupSubmit = byId<HTMLButtonElement>('setup-submit');
  const setupError = byId('setup-error');
  const setupDone = byId('setup-done');
  const chipBox = byId('ob-chips');
  const obAddForm = byId<HTMLFormElement>('ob-add-form');
  const obDomain = byId<HTMLInputElement>('ob-domain');
  const obPreview = byId('ob-preview');
  const obSiteError = byId('ob-site-error');
  const obNext = byId<HTMLButtonElement>('next-3');
  const obIdle = byId<HTMLInputElement>('ob-idle');
  const obScreenLock = byId<HTMLInputElement>('ob-screen-lock');
  const obFinish = byId<HTMLButtonElement>('finish');
  const obFinishError = byId('ob-finish-error');
  const obSkipSetup = byId<HTMLButtonElement>('ob-skip-setup');

  // unlock
  const unlockForm = byId<HTMLFormElement>('unlock-form');
  const unlockPassword = byId<HTMLInputElement>('unlock-password');
  const unlockSubmit = byId<HTMLButtonElement>('unlock-submit');
  const unlockError = byId('unlock-error');
  const unlockWait = createCountdown(unlockError, unlockSubmit, unlockPassword);
  const lockedNotice = byId('locked-notice');

  // sites
  const addForm = byId<HTMLFormElement>('add-form');
  const domainInput = byId<HTMLInputElement>('domain');
  const domainError = byId('domain-error');
  const domainList = byId<HTMLUListElement>('domains');
  const emptyNote = byId('empty');
  const related = byId('related');
  const domainPreview = byId('domain-preview');
  const banner = byId('permission-lost');
  const grant = byId<HTMLButtonElement>('grant');

  // settings menu
  const tip = byId('tip');
  const menuLinks = [...document.querySelectorAll<HTMLAnchorElement>('#menu a[data-section]')];
  const panels = [...document.querySelectorAll<HTMLElement>('[data-panel]')];
  const sectionHeadings: Record<Section, HTMLElement> = {
    sites: byId('domains-title'),
    autolock: byId('idle-title'),
    security: byId('change-title'),
    about: byId('about-title'),
  };

  // auto-lock and switches
  const idle = byId<HTMLInputElement>('idle');
  const screenLock = byId<HTMLInputElement>('screen-lock');
  const guard = byId<HTMLInputElement>('guard');
  const guardRow = byId('guard-row');
  const scopeAll = byId<HTMLInputElement>('scope-all');
  const scopeSite = byId<HTMLInputElement>('scope-site');

  // change password
  const changeForm = byId<HTMLFormElement>('change-form');
  const current = byId<HTMLInputElement>('current');
  const next = byId<HTMLInputElement>('next');
  const changeSubmit = byId<HTMLButtonElement>('change-submit');
  const confirm = byId<HTMLInputElement>('change-confirm');
  const changeError = byId('change-error');
  const changeWait = createCountdown(changeError, changeSubmit, current);

  let view: View | undefined;
  let settings: Settings | undefined;
  let missingOrigins: string[] = [];
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let toastFrame: number | undefined;
  // Bumped whenever the screen is decided afresh (and when settings are cleared). Async work that
  // started under an older value must not write to the page after its awaits: a relock in between
  // would otherwise bring site names back into the hidden settings, or open the settings after a
  // newer state check already said locked.
  let epoch = 0;

  // Onboarding progress. The password is created at step 2; from then on the worker already grants
  // the settings, so the page stays on the steps until Finish instead of jumping to the settings.
  let step: Step = 1;
  let passwordCreated = false;
  let chips: string[] = [...PRESET_SITES];
  let chosen: string[] = [];
  let savedByOnboarding: string[] = [];
  let pendingTip: ReturnType<typeof doneTipKey> | null = null;
  // True when the steps were picked up again after a reload: then a way out to the settings is offered.
  let resumed = false;

  applyI18n();
  // The README in the language of the page, at its own "what it protects" section.
  const limits = limitsUrl(browser.i18n.getUILanguage());
  byId<HTMLAnchorElement>('learn-more').href = limits;
  byId<HTMLAnchorElement>('link-limits').href = limits;
  byId<HTMLAnchorElement>('guard-more').href = limits;
  byId<HTMLAnchorElement>('link-privacy').href = PRIVACY_URL;
  byId<HTMLAnchorElement>('link-repo').href = REPO_URL;
  byId('about-version').textContent = t('aboutVersion', browser.runtime.getManifest().version);
  obIdle.value = String(DEFAULT_SETTINGS.idleMinutes);
  obScreenLock.checked = DEFAULT_SETTINGS.lockOnScreenLock;
  document.documentElement.lang = browser.i18n.getUILanguage();
  document.title = t('extShortName');
  guardRow.hidden = !SETTINGS_GUARD_BUILD;

  function showToast(message: string): void {
    clearToast();
    // Empty first, then fill on the next frame: a repeated "Saved." is announced again.
    const show = () => {
      toastFrame = undefined;
      toast.textContent = message;
      toastTimer = setTimeout(() => (toast.textContent = ''), TOAST_MS);
    };
    if (document.hidden) show();
    else toastFrame = requestAnimationFrame(show);
  }

  /** Empties the toast and cancels one still waiting for its frame, so it cannot appear afterwards. */
  function clearToast(): void {
    clearTimeout(toastTimer);
    if (toastFrame !== undefined) cancelAnimationFrame(toastFrame);
    toastFrame = undefined;
    toast.textContent = '';
  }

  /** Shows a worker rejection on a password form: a countdown while a wait runs, else the message. */
  function showRejection(
    alert: HTMLElement,
    wait: ReturnType<typeof createCountdown>,
    code: ErrorCode,
    state: State,
  ): void {
    wait.stop();
    if (state.waitMs > 0) {
      wait.start(state.waitMs);
      return;
    }
    alert.textContent = errorText(code, state.triesLeft);
  }

  // ---- screens ----

  function showView(next: View): void {
    view = next;
    for (const [name, el] of Object.entries(views)) el.hidden = name !== next;
    lockNow.hidden = next !== 'settings';
    page.classList.toggle('wide', next === 'settings');
    title.textContent = t(next === 'locked' ? 'settingsLockedTitle' : 'extShortName');
  }

  // ---- settings menu ----

  function showSection(section: Section, focus: boolean): void {
    for (const panel of panels) panel.hidden = panel.dataset.panel !== section;
    for (const link of menuLinks) {
      if (link.dataset.section === section) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    if (focus) sectionHeadings[section].focus();
  }

  // ---- onboarding steps ----

  async function readProgress(): Promise<OnboardingProgress | null> {
    try {
      return parseProgress((await browser.storage.local.get(ONBOARDING_KEY))[ONBOARDING_KEY]);
    } catch (err) {
      console.warn('read onboarding progress failed', err);
      return null;
    }
  }

  function clearProgress(): void {
    browser.storage.local.remove(ONBOARDING_KEY).catch((err) => console.warn('clear onboarding progress failed', err));
  }

  /** Kept so that a reload after the password step resumes here instead of jumping to the settings. */
  function saveProgress(): void {
    if (!passwordCreated) return;
    const progress: OnboardingProgress = { step: resumeStep(step), sites: savedByOnboarding };
    browser.storage.local.set({ [ONBOARDING_KEY]: progress }).catch((err) => console.warn('save onboarding progress failed', err));
  }

  function showStep(next: Step): void {
    step = next;
    for (const [n, el] of Object.entries(stepEls)) el.hidden = Number(n) !== next;
    progressText.textContent = `${next}/${ONBOARDING_STEPS}`;
    progressSr.textContent = t('onboardingProgress', [String(next), String(ONBOARDING_STEPS)]);
    progressBars.forEach((bar, i) => bar.classList.toggle('done', i < next));
    if (next === 2) {
      setupForm.hidden = passwordCreated;
      setupDone.hidden = !passwordCreated;
    }
    obSkipSetup.hidden = !(resumed && next >= 3);
    stepHeadings[next].focus();
    saveProgress();
  }

  /** Picks the steps up again after a reload: the password exists, the sites saved so far are chosen. */
  function resumeOnboarding(progress: OnboardingProgress): void {
    resetOnboarding();
    resumed = true;
    passwordCreated = true;
    savedByOnboarding = [...progress.sites];
    chosen = [...progress.sites];
    chips = [...new Set([...PRESET_SITES, ...progress.sites])];
    renderChips();
    showView('setup');
    showStep(progress.step);
  }

  /** Back to a clean first run: used whenever the screen is decided afresh as "no password yet". */
  function resetOnboarding(): void {
    passwordCreated = false;
    resumed = false;
    chips = [...PRESET_SITES];
    chosen = [];
    savedByOnboarding = [];
    setupPassword.value = '';
    setupConfirm.value = '';
    for (const el of [setupError, obSiteError, obFinishError]) el.textContent = '';
    obDomain.value = '';
    // The "Will lock ..." line holds a site name: nothing of it may stay in hidden markup.
    obPreview.textContent = '';
    obPreview.classList.remove('invalid');
    obIdle.value = String(DEFAULT_SETTINGS.idleMinutes);
    obScreenLock.checked = DEFAULT_SETTINGS.lockOnScreenLock;
    renderChips();
  }

  function renderChips(): void {
    chipBox.replaceChildren(
      ...chips.map((domain) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'secondary choice';
        chip.textContent = domain;
        chip.setAttribute('aria-pressed', String(chosen.includes(domain)));
        chip.addEventListener('click', () => {
          chosen = toggleSite(chosen, domain);
          chip.setAttribute('aria-pressed', String(chosen.includes(domain)));
          updateNextLabel();
        });
        return chip;
      }),
    );
    updateNextLabel();
  }

  /** "Skip" while no site is chosen or typed, "Next" once one is. */
  function updateNextLabel(): void {
    obNext.textContent = t(nextLabelKey(chosen.length, obDomain.value));
  }

  /** The live line under a site field: what the text will lock, or that it is not a site. */
  function renderPreview(el: HTMLElement, raw: string): void {
    const preview = previewFor(raw);
    el.classList.toggle('invalid', preview.kind === 'invalid');
    el.classList.toggle('broader', preview.kind === 'ok' && preview.typed !== undefined);
    el.textContent =
      preview.kind === 'ok'
        ? preview.typed
          ? t('willLockBroader', [preview.domain, preview.typed])
          : t('willLock', preview.domain)
        : preview.kind === 'invalid'
          ? t('invalidDomain')
          : '';
  }

  /** Leaves nothing of the settings behind once locked: no site names, no typed passwords. */
  function clearSettingsView(): void {
    settings = undefined;
    missingOrigins = [];
    domainList.replaceChildren();
    related.replaceChildren();
    banner.hidden = true;
    lockedNotice.hidden = true;
    tip.textContent = '';
    clearToast();
    domainPreview.textContent = '';
    domainPreview.classList.remove('invalid', 'broader');
    for (const input of [current, next, confirm, domainInput]) input.value = '';
    // The other controls go back to their defaults: nothing the owner chose stays in hidden markup.
    idle.value = String(DEFAULT_SETTINGS.idleMinutes);
    screenLock.checked = DEFAULT_SETTINGS.lockOnScreenLock;
    guard.checked = DEFAULT_SETTINGS.settingsGuard;
    showScope(DEFAULT_SETTINGS.unlockScope);
    changeWait.stop();
    changeSubmit.disabled = false;
    for (const el of [changeError, domainError]) el.textContent = '';
  }

  async function applyState(state: State): Promise<void> {
    const wanted = viewFor(state);
    if (wanted === 'settings' && view === 'settings') return;
    // Mid-onboarding the worker already grants the settings; the steps run until Finish.
    if (wanted === 'settings' && view === 'setup' && passwordCreated) return;
    const myEpoch = ++epoch;
    if (wanted === view) {
      // Locked or setup again: only cancels work still in flight. An open locked page also picks up
      // a wait that started elsewhere (wrong guesses on a lock page) without a submit.
      if (wanted === 'locked') syncUnlockWait(state.waitMs);
      return;
    }
    const previous = view;
    if (wanted === 'settings') {
      // A reload during the first run resumes it; Finish removes the record.
      const resume = await readProgress();
      if (myEpoch !== epoch) return;
      if (resume) {
        resumeOnboarding(resume);
        return;
      }
      if (!(await renderSettings(myEpoch))) return; // a newer state replaced this one
    } else {
      clearSettingsView();
      pendingTip = null;
      if (wanted === 'locked') passwordCreated = false; // a relock ends a half-done onboarding
    }
    // Nothing of the first run (site names in the chips) stays in the page outside its steps.
    if (wanted !== 'setup') resetOnboarding();
    showView(wanted);
    if (wanted === 'locked') {
      renderLockedNotice();
      unlockPassword.value = '';
      unlockError.textContent = '';
      if (state.waitMs > 0) unlockWait.start(state.waitMs);
      else {
        unlockWait.stop();
        unlockSubmit.disabled = false;
      }
      unlockPassword.focus();
    } else if (wanted === 'setup') {
      resetOnboarding();
      clearProgress();
      showStep(1);
    } else {
      const section = sectionFromHash(location.hash);
      showSection(section, false);
      if (pendingTip) {
        const key = pendingTip;
        void lockShortcut().then((keys) => {
          if (myEpoch === epoch) tip.textContent = doneTipText(key, keys, t);
        });
      }
      pendingTip = null;
      if (location.hash === '#permission-lost' && !banner.hidden) {
        // The link of the worker's notice leads here: the notice is what the person came for.
        banner.focus();
      } else if (previous !== undefined) {
        // Just unlocked or finished the first run: the first control of the section.
        if (section === 'sites') domainInput.focus();
        else sectionHeadings[section].focus();
      }
    }
  }

  /** Starts the countdown on a locked page that did not submit anything itself. */
  function syncUnlockWait(waitMs: number): void {
    // Under a second left the local countdown is about to end by itself.
    if (unlocking || unlockWait.active || waitMs < 1000) return;
    unlockWait.start(waitMs);
  }

  /** The "site access was removed" notice above the password form; it names no site. */
  function renderLockedNotice(): void {
    lockedNotice.hidden = location.hash !== '#permission-lost';
  }

  async function refreshState(): Promise<void> {
    try {
      await applyState((await send({ type: 'getState' })).state);
    } catch (err) {
      console.warn('getState failed', err);
      if (isUnavailable(err)) unlockError.textContent = t('extensionUpdated');
    }
  }

  // ---- settings view ----

  /** Draws the settings; false when a newer state made this render stale (nothing was written then). */
  async function renderSettings(forEpoch: number): Promise<boolean> {
    const loaded = await getSettings();
    if (forEpoch !== epoch) return false;
    settings = loaded;
    renderDomains();
    idle.value = String(loaded.idleMinutes);
    screenLock.checked = loaded.lockOnScreenLock;
    guard.checked = loaded.settingsGuard;
    showScope(loaded.unlockScope);
    return renderBanner(forEpoch);
  }

  /**
   * Draws the list and the suggestions. `afterRemove` is the index of the row just removed: the focus
   * goes to the button that took its place. Otherwise a focus that sat inside the list or the
   * suggestions stays near where it was, because redrawing replaces the buttons.
   */
  function renderDomains(afterRemove?: number): void {
    const domains = settings?.domains ?? [];
    const rowButtons = () => [...domainList.querySelectorAll<HTMLButtonElement>('button')];
    const active = document.activeElement;
    const keptRow = active && domainList.contains(active) ? rowButtons().indexOf(active as HTMLButtonElement) : -1;
    const keptChip = active !== null && related.contains(active);

    domainList.replaceChildren(
      ...domains.map((domain) => {
        const li = document.createElement('li');
        const site = document.createElement('div');
        site.className = 'site';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = domain;
        const wild = document.createElement('span');
        wild.className = 'wild';
        const plain = document.createElement('span');
        plain.textContent = t('domainAlsoLocks', domain);
        const form = document.createElement('span');
        form.className = 'wild-form';
        form.textContent = wildcardForm(domain);
        wild.append(plain, ' ', form);
        site.append(name, wild);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'secondary';
        remove.textContent = t('removeButton');
        remove.setAttribute('aria-label', `${t('removeButton')}: ${domain}`);
        remove.addEventListener('click', () => void removeDomain(domain));
        li.append(site, remove);
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

    const buttons = rowButtons();
    const row =
      afterRemove !== undefined
        ? focusAfterRemove(afterRemove, domains.length)
        : keptRow >= 0
          ? focusAfterRemove(keptRow, domains.length)
          : undefined;
    if (row === null) domainInput.focus();
    else if (row !== undefined) buttons[row]?.focus();
    else if (keptChip) domainInput.focus(); // the suggestion that was pressed is gone
  }

  /** Shows the "site access was removed" notice while a listed site has no host access. */
  async function renderBanner(forEpoch: number): Promise<boolean> {
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
    if (forEpoch !== epoch) return false;
    missingOrigins = missing;
    const wasHidden = banner.hidden;
    banner.hidden = missing.length === 0;
    if (wasHidden && !banner.hidden && location.hash === '#permission-lost' && view === 'settings') banner.focus();
    return true;
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
      renderPreview(domainPreview, '');
      return;
    }
    // permissions.request needs the user gesture of this click or submit: start it before any await.
    const request = browser.permissions.request({ origins: originPatterns(domain) });
    void finishAdd(domain, request);
  }

  async function finishAdd(domain: string, request: Promise<boolean>): Promise<void> {
    const startEpoch = epoch;
    try {
      const granted = await request;
      if (startEpoch !== epoch) return; // locked meanwhile: touch nothing
      if (!granted) {
        domainError.textContent = t('permissionDenied');
        return;
      }
      const stored = await getSettings();
      if (startEpoch !== epoch) return;
      const saved = await saveSettingsFromInput({ domains: [...stored.domains, domain] });
      if (startEpoch !== epoch) return;
      settings = saved;
      domainError.textContent = '';
      domainInput.value = '';
      renderPreview(domainPreview, '');
      tip.textContent = ''; // the first-run tip is about the first run, not this change
      renderDomains();
      showToast(t('saved'));
      await renderBanner(startEpoch);
    } catch (err) {
      if (startEpoch !== epoch) return;
      console.warn('add site failed', err);
      domainError.textContent = t('permissionDenied');
    }
  }

  async function removeDomain(domain: string): Promise<void> {
    const startEpoch = epoch;
    const index = settings?.domains.indexOf(domain) ?? -1;
    try {
      const stored = await getSettings();
      if (startEpoch !== epoch) return;
      const saved = await saveSettings({ domains: stored.domains.filter((d) => d !== domain) });
      // The list is saved even if the page locked meanwhile; only the screen is left alone then.
      const origins = releasableOrigins(domain, saved.domains);
      if (startEpoch === epoch) {
        settings = saved;
        tip.textContent = '';
        renderDomains(Math.max(index, 0));
        showToast(t('saved'));
      }
      // Give the host access back too (best effort). The worker only reports lost access for a
      // site that is still listed, so this does not raise the notice.
      if (origins.length > 0) await browser.permissions.remove({ origins }).catch(() => false);
      if (startEpoch === epoch) await renderBanner(startEpoch);
    } catch (err) {
      console.warn('remove site failed', err);
    }
  }

  /**
   * Saves the unlock scope. The worker locks the sites again for the change (the settings stay
   * open): the toast says so only once the worker reports them locked, else just "Saved.".
   */
  async function saveScope(scope: Settings['unlockScope']): Promise<void> {
    const startEpoch = epoch;
    let relocked = false;
    await saveField({ unlockScope: scope }, () => '');
    for (let i = 0; i < SCOPE_RELOCK_TRIES && startEpoch === epoch; i++) {
      try {
        if (!(await send({ type: 'getState' })).state.unlocked) {
          relocked = true;
          break;
        }
      } catch (err) {
        console.warn('getState failed', err);
      }
      await new Promise((resolve) => setTimeout(resolve, SCOPE_RELOCK_POLL_MS));
    }
    if (startEpoch === epoch && view === 'settings') showToast(t(relocked ? 'unlockScopeSaved' : 'saved'));
  }

  function showScope(scope: Settings['unlockScope']): void {
    scopeAll.checked = scope === 'all';
    scopeSite.checked = scope === 'site';
  }

  /** Saves one field; `message` tells the toast what happened (default "Saved."). */
  async function saveField(patch: Partial<Settings>, message?: (saved: Settings) => string): Promise<void> {
    const startEpoch = epoch;
    try {
      const saved = await saveSettings(patch);
      if (startEpoch !== epoch) return;
      settings = saved;
      idle.value = String(saved.idleMinutes);
      screenLock.checked = saved.lockOnScreenLock;
      guard.checked = saved.settingsGuard;
      showScope(saved.unlockScope);
      const text = message ? message(saved) : t('saved');
      if (text) showToast(text);
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
        if (res.ok) {
          setupPassword.value = '';
          setupConfirm.value = '';
          // Cancels a render a state check started meanwhile, then goes on to the sites step.
          epoch++;
          passwordCreated = true;
          showStep(3);
        } else if (res.error === 'already_set') {
          setupPassword.value = '';
          setupConfirm.value = '';
          await applyState(res.state);
        } else {
          setupError.textContent = errorText(res.error);
        }
      } catch (err) {
        console.warn('setup failed', err);
        if (isUnavailable(err)) setupError.textContent = t('extensionUpdated');
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
        const res = await send({ type: 'unlockSettings', password: unlockPassword.value });
        unlockPassword.value = '';
        if (res.ok) {
          await applyState(res.state);
          return;
        }
        showRejection(unlockError, unlockWait, res.error, res.state);
        if (!unlockWait.active) unlockPassword.focus();
      } catch (err) {
        unlockPassword.value = '';
        console.warn('unlock failed', err);
        if (isUnavailable(err)) unlockError.textContent = t('extensionUpdated');
      } finally {
        unlocking = false;
        if (!unlockWait.active) unlockSubmit.disabled = false;
      }
    })();
  });

  byId('ob-start').addEventListener('click', () => showStep(2));
  byId('back-2').addEventListener('click', () => {
    setupPassword.value = '';
    setupConfirm.value = '';
    setupError.textContent = '';
    showStep(1);
  });
  byId('back-2-done').addEventListener('click', () => showStep(1));
  byId('next-2-done').addEventListener('click', () => showStep(3));
  byId('back-3').addEventListener('click', () => showStep(prevStep(3)));
  byId('back-4').addEventListener('click', () => showStep(prevStep(4)));

  obAddForm.addEventListener('submit', (event) => {
    event.preventDefault();
    obSiteError.textContent = '';
    const added = addCustomSite(chips, chosen, obDomain.value);
    if (!added) {
      obSiteError.textContent = t('invalidDomain');
      return;
    }
    chips = added.chips;
    chosen = added.selected;
    obDomain.value = '';
    renderPreview(obPreview, '');
    renderChips();
  });
  obDomain.addEventListener('input', () => {
    renderPreview(obPreview, obDomain.value);
    updateNextLabel();
  });

  obNext.addEventListener('click', () => {
    obSiteError.textContent = '';
    // A site typed but not added counts as added: the same check as the Add button.
    const typed = commitTypedSite(chips, chosen, obDomain.value);
    if (typed.kind === 'invalid') {
      obSiteError.textContent = t('invalidDomain');
      obDomain.focus();
      return;
    }
    if (typed.kind === 'added') {
      chips = typed.chips;
      chosen = typed.selected;
      obDomain.value = '';
      renderPreview(obPreview, '');
      renderChips();
    }
    const sites = [...chosen];
    // One request for every chosen site, started right here: Chrome needs the user gesture of this click.
    const request = sites.length > 0 ? browser.permissions.request({ origins: selectedOrigins(sites) }) : undefined;
    void finishSites(sites, request);
  });

  async function finishSites(sites: string[], request: Promise<boolean> | undefined): Promise<void> {
    const startEpoch = epoch;
    obNext.disabled = true;
    try {
      const granted = request ? await request : true;
      if (startEpoch !== epoch) return;
      if (!granted) {
        obSiteError.textContent = t('permissionDenied');
        return;
      }
      const stored = await getSettings();
      if (startEpoch !== epoch) return;
      // Replace what an earlier pass over this step saved; leave anything else in the list alone.
      const kept = stored.domains.filter((d) => !savedByOnboarding.includes(d));
      await saveSettings({ domains: [...kept, ...sites] });
      if (startEpoch !== epoch) return;
      savedByOnboarding = sites;
      showStep(nextStep(3));
    } catch (err) {
      if (startEpoch !== epoch) return;
      console.warn('save sites failed', err);
      obSiteError.textContent = t('permissionDenied');
    } finally {
      obNext.disabled = false;
    }
  }

  /** Ends the first run: the next state check shows the settings (or the unlock form if it locked). */
  async function leaveOnboarding(): Promise<void> {
    passwordCreated = false;
    // Only a site that was really saved makes "your sites are locked" true.
    pendingTip = doneTipKey(savedByOnboarding.length);
    await browser.storage.local.remove(ONBOARDING_KEY);
    await refreshState();
  }

  obFinish.addEventListener('click', () => {
    void (async () => {
      const startEpoch = epoch;
      obFinish.disabled = true;
      obFinishError.textContent = '';
      try {
        const minutes = obIdle.valueAsNumber;
        // saveSettings rounds and clamps the minutes to 1-60.
        await saveSettings({
          idleMinutes: Number.isNaN(minutes) ? DEFAULT_SETTINGS.idleMinutes : minutes,
          lockOnScreenLock: obScreenLock.checked,
        });
        if (startEpoch !== epoch) return;
        await leaveOnboarding();
      } catch (err) {
        console.warn('finish failed', err);
      } finally {
        obFinish.disabled = false;
      }
    })();
  });

  obSkipSetup.addEventListener('click', () => {
    void leaveOnboarding().catch((err) => console.warn('skip setup failed', err));
  });

  domainInput.addEventListener('input', () => renderPreview(domainPreview, domainInput.value));

  window.addEventListener('hashchange', () => {
    if (view === 'locked') renderLockedNotice();
    if (view !== 'settings') return;
    tip.textContent = ''; // the first-run tip belongs to the screen that showed it
    clearToast(); // so does a "Saved." of the section that was left
    showSection(sectionFromHash(location.hash), true);
  });

  addForm.addEventListener('submit', (event) => {
    event.preventDefault();
    addDomain(domainInput.value);
  });

  grant.addEventListener('click', () => {
    // Started synchronously for the user gesture; the origins were worked out when the notice was drawn.
    const startEpoch = epoch;
    const request = browser.permissions.request({ origins: missingOrigins });
    void request
      .then(() => renderBanner(startEpoch))
      .catch((err) => console.warn('grant failed', err));
  });

  idle.addEventListener('change', () => {
    const minutes = idle.valueAsNumber;
    if (Number.isNaN(minutes)) {
      idle.value = String(settings?.idleMinutes ?? '');
      return;
    }
    // saveSettings rounds and clamps to 1-60; the field then shows what was stored, and the toast
    // says so when the value was changed.
    void saveField({ idleMinutes: minutes }, (saved) =>
      idleWasClamped(minutes, saved.idleMinutes) ? t('idleClamped', String(saved.idleMinutes)) : t('saved'),
    );
  });
  screenLock.addEventListener('change', () => void saveField({ lockOnScreenLock: screenLock.checked }));
  guard.addEventListener('change', () => void saveField({ settingsGuard: guard.checked }));
  for (const radio of [scopeAll, scopeSite]) {
    radio.addEventListener('change', () => {
      // The worker locks the sites again when the scope changes (the settings stay open): say so.
      if (radio.checked) void saveScope(radio.value === 'site' ? 'site' : 'all');
    });
  }

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
      if (next.value !== confirm.value) {
        changeError.textContent = t('passwordMismatch');
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
          confirm.value = '';
          showToast(t('saved'));
          return;
        }
        current.value = '';
        showRejection(changeError, changeWait, res.error, res.state);
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
    // A relock locks the settings: hide them at once instead of at the next state check.
    if (area === 'session' && 'settingsUnlocked' in changes) {
      if (changes.settingsUnlocked?.newValue !== true) void refreshState();
      return;
    }
    if (area !== 'local' || !('settings' in changes) || view !== 'settings') return;
    void renderSettings(epoch).catch((err) => console.warn('refresh failed', err));
  });

  // Keep the screen true to the worker: it may relock on idle, screen lock or window close.
  // A hidden tab keeps no settings in the page (tab previews, a relock while away); they are
  // drawn again when it comes back.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      void refreshState();
      return;
    }
    if (view !== 'settings') return;
    epoch++;
    clearSettingsView();
    views.settings.hidden = true;
    view = undefined;
  });
  window.addEventListener('focus', () => void refreshState());
  setInterval(() => {
    if (!document.hidden) void refreshState();
  }, STATE_POLL_MS);

  void refreshState();
}

if (typeof document !== 'undefined') init();
