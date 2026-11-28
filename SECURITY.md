# Security

WhisperBrain records meetings and reads mail, chat and calendars on your computer, and its Windows and AppImage builds update
themselves from this repository's releases. Reports about any of that are welcome.

## Reporting a vulnerability

Please report it privately through GitHub: **Security → Report a vulnerability** on
[the repository page](https://github.com/nevespvasco/WhisperBrain/security/advisories/new) (GitHub's private vulnerability
reporting). Do not open a public issue for it.

Useful to include: the version (shown under Settings → Account, or the release tag), the system, what an attacker needs (a message you
receive, a meeting you join, a file you import, local access), and steps or a proof of concept.

You can expect an acknowledgement within a week. Fixes are released as a new version; the advisory is published once
installs have had a chance to update, with credit if you want it.

## Supported versions

Only the latest release gets fixes. The Windows installer and the AppImage update themselves; `.deb` and macOS builds are
updated by installing the new release.

## Scope notes

- The app's UI and API listen on `127.0.0.1` only, behind a per-run token.
- Builds are not code-signed yet (see `docs/packaging.md`); release integrity rests on the release workflow
  (`.github/workflows/release.yml`) and the `SHA256SUMS.txt` published with each release.
