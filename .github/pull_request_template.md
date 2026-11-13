## What and why

<!-- One or two sentences: the change and the reason. Link the issue if there is one. -->

## Checklist

- [ ] Failing test written first (unit in `tests/unit`, browser behaviour in `tests/e2e`)
- [ ] `npm run typecheck`, `npm test`, `node --test scripts/*.test.mjs` and `npm run test:e2e` pass (list anything not run below)
- [ ] Docs updated if behaviour, UI labels, permissions or stored data changed: README ×3, `docs/usage*.md` ×3, `PRIVACY.md`, `docs/store-listing.md`, `docs/manual-checks.md`, `CHANGELOG.md`
- [ ] Locale parity: `en`, `ko` and `ja` have the same keys, in plain everyday words
- [ ] Permissions unchanged, or the reason is stated here and README, `PRIVACY.md` and `docs/store-listing.md` are updated
- [ ] Security rules kept: a locked site never shows content while locked, every error path fails closed, the unlock state lives only in the session rule, no network requests, no `innerHTML`
- [ ] Screenshots regenerated if the UI changed (`node scripts/screenshots.ts`, `node scripts/usage-screenshots.ts`)
- [ ] No secrets, no real people's names in docs or test data

## Verified and not run

<!-- What you ran and the result; what you could not run (for example the manual checks). -->
