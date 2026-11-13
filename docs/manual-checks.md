# Manual checks

Some behaviour cannot be tested automatically: the automated tests run on macOS with a bundled Chromium, and none of Windows, a real screen lock, a real Chrome restart or a real install's permission warnings is available to them. Run this list before each release, on both macOS and Windows. Use the release zip (loaded unpacked) and a few throwaway sites such as `example.com`.

Setup for every check: create a password, add a site, unlock it, open the site in a tab, then do the step below.

## Screen lock and idle

| # | Check | macOS | Windows |
| --- | --- | --- | --- |
| 1 | Lock the screen (macOS: Control-Command-Q; Windows: Windows-L) with the site unlocked, then sign back in. The open site tab now shows the lock screen and Back does not show the old page. | [ ] | [ ] |
| 2 | In Settings, switch off "lock when the screen locks". Lock the screen and sign back in within the auto-lock time (time spent with the screen locked counts toward idle). The site is still unlocked. Switch it back on afterwards. | [ ] | [ ] |
| 3 | Set auto-lock to 1 minute. Leave the computer without touching keyboard or mouse for a little over 1 minute. The site tab shows the lock screen. | [ ] | [ ] |
| 4 | With auto-lock at 1 minute, keep working in another app (typing, moving the mouse) for 3 minutes. The site stays unlocked: the timer counts input on the whole computer, not only in Chrome. | [ ] | [ ] |

## Windows and restarts

| # | Check | macOS | Windows |
| --- | --- | --- | --- |
| 5 | Close every Chrome window (macOS: the red button on each window, so Chrome keeps running; Windows: with "Continue running background apps" on). Open a new Chrome window and visit the site: it is locked. | [ ] | [ ] |
| 6 | Quit Chrome completely (macOS: Command-Q; Windows: close all windows and exit from the tray icon), start it again and visit the site: it is locked. | [ ] | [ ] |
| 7 | With two Chrome windows open and the site unlocked, close one window. The site stays unlocked. | [ ] | [ ] |

## Extensions page and site access

| # | Check | macOS | Windows |
| --- | --- | --- | --- |
| 8 | While locked, open `chrome://extensions`. It turns into the lock screen within a moment; after unlocking you land on the extensions page. | [ ] | [ ] |
| 9 | In Settings, switch off the extensions-page guard. While locked, `chrome://extensions` opens normally. Switch it back on afterwards. | [ ] | [ ] |
| 10 | In the toolbar extension menu, set the extension's site access for a locked site to "On click" or remove it. The site stays unreachable (blocked page or lock screen), never showing its content, and Settings asks to allow access again. | [ ] | [ ] |

## Chrome policies (README: "Make it stronger with Chrome policies")

Use the store ID of the published extension in place of `<EXTENSION_ID>`. Do this on a test profile or machine, not your daily one.

| # | Check | macOS | Windows |
| --- | --- | --- | --- |
| 11 | Install the policy file (macOS: `docs/hardening/macos/for-my-privacy-chrome.mobileconfig`; Windows: `docs/hardening/windows/for-my-privacy-chrome.reg`) and restart Chrome. `chrome://policy` lists `DeveloperToolsAvailability` = 2 and `ExtensionInstallForcelist` with no errors. | [ ] | [ ] |
| 12 | F12 and Ctrl/Command-Option-I do nothing, and "Inspect" is missing from the page menu. | [ ] | [ ] |
| 13 | The extension shows "Installed by your administrator" on `chrome://extensions`, and its Remove button and the toolbar menu's "Remove from Chrome" are greyed out. | [ ] | [ ] |
| 14 | Remove the policy (macOS: delete the profile in System Settings under Privacy and Security, Profiles, or on newer macOS under General, Device Management; Windows: delete the `DeveloperToolsAvailability` value and the `ExtensionInstallForcelist` key), restart Chrome and confirm the policies are gone from `chrome://policy`. | [ ] | [ ] |
| 15 | With the unpacked build installed (no store ID, so no force-install), apply only the DevTools policy (`DeveloperToolsAvailability` = 2) and restart Chrome. Note whether the extension stays enabled and whether the lock still works, and whether Developer mode on `chrome://extensions` can still be used (reload, Load unpacked). The README warns that this is unverified. Remove the policy again afterwards. | [ ] | [ ] |

## Real sites, restored tabs and the password

| # | Check | macOS | Windows |
| --- | --- | --- | --- |
| 16 | Lock a real site that has its own service worker, such as `instagram.com`. Unlock, open a few of its pages, then in the same tab go to another site. Click **Lock now**. No tab shows the site, and Back and Forward in every tab show the lock screen or other sites, never the locked site's content. While locked, typing the address also shows the lock screen. | [ ] | [ ] |
| 17 | Set Chrome's "On startup" to "Continue where you left off". With the site unlocked and open in a tab, quit Chrome completely and start it again. The restored tab shows the lock screen, not the site. | [ ] | [ ] |
| 18 | With the site unlocked, close its tab, then click **Lock now**. Reopen the closed tab (Ctrl-Shift-T; macOS: Command-Shift-T). It lands on the lock screen. | [ ] | [ ] |
| 19 | When creating the password, changing it and unlocking, note whether Chrome offers to save the password or suggests a generated one, and what it does if you accept. If Chrome saves it to Google Password Manager, the password would leave this device through Chrome's own sync; record exactly what Chrome did. | [ ] | [ ] |

