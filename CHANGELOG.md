# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-13

### Added

- Password lock for the sites you choose. A locked site and all of its subdomains show a lock screen instead of the page, and the page is not loaded until the password is entered.
- One password for every locked site. It is stored only as a PBKDF2-SHA256 hash (600,000 iterations, random salt) and cannot be recovered; reinstall the extension to reset it.
- Locks again after 1-60 minutes without keyboard or mouse input (default 5), when the screen locks (can be switched off), when the last Chrome window closes, and when Chrome restarts.
- Open tabs of a locked site are replaced by the lock screen when the lock comes back, and Back does not bring the old page back. A tab that showed a locked site and then moved on to another site is reopened without its history for the same reason. One unlock sends every open lock screen back to its site.
- Wrong-password wait: after 5 failed tries the wait grows with each try, up to 15 minutes.
- Settings page, protected by the same password: add and remove sites, suggestions for related domains, auto-lock time, lock on screen lock, extensions-page guard, change password.
- Extensions-page guard: while locked, opening `chrome://extensions` shows the lock screen. It can be switched off in Settings and is left out of the `noguard` build.
- Site access is asked for one site at a time, when you add it. Sites stay blocked even if site access is later withdrawn in Chrome's toolbar menu.
- English, Korean and Japanese screens.
- README in English, Korean and Japanese, a privacy policy, and optional Chrome policy files (macOS configuration profile, Windows registry file) to turn off DevTools and force-install the extension.
- Two release builds: the store build and the `noguard` build.

### Security

- No network requests, no analytics, no remote code. Everything is kept in `chrome.storage.local` on your device.

[Unreleased]: https://github.com/xcryptp/for-my-privacy/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/xcryptp/for-my-privacy/releases/tag/v0.1.0
