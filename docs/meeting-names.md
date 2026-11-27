# Names from the meeting window

On a call, the computer only plays one mixed sound, so WhisperBrain can tell the voices apart but not know *who* they are. The call's own window knows: Google Meet shows who is on the call and highlights who is speaking. WhisperBrain reads that, on this computer, and uses it for three things:

1. **Names.** Each voice takes the name that was highlighted while it spoke. A name you typed yourself is never replaced, and a voice WhisperBrain matched to a saved person keeps that person.
2. **The number of voices.** The people on the call (up to 6 others) are the number of voices to expect, which makes the speaker clustering much more accurate than the calendar guest list: it says who actually joined.
3. **Better voices.** Where the names say so clearly, one person who was heard as two voices is joined, and two people heard as one are split. A voice named beyond doubt is remembered, so the next meeting knows it with no help.

Nothing leaves the computer. Settings → Meetings & detection → *Names from the meeting window*.

## Meeting platforms are data

Google Meet is one **entry of a registry** (`src/meet/platforms.js`), not something the code assumes. An entry says how to recognise the platform (page addresses, window titles, meeting code), which applications the native helpers watch for it on each system, its accessibility selectors file, the pages its extension runs on, the default lag of each kind of source, and where your own selectors file goes. Adding a platform (Teams, Zoom, Discord...) is adding an entry, its selectors and a source that speaks the protocol: the hub, the per-recording collector and the name vote do not change.

- Every message carries a `platform`; one without is read as Google Meet, so an extension that is already paired keeps working.
- The native helpers are started with the apps and window titles of the registry (`--apps` and `--title`; `-Apps`/`-Title` on Windows). With only Google Meet registered these are the helpers' old built-in defaults.
- Selectors: `src/meet/selectors/<platform>.json`; your own file wins: `<data folder>/meet-selectors.json` for Google Meet (as before) and `<data folder>/<platform>-selectors.json` for the others.
- `npm run a11y:dump -- --platform <id>` captures the tree of that platform's window (Google Meet when not given).
- The meeting detector names a call after the platform the source reported.
- Settings lists the sources per platform, with whether that platform's selectors were verified.

## Where the names come from

Sources are tried in no particular order and use the same messages (`src/meet/protocol.js`), so everything after them is shared. Use whichever suits you; with more than one connected, the one that highlighted longest is used.

| Source | Linux | macOS | Windows | Needs |
|---|---|---|---|---|
| **The browser, read directly** | ✅ tested | ⚠ built, not run | ⚠ built, not run | the accessibility interface of the system |
| **Browser extension** | ✅ tested | ✅ same extension | ✅ same extension | loading the extension once |
| **A look at the window** | ⚠ not run | ⚠ not run | ⚠ not run | a vision model; off by default |

### The browser, read directly (no extension)

A small native helper per system prints the page of the browser window as a list of nodes, and one reader in Node (`src/meet/a11y.js`) turns that into people and who is speaking, using selectors kept in a data file (`src/meet/selectors/meet.json`).

- **Linux (AT-SPI).** Chromium-based browsers only put the page in the accessibility tree when started with `--force-renderer-accessibility` (measured: no environment variable, bus setting or repeated reading does it). Settings has a switch per browser that adds the flag to *your own copy* of its launcher (`~/.local/share/applications`); removing it puts everything back. Restart the browser from that launcher once. A browser launched from a terminal is not affected.
- **macOS (AX).** The helper asks the browser to build the page's tree (`AXManualAccessibility`, what screen readers do), so the browser needs no special start. It needs the **Accessibility** permission: System Settings → Privacy & Security → Accessibility. A recording never raises that prompt (the watching helper restarts with each one and would nag); if the list does not offer WhisperBrain, add `WhisperBrain.app/Contents/Resources/bin/whisperbrain-ax` with the + button. It also lists browser windows, which is how a Meet call is noticed on macOS (where the microphone cannot be watched).
- **Windows (UI Automation).** Chromium builds the page's tree as soon as a UI Automation client asks, so nothing has to be switched on. The helper is a PowerShell script with C# inside, compiled when it starts by the .NET Framework that Windows already has.

