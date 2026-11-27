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

#### Teams, Zoom and Discord in the browser

The same extension reads **Microsoft Teams** (teams.microsoft.com for work or school, teams.live.com for personal), **Zoom's web client** (the "join from your browser" client, app.zoom.us/wc/...) and **Discord in the browser** (discord.com/channels/...), each one an entry of the platform registry and of `extension/meet/selectors.js`. In the extension's options each platform can be switched off, and its selectors corrected without a rebuild (the key is `selectors` for Google Meet, `selectors-<platform>` for the others).

| Platform | Roster | Who speaks | Captions with a name | Notes |
|---|---|---|---|---|
| Teams | the People panel; the tiles on the screen when it is closed | the speaking indicator on a tile | yes, when the person turns captions on | work and personal layouts |
| Zoom (web) | the participants panel; the tiles on the screen when it is closed | the frame Zoom outlines, gallery and speaker view | when the host enabled them | |
| Discord (web) | the people of the call view | the speaking mark on a tile | no | **only the call view**: the sidebar lists people of other channels and is never read. The Discord user id is read from each avatar's address, so the person is the same one as in RPC and in the bot (`discord:<id>`). Not heard while the Discord app is connected over RPC |

A roster made only of the visible tiles says so (`partial`): it names people but is never used as a head count. **None of the selectors for Teams, Zoom and Discord has been checked against a real call** (`verified: false`); they are tested against simulated pages that follow what the selectors expect (`test/fixtures/pages`, read by the real reader in a real browser). A selector that finds nothing gives "no names", never an error.

### A look at the window (last resort)

If neither of the above is connected, and you switched it on, WhisperBrain takes a picture of the meeting window every couple of seconds and asks your AI model (Settings → AI) who is speaking. The picture goes where your LLM setting points, so use a model that runs on this computer and can see pictures. It runs only while a recording does, and skips pictures that did not change. macOS asks for the Screen Recording permission.

## When names do not appear

**The selectors are not verified against a real call.** The built-in description of the Meet page (`src/meet/selectors/meet.json`, and `extension/meet/selectors.js` for the extension) was written from how Chromium exposes pages, measured on a mock page, and from what is known about Meet. Meet changes its page, so the first thing to check on a real call is whether they match.

1. Settings shows each source's state. *Needs setup* on Linux means the browser was not started with accessibility on; *Permission needed* on macOS means the Accessibility permission is missing.
2. During a real call run `npm run a11y:dump -- --redact` (Linux/macOS/Windows; add `--platform <id>` for a platform other than Google Meet). It prints the page's tree with every name and word replaced by its length, keeping the structure, and says what the current selectors find. **Read the file before sharing it.**
3. Put a corrected selectors file at `<data folder>/meet-selectors.json` (it wins over the built-in one) or paste corrected extension selectors in the extension's options (for a platform other than Google Meet the file is `<platform>-selectors.json`). Selector format: `src/meet/a11y.js`.

## Checklist for a real machine

Everything above was exercised on Linux with a mock Meet page and a real Chromium-based browser. These have **not** been run and need a person on the right system:

- [ ] **Real calls for Teams (work and personal account), Zoom web (gallery and speaker view, panel open and closed) and Discord web (a server channel and a DM)**: run `npm run a11y:dump`-style capture of the page (or open the extension's options and the browser's inspector) and correct `extension/meet/selectors.js`; then set `verified: true`.
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

## Recording only the call's browser tab (the "Them" channel)

For calls held in a browser tab, the extension can send **only that tab's audio** as the "Them" channel: other tabs, music, notifications and a second call in another app stay out. A browser is one process for all its tabs, which is why the computer's output (or one browser process) cannot do this.

1. Pair the extension (above), start a recording in WhisperBrain, open the call's tab.
2. Click the extension's button on that tab and press *Record only this tab's audio*. Chrome only allows capturing a tab after a user action, so it cannot be automatic.
3. The extension captures the tab in an offscreen document and **keeps playing it** (a captured tab is otherwise muted), and sends 16 kHz mono audio to the app over the paired loopback door (`POST /meet/audio`, refused unless paired and a recording is on).

In the app (`src/recording/manager.js`): the stream is the system channel for that recording instead of the computer's own capture. Mic and system stay separate channels end to end. Each chunk is stamped with when it ended (same computer, same clock), so it is padded with silence or trimmed to follow the recording's clock and the transcript, speaker turns and meeting signals stay in step. The echo checks read the same channel, so the tab stream is their far-end reference (a cleaner one). If the stream stops (tab closed, extension reloaded) the computer's own capture, which keeps running underneath, takes over **without losing a second** and the gap is marked (an evidence row `tab-gap` and a warning); when the tab streams again it goes back to it.

**Not verified:** the browser side (tabCapture, the offscreen document, playback) needs a person and a real browser and has not been run; it is checked by reading, by `node --check` and by the pure parts (`extension/meet/tabaudio.js`, tested). Everything from the door inwards is tested with a fake extension (`test/tab-audio.test.js`). Checklist: Linux with Chrome/Brave/Edge, then macOS and Windows; that the call stays audible; a second tab playing music is absent from the transcript; echo with speakers.

## The platform's own transcript, offered after a recording (Teams, Zoom, Google Meet)

Attaching a transcript file already names every voice from it (`src/meet/attach.js`). After a Teams, Zoom or Meet recording the note now also offers to **fetch** it from the platform (`src/transcripts/offer.js`):

- The call the meeting windows showed (platform and meeting code) is put on the note with its meeting link, because platforms are asked about a meeting by its link (Meet `meet.google.com/<code>`, Zoom `zoom.us/j/<id>`, personal Teams `teams.live.com/meet/<id>`; a work Teams meeting needs the link from the calendar event).
- The note shows *Get the transcript from Teams* (or Zoom / Meet) when that account is connected (Settings → Integrations) and the link is known; otherwise it says what is missing and offers the file drop. Settings → *Platform transcript*: offer it (default), fetch it automatically (after about 30 s, when connected and the link is known), or never.
- It is a durable job in its own lane (waiting for a platform never holds up the local jobs): **six tries over about 23 minutes** with a growing pause, because platforms publish the transcript minutes after the call. A refusal that waiting cannot change (policy, permission, sign-in, no names) ends it at once.
- Every way it can end has a reason in words, and the file drop is always offered: no cloud recording (Zoom needs a paid account, the host recording to the cloud and audio transcript switched on), transcription off, the organiser's policy blocks it, retention expired (Meet keeps transcripts 30 days), the transcript does not match the recording.

**Not verified:** the fetch code (`src/transcripts/providers.js`) was written from the vendors' documentation and has never talked to a real account; the flow around it is tested against simulated provider answers, including "not there yet" and then there. Real-account checklist: work Teams (Graph, organiser policy), Zoom with a cloud recording, Google Workspace Meet.