## Quick lock, settings and unlock scope

| # | Check | macOS | Windows |
| --- | --- | --- | --- |
| 20 | With a site unlocked, click the toolbar icon. The popup shows **Lock now**, **Open settings** and the line "Shortcut: ..." with the key that is set. Click **Lock now**: the popup says "Locked" and closes, and the site tab shows the lock screen. On a fresh profile before the password exists, the popup says to finish the setup in Settings and **Lock now** is disabled. | [ ] | [ ] |
| 21 | Press the shortcut (Alt+Shift+L; on macOS the popup should show it as Option+Shift+L) with a site unlocked: the site locks as in check 20, with no password. Open `chrome://extensions/shortcuts`, change the key, and confirm the new key works and the popup shows it. If another extension already uses Alt+Shift+L, confirm the popup shows no shortcut instead of a wrong one. | [ ] | [ ] |
| 22 | In Security choose "Unlock only that site". With two locked sites A and B, the sites lock again, the settings stay open and the page says "Saved. Your sites are locked again." Unlock A: A opens, B still shows its lock screen, and A's lock screen said "This unlocks only A and every address under it." Open `chrome://extensions`: lock screen. Unlocking on A's lock screen does not open the extensions page; unlocking on the extensions lock screen does, until the next lock. | [ ] | [ ] |
| 23 | Switch back to "Unlock all locked sites together". One unlock opens A, B and the extensions page. Then lock and confirm the settings are locked too: opening Settings asks for the password, and unlocking the settings leaves every site locked. Unlocking a site leaves the settings locked. | [ ] | [ ] |
| 24 | On a throwaway profile, use the "Forgot your password?" note on the lock screen: click the puzzle-piece icon, the three-dot menu next to the extension, "Remove from Chrome", then install again. The password and the site list are gone and setup starts over. | [ ] | [ ] |
| 25 | Open a locked site with a long path and query. On the lock screen the address bar shows only the extension's `lock.html#t=` and a code, never the page address, and the lock screen names only the site. | [ ] | [ ] |
| 26 | In Settings, Sites, paste a full link to a page deep under a site (for example `https://a.b.example.com/page?x=1`): the line under the box says all of `example.com` will lock. Paste `https://someone.github.io/`: only `someone.github.io` locks, not other `github.io` sites. | [ ] | [ ] |

## Service workers, frames and permission warnings

| # | Check | macOS | Windows |
| --- | --- | --- | --- |
| 27 | Lock a real site with its own service worker (for example `youtube.com` or `instagram.com`). Unlock, browse several of its pages including one on a subdomain, and leave the tab open. Quit Chrome completely while unlocked (macOS: Command-Q; Windows: close all windows and exit from the tray icon) and start it again. Before visiting the site, open `chrome://serviceworker-internals`: the locked site's registrations are gone. Then visit the site: lock screen, never its content. With "Continue where you left off", the restored tab shows the lock screen; note whether the site's page flashes first. | [ ] | [ ] |
| 28 | Serve a small page over `http://localhost` that embeds a locked site in an iframe. While unlocked, the frame shows the site. Click **Lock now**: the page reloads and the frame no longer shows the site (blocked page). Back and Forward in that tab never show the site's content. Repeat with a text field half filled in so Chrome asks "Leave site?": the tab is replaced and not left showing the frame. | [ ] | [ ] |
| 29 | Install the release zip on a fresh profile and open the extension's permissions (`chrome://extensions`, Details). Chrome lists "Block content on any page" and "Read your browsing history" and nothing else besides site access (on click). `browsingData` must not add a line and `webNavigation` must not add a second history line. If Chrome shows anything else, fix the README, `PRIVACY.md` and `docs/store-listing.md`. Do the same on the Web Store draft's permission preview once it exists. | [ ] | [ ] |
| 30 | In the toolbar extension menu set a locked site's site access to "On click" or remove it, for a site that has a service worker. Lock and visit the site: the lock screen appears, Chrome's blocked page may flash first, and the site's content never shows. | [ ] | [ ] |
| 31 | Allow notifications for a real site that sends web-push messages, unlock it and use it for a moment, then click **Lock now**. Visit it again while still locked: lock screen. Confirm no push notification from the site arrives while it is locked, and note whether notifications return after you unlock and visit the site again (the README says they stop until then). | [ ] | [ ] |

## Record

Release version: ______  Date: ______  Tester: ______  Chrome version (macOS / Windows): ______ / ______