The helper runs only while a recording does.

### Browser extension

`extension/meet/` is a small Manifest V3 extension for Chrome, Edge and Brave. It reads the Meet page, including **live captions** if you turn them on in Meet, and tells the app over `127.0.0.1`.

1. Settings → Meetings → *Accept the browser extension*. The app opens a port (47631, or the next free one) and shows a **pairing code**.
2. In the browser open `chrome://extensions` (or `edge://extensions`, `brave://extensions`), switch on *Developer mode*, *Load unpacked*, and pick the folder (*Show the folder* opens it).
3. Open the extension's options and paste the pairing code.

The extension's door is **not** the app's API: it has its own port and its own secret, accepts calls only from browser extensions (a web page cannot call it even with the secret), and only accepts meeting signals. *New code* in Settings cuts off every extension paired with the old one.

### A look at the window (last resort)

If neither of the above is connected, and you switched it on, WhisperBrain takes a picture of the meeting window every couple of seconds and asks your AI model (Settings → AI) who is speaking. The picture goes where your LLM setting points, so use a model that runs on this computer and can see pictures. It runs only while a recording does, and skips pictures that did not change. macOS asks for the Screen Recording permission.

## When names do not appear

**The selectors are not verified against a real call.** The built-in description of the Meet page (`src/meet/selectors/meet.json`, and `extension/meet/selectors.js` for the extension) was written from how Chromium exposes pages, measured on a mock page, and from what is known about Meet. Meet changes its page, so the first thing to check on a real call is whether they match.

1. Settings shows each source's state. *Needs setup* on Linux means the browser was not started with accessibility on; *Permission needed* on macOS means the Accessibility permission is missing.
2. During a real call run `npm run a11y:dump -- --redact` (Linux/macOS/Windows; add `--platform <id>` for a platform other than Google Meet). It prints the page's tree with every name and word replaced by its length, keeping the structure, and says what the current selectors find. **Read the file before sharing it.**
3. Put a corrected selectors file at `<data folder>/meet-selectors.json` (it wins over the built-in one) or paste corrected extension selectors in the extension's options (for a platform other than Google Meet the file is `<platform>-selectors.json`). Selector format: `src/meet/a11y.js`.

## Checklist for a real machine

Everything above was exercised on Linux with a mock Meet page and a real Chromium-based browser. These have **not** been run and need a person on the right system:

- [ ] **A real Google Meet call**, any system: the extension reads the people and the highlight; the accessibility tree has names and the speaking state (the spike: capture with `npm run a11y:dump`); live captions are readable.
- [ ] **macOS**: `npm run build:ax` builds; the Accessibility prompt is never raised by a recording (the watching helper restarts with each one); press the permission button or add the helper by hand and, once allowed, snapshots flow without restarting the app; a Meet call is detected from the browser window; Arc/Brave/Edge/Chrome.
- [ ] **Windows**: `powershell -File native/windows/whisperbrain-uia.ps1 -Mode selftest` compiles the C#; `-Mode dump` during a call shows the page's `Document` and its nodes; no console window appears from the app.
- [ ] **Wayland**: the *look at the window* source asks for the screen-sharing prompt of the desktop portal.
- [ ] **Firefox** is not supported by any source yet.

CI compiles the macOS helper and loads the Windows one on every push (`native` job in `.github/workflows/build.yml`), which catches syntax and build errors but not behaviour.

## Safety rules the code keeps

- A name you typed is never replaced. A voice matched to a saved person is never renamed by the call.
- A saved voice is only taught from the call when one name was highlighted for 10 seconds or more over the voice and held 85 % of everything highlighted, and when a saved voice of that name already exists it must sound alike (two people can share a first name).
- Merging voices requires that they do not sound clearly different (cosine ≥ 0.25 and pitch within 4 semitones) *and* never speak at the same time; a highlight alone never merges two voices.
- Two people speaking at once say nothing: the highlight is only used when exactly one person is shown.
- The other program's window is read only while a recording is on.
