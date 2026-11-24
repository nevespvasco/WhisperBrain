# Packaging and at-rest protection: evaluations

Three open questions from the roadmap, written down with what is known, what was checked, and what still needs a person with the
right machine or credentials. Nothing here changes the build; the recommendations are marked as such.

## 1. Encrypting the database at rest

**What is stored:** `whisperbrain.sqlite` holds transcripts, notes, summaries, the names of other people, voice prints and (since
1.1) sealed API keys. The secrets are already encrypted (`src/core/secret-box.js`); everything else is plain SQLite. The file is
created with mode 0600 (`src/core/db.js`).

**What encryption at rest would protect against:** somebody who gets the *file* but not the logged-in user session: a lost laptop
without disk encryption, a copied backup, a synced folder. It does not protect against malware running as the user, which can ask
the same keystore for the key.

| Option | Verdict |
|---|---|
| **SQLCipher** | Not available. `node:sqlite` is the stock SQLite build; SQLCipher is a different build of the library, not an extension, so it cannot be loaded into it. |
| **A native module with built-in encryption** (e.g. better-sqlite3 with the multiple-ciphers build) | Works, but adds a per-OS native dependency to build, sign and unpack: the project chose `node:sqlite` precisely to have none (see the comment at the top of `src/core/db.js`). Not recommended for the gain. |
| **Encrypting some columns** (transcript, body, summary) with a key kept in the `SecretBox` | Possible, but search is the problem: the FTS5 indexes (`search`, `seg_fts`) hold the same text in the clear, and an index over encrypted text is useless. Encrypting the indexes too means no word search, no analytics, no semantic search. Rejected. |
| **Full-disk encryption** (FileVault, BitLocker, LUKS) | Covers the threat above, costs nothing, works for the recordings and spool files as well as the database. **Recommended baseline**; the first-run screen or the README should say so. |
| **An encrypted container for the data folder** (gocryptfs, VeraCrypt) | Fine for people who want it; not something to build into the app. |

**Recommendation:** document full-disk encryption as the supported way, keep the 0600 mode, keep secrets sealed. Revisit if
`node:sqlite` gains an official encryption option. Not verified: how much of this a given user already has; the first-run
check could read it (`fdesetup status`, `manage-bde -status`, `lsblk -o NAME,TYPE`), but only as a hint.

## 2. macOS signing and notarization

**What is in the repo:** `mac.hardenedRuntime: true`, `build/entitlements.mac.plist` (JIT, unsigned executable memory, library
validation off for the native speech engine, microphone, audio input, Apple events), the usage descriptions in `mac.extendInfo`
(`NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription`, ...), and a CI job that builds unsigned installers with
`CSC_IDENTITY_AUTO_DISCOVERY: "false"`.

**What is missing, and needs your Apple Developer account:**

1. A *Developer ID Application* certificate exported as a `.p12`. In GitHub: secrets `CSC_LINK` (base64 of the `.p12`) and
   `CSC_KEY_PASSWORD`.
2. Notarization credentials, either an App Store Connect API key (`APPLE_API_KEY` = the `.p8` contents or path,
   `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) or an Apple ID with an app-specific password (`APPLE_ID`,
   `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`). electron-builder notarizes when these are present and `mac.notarize` is not
   `false`; check the option name against the electron-builder version in use (26.x here) before relying on it.
3. In `.github/workflows/build.yml`, the `dist` job for macOS: remove `CSC_IDENTITY_AUTO_DISCOVERY: "false"` and pass the secrets,
   only when they exist (a fork's pull request has none, and must keep producing the unsigned build).

**Things specific to this app to check on the first signed build:**

- The helper programs (`whisperbrain-ax`, `whisperbrain-tap`) and the `sherpa-onnx` `.node` and `.dylib` files are Mach-O files
  inside the bundle: all must be signed with the hardened runtime and the same team. electron-builder signs what it finds in the
  app; verify, do not assume: `codesign --verify --deep --strict --verbose=2 WhisperBrain.app`.
- Gatekeeper and notarization: `spctl --assess --type execute -vv WhisperBrain.app` and `xcrun stapler validate WhisperBrain.dmg`.
- The system-audio permission is attributed to the *responsible process*. The tap helper runs as a child of the app, so the grant
  should be the app's; this needs trying on a Mac with a signed build, since an unsigned or ad-hoc build can behave differently.
- `com.apple.security.cs.disable-library-validation` is needed while the speech engine ships third-party dylibs; it weakens the
  hardened runtime and should be dropped if they are ever re-signed with the project's team ID.

## 3. The AppImage `--no-sandbox` flag

**What the config says:** `linux.executableArgs: ["--no-sandbox"]` in `electron-builder.yml`, with the comment "The AppImage cannot
ship a setuid chrome-sandbox; the app only ever loads its own local UI".

**What was checked** (in `node_modules/app-builder-lib`, electron-builder 26.x):

- `executableArgs` set under `linux:` is written into the `Exec=` line of the desktop entry for **every** Linux target. So the `.deb`
  launcher passes `--no-sandbox` too.
- The `.deb` installer script (`templates/linux/after-install.tpl`) does the right thing for the sandbox: it tests whether user
  namespaces work, and makes `chrome-sandbox` setuid root only where they do not. On a normal system the namespace sandbox would
  run. So the `.deb` is the target where the sandbox could be kept, and the flag switches it off.
- `scripts/start.js` says "Packaged .deb builds keep the sandbox". With the flag above, that is not what the desktop entry does.
  The comment and the config disagree.

**Why the flag exists:** an AppImage is a read-only mount owned by the user: it cannot contain a setuid-root helper, so the
setuid sandbox is out; the namespace sandbox needs unprivileged user namespaces, which some distributions restrict (Ubuntu 24.04
and later restrict them with AppArmor unless the application has a profile).

**What is at stake:** the renderer loads only `http://127.0.0.1:<port>` (the app's own UI) and the app does not open arbitrary
web content, which limits the exposure. But the window also loads transcripts and names that other people typed
(meeting titles, display names, caption text) into the page: the UI escapes them (`esc()`), and a missed escape would be a
script running without a sandbox around it. The sandbox is the second line of defence there.

**Recommendation (not applied, because it has to be tried on real systems):**

1. Keep `--no-sandbox` for the AppImage only: give the `.deb` its own `deb.executableArgs: []`, or move the flag to a wrapper that
   only the AppImage uses. Check the generated `.desktop` file inside both packages (`dpkg -x` / `--appimage-extract`).
2. Try the AppImage without the flag on Ubuntu 22.04 (should work), Ubuntu 24.04 (AppArmor restriction: expected to fail without
   a profile) and Fedora; if it works where namespaces are allowed, launch with the sandbox and fall back to `--no-sandbox` only when
   the first start fails, with a one-line note in the log.
3. Whatever is decided, fix the comment in `scripts/start.js` (the dev copy of Electron has no setuid helper, and `npm start`
   is not a packaged build).
