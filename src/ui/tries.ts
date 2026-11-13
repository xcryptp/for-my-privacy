import { t } from '../lib/i18n';

/** The message after a wrong password: how many tries are left before the wait, while there are some. */
export function wrongPasswordText(triesLeft: number | undefined, tr: typeof t = t): string {
  if (typeof triesLeft !== 'number' || triesLeft <= 0) return tr('wrongPassword');
  return triesLeft === 1 ? tr('wrongPasswordLastTry') : tr('wrongPasswordTries', String(triesLeft));
}
