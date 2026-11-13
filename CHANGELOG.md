# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-13

### Added

- Password lock for the sites you choose. Any address you paste or type, a bare domain or a full link, is reduced to the site's registrable domain (using the Public Suffix List through `tldts`), and the site and every address under it, at any depth, show a lock screen instead of the page. A link to one subdomain (for example a blog) locks the whole site; sites on shared hosts such as `user.github.io` count as their own site. The page is not loaded until the password is entered.
- One password for every locked site and the settings. It is stored only as a PBKDF2-SHA256 hash (600,000 iterations, random salt) and cannot be recovered. Unlocking sites and opening the settings are separate: the lock screen opens sites, and the settings ask for the password again.
- Unlock scope setting (Security): "Unlock all locked sites together" (default) or "Unlock only that site". Changing it locks the sites again and leaves the settings open. In the second mode the extensions page opens only from its own lock screen.
- Locks again after 1-60 minutes without keyboard or mouse input (default 5), when the screen locks (can be switched off), when the last Chrome window closes, and when Chrome restarts.
- Quick lock without the password: a toolbar popup ("Lock now", "Open settings") and the keyboard shortcut Alt+Shift+L (changeable at `chrome://extensions/shortcuts`).
- Open tabs of a locked site are replaced by the lock screen when the lock comes back, and Back does not bring the old page back. A tab that showed a locked site and then moved on to another site is reopened without its history for the same reason. An unlock sends the open lock screens whose site it opened back to that site. Tabs of locked sites are replaced even without site access (Chrome's blocked page can show first).
- A locked site shown inside another page is blocked, and when the lock comes back the page that embeds it is reloaded (or replaced when it cannot be reloaded).
- A relock, a Chrome start and a newly locked site remove the locked sites' service workers and caches (the `browsingData` permission, which Chrome shows no warning for), so a site cannot answer from its saved copy. Cookies and logins are not touched. The `webNavigation` permission (Chrome shows the same "Read your browsing history" warning as for `tabs`) is used to find frames.
- Lock screens show the site's name, not the visited address; a random code replaces the address in the address bar.
- Wrong-password wait: the lock screen shows the tries left before a wait; after 5 failed tries the wait starts at 30 seconds, doubles with each try up to 15 minutes, and counts down in minutes and seconds.
- First-run setup in four steps (welcome, password, choose sites with one-tap choices, auto-lock). A forgotten password has a help note on the lock screen and the locked settings page.
- Settings page in four sections (Sites, Auto-lock, Security, About): add and remove sites with a live "will lock" line, suggestions for related domains, auto-lock time, lock on screen lock, extensions-page guard, unlock scope, change password.
- Extensions-page guard: while locked, opening `chrome://extensions` shows the lock screen. It can be switched off in Settings and is left out of the `noguard` build.
- Site access is asked for one site at a time, when you add it. Sites stay blocked even if site access is later withdrawn in Chrome's toolbar menu.
- English, Korean and Japanese screens.
- README in English, Korean and Japanese, a privacy policy, and optional Chrome policy files (macOS configuration profile, Windows registry file) to turn off DevTools and force-install the extension.
- Two release builds: the store build and the `noguard` build.

### Security

- No network requests, no analytics, no remote code. Everything is kept in `chrome.storage.local` on your device, plus short-lived values in `chrome.storage.session` that Chrome clears when it closes.
- Documented limits: a site is always locked as a whole registrable domain (a Gmail link locks all of `google.com`); a lock removes the locked sites' service workers, so their web-push notifications stop until the site is visited again while unlocked; the lock page is web-accessible, so any website can detect that the extension is installed.

[Unreleased]: https://github.com/xcryptp/for-my-privacy/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/xcryptp/for-my-privacy/releases/tag/v0.1.0
