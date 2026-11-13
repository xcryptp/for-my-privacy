import { clearUnlocked, isUnlocked, setUnlocked, syncBlockRules } from '../src/lib/rules';

// Placeholder: the real background logic arrives in later tasks.
export default defineBackground(() => {
  // Test-only hook for the e2e build; Vite drops this branch from normal builds.
  if (import.meta.env.MODE === 'e2e') {
    (globalThis as Record<string, unknown>).__fmp = { syncBlockRules, setUnlocked, clearUnlocked, isUnlocked };
  }
});
