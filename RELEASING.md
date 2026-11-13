# Releasing

Every release bumps the SemVer version. `package.json` is the only version source; WXT copies it into the manifest. A release attaches two zips to a GitHub Release: the store build and the `noguard` build. Submitting to the Chrome Web Store is a separate, manual step.

## 1. Cut a release

1. Make sure `main` (or your release branch) is green in CI and your working tree is clean.
2. Add the new version's section to `CHANGELOG.md` (Keep a Changelog format, heading `## [x.y.z] - YYYY-MM-DD`) and commit it. The release fails if this section is missing or empty.
3. Bump the version, commit and tag in one step:

   ```sh
   npm run release:patch   # 0.1.0 -> 0.1.1
   npm run release:minor   # 0.1.0 -> 0.2.0
   npm run release:major   # 0.1.0 -> 1.0.0
   ```

   This runs `npm version <level> -m "chore(release): v%s"`: it updates `package.json` and `package-lock.json`, creates the commit `chore(release): vX.Y.Z` and the tag `vX.Y.Z`.
4. Push the commit and the tag:

   ```sh
   git push origin HEAD --follow-tags
   ```

5. The `Release` workflow runs on the `v*` tag. It checks that the tag equals `v` + the `package.json` version (`scripts/check-version.mjs`), builds `npm run zip` and `npm run zip:noguard`, extracts the changelog section (`scripts/changelog-section.mjs`) and creates the GitHub Release with both zips:
   - `for-my-privacy-X.Y.Z-chrome.zip` (store build)
   - `for-my-privacy-X.Y.Z-chrome-noguard.zip` (`noguard` build)

## 2. Submit to the Chrome Web Store (manual)

The first upload of the extension is done by hand in the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole); that also gives you the extension ID. Later updates can use the `Submit to Chrome Web Store` workflow:

1. GitHub: Actions, `Submit to Chrome Web Store`, `Run workflow`.
2. Pick the release tag (`vX.Y.Z`) as the ref, so the uploaded zip is the one released.
3. Leave `dry_run` on for a first run: it only checks authentication. Run again with `dry_run` off to upload and submit for review.

The workflow runs `npx wxt submit --chrome-zip .output/for-my-privacy-X.Y.Z-chrome.zip` with the Chrome Web Store API v2. Only the store build is submitted, never the `noguard` build.

### Required repository secrets

Set these under Settings, Secrets and variables, Actions. The names come from `npx wxt submit --help` for the installed WXT (its `publish-browser-extension` 6.2.0); the API v1.1 variables (`CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN`) are deprecated and not used.

| Secret | What |
| --- | --- |
| `CHROME_PUBLISHER_ID` | Publisher ID that owns the extension (dashboard URL `.../devconsole/<publisher-id>`) |
| `CHROME_EXTENSION_ID` | Extension ID from the dashboard |
| `CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL` | `client_email` of the Google Cloud service account |
| `CHROME_SERVICE_ACCOUNT_PRIVATE_KEY` | `private_key` of that service account (the full PEM text) |

`CHROME_API_VERSION=v2` is set in the workflow itself. The service account must be added to the developer account in the dashboard; see <https://developer.chrome.com/docs/webstore/service-accounts>.

## 3. Checks and scripts

- `node scripts/check-version.mjs` — exits 1 unless `GITHUB_REF_NAME` equals `v` + the `package.json` version.
- `node scripts/changelog-section.mjs <version> [changelog] [out]` — writes the version's section from `CHANGELOG.md` to `notes.md`; exits 1 when the section is missing or empty.
- `node --test scripts/*.test.mjs` — unit tests for both scripts (also run in CI).
