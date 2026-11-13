import { t } from '../lib/i18n';

type Translate = (key: string, subs?: string | string[]) => string;

/** Whole minutes and seconds of a wait, rounded up so a running wait never shows zero. */
export function countdownParts(ms: number): { minutes: number; seconds: number } {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return { minutes: Math.floor(total / 60), seconds: total % 60 };
}

/** Remaining wait with unit words, such as "30 s", "2 min" or "2 min 5 s" (localized through the messages). */
export function formatCountdown(ms: number, tr: Translate = t): string {
  const { minutes, seconds } = countdownParts(ms);
  if (minutes === 0) return tr('waitSeconds', String(seconds));
  if (seconds === 0) return tr('waitMinutes', String(minutes));
  return tr('waitMinutesSeconds', [String(minutes), String(seconds)]);
}

/**
 * When a wait ends the field takes the focus back only if the user left it nowhere else: on the page
 * itself, the disabled button or the field. A control the person moved to is left alone.
 */
export function shouldRefocus(
  active: Element | null,
  page: Element | null,
  button: Element,
  input: Element,
): boolean {
  return active === null || active === page || active === button || active === input;
}

export interface Countdown {
  /** Shows the wait with units in the alert, updated every second; the button stays disabled until it ends. */
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
        if (shouldRefocus(document.activeElement, document.body, button, input)) input.focus();
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
