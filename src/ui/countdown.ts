import { t } from '../lib/i18n';

/** Remaining wait as `m:ss`, rounded up so it never shows 0:00 while the wait is still running. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export interface Countdown {
  /** Shows the wait as `m:ss` in the alert, updated every second; the button stays disabled until it ends. */
  start(waitMs: number): void;
  /** Stops the ticking and the silent-update mode; leaves the alert text and the button as they are. */
  stop(): void;
  readonly active: boolean;
}

/** The wrong-password wait of a password form: an alert line, the submit button and the field to refocus. */
export function createCountdown(alert: HTMLElement, button: HTMLButtonElement, input: HTMLInputElement): Countdown {
  let timer: ReturnType<typeof setInterval> | undefined;

  function stop(): void {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    alert.removeAttribute('aria-live');
  }

  function start(waitMs: number): void {
    stop();
    const until = Date.now() + waitMs;
    const render = () => {
      const left = until - Date.now();
      if (left <= 0) {
        stop();
        alert.textContent = '';
        button.disabled = false;
        input.focus();
        return;
      }
      alert.textContent = t('tooManyAttempts', formatCountdown(left));
    };
    button.disabled = true;
    render();
    // The alert is announced once with the first value; later ticks stay silent for screen readers.
    window.setTimeout(() => {
      if (timer !== undefined) alert.setAttribute('aria-live', 'off');
    }, 100);
    timer = setInterval(render, 1000);
  }

  return {
    start,
    stop,
    get active() {
      return timer !== undefined;
    },
  };
}
