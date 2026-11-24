# WhisperBrain

A local-first AI notepad for meetings. Type your own notes, record the call (microphone plus system audio), get an on-device transcript that says **who** said what, then enhance the notes and chat with them using any LLM you choose (Ollama, or any OpenAI-compatible server).

Everything stays on your computer: audio is transcribed locally with [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), notes live in a local SQLite file, and the only text that leaves the machine goes to the LLM server you configure.

## Features

| | |
|---|---|
| Home | Start an online meeting (paste the link), an in-person one (microphone only) or upload one; recent meetings; today's calendar with per-meeting "record automatically" switches; open to-dos |
| Record | Mic ("Me") and system audio ("Them") as separate channels, live transcript, levels, pause/resume, echo removal |
| Who is talking | Voice prints per utterance, live clustering into *Speaker 1, 2…*, one-click naming with attendee suggestions, "remember this voice" across meetings, per-line reassignment |
| Names from the call | On a Google Meet call, WhisperBrain reads who is on the call and who is speaking from the meeting window (the browser's accessibility tree, or a small browser extension, with a local vision model as a last resort) and puts the right name on each voice, uses the people on the call as the number of voices, joins and splits voices where the names say so, and remembers voices named beyond doubt. See [docs/meeting-names.md](docs/meeting-names.md) |
| Floating recorder | While recording and WhisperBrain is minimised, hidden or behind another window, a small always-on-top recording icon (pulsing dot, timer, level) floats in the corner. Click it to read the live transcript with names, pause or stop, or jump back to the note; drag it anywhere. Settings: when the app is in the background / always while recording / off |
| Speaker double-check | When you press Stop, the recording is analysed again for **pitch and timbre** (MFCC voice colour, brightness) on top of the voice model: misjudged utterances are re-assigned, two people the voice model merged are split, one person it cut in two is rejoined, and pitch is kept so a saved voice is never matched to a clearly different voice. It runs only after capture ends, so live transcription is never slowed down |
| Speaker analytics | Talk time, words per minute, turns, questions, talk % / listen %, and a timeline of who spoke when |
| Recognise meetings | Notices Zoom, Teams, Meet (in a browser tab), Slack, Discord… using the microphone, reads meeting window titles on X11, matches the calendar event by time and meeting link. Then: ask, record automatically, or nothing; auto-stop when the call ends |
| Discord bot | A bot in your Discord voice channel hears every person on their own audio stream (a computer only plays one mixed sound), so overlapping speech is kept and each line carries the person's Discord name. Handles Discord's end-to-end encrypted calls (DAVE). Falls back to the normal system audio when you are not in a call |
| Calendar | Google Calendar (OAuth sign-in, read-only) or any iCal feed / `.ics` file; week view; record all calendar meetings, only selected ones, or just remind |
| Summary | Templates enhance your own notes; structured overview, key-point cards, decisions, next steps; editable action items with owners and due dates |
| Topics | Topics are extracted per meeting (by your LLM, or offline with keyphrase extraction) and reuse existing names, so meetings connect. Interactive topic map, topic pages with a timeline, who said what, related topics, and an AI synthesis across meetings. Rename / merge / pin / hide |
| Glossary | Acronyms and jargon collected automatically (never overwriting your own definitions), underlined in transcripts with their definition, each with every place it was said |
| People | Everyone who spoke or was invited: their quotes, meetings, topics, talk time and the action items they own |
| Search | ⌘K palette over meetings, transcript lines (who said what), topics, people, glossary, tags and action items, with filter chips, sort, date range, grouped by day, keyboard-only |
| Organise | Spaces, coloured tags, pinning, bulk select (export, tag, move, delete), internal / external meetings from attendee domains, and a "From outside" view that keeps imported material apart from your own recordings |
| Import | Audio and video (transcribed on-device); VTT/SRT (Zoom, Teams, Meet), TXT (Otter-style and others), Markdown with frontmatter, JSON (WhisperBrain, Whisper, AssemblyAI, Deepgram), DOCX, HTML, CSV; pasted text; drag and drop anywhere; Notion pages, Obsidian notes and Linear issues |
| Export & share | Markdown, PDF, HTML, plain text, Obsidian Markdown (YAML + `[[links]]`), JSON, SRT, WebVTT; copy as rich text; email; print; bulk ZIP |
| Integrations | Notion (pages into a page or database), Obsidian (vault folder, updated in place), Linear (an issue with the summary, or one per action item, with assignee matching; link and import issues), signed webhooks (Zapier, Make, n8n, your server); optional auto-export after enhancing |
| Chat | Per meeting, or across all meetings with retrieval, glossary context and links to sources |
| Dictation | A global shortcut records, transcribes and pastes into the focused app |
| Account | Local account, data overview, backups, saved voices, danger zone |
| UI | Light and dark, English and Portuguese, responsive from phone width to wide desktop, collapsible sidebar, keyboard shortcuts |

### Connecting other tools

- **Google Calendar**: Integrations → Google Calendar. Either sign in (create a *Desktop app* OAuth client in Google Cloud with the Calendar API enabled; paste its client ID and secret) or paste the calendar's *secret address in iCal format*.
- **Notion**: create an internal integration at notion.so/my-integrations, share the target page or database with it, paste the secret, pick the page.
- **Linear**: Settings → Security & access → Personal API keys; paste the key and choose a team.
- **Discord**: [Developer Portal](https://discord.com/developers/applications) → New Application → Bot → Reset Token. Paste the token and your own user ID (Discord: Settings → Advanced → Developer Mode, then right-click your name → Copy User ID) in Integrations → Discord, press *Save & test* and open the invite link to add the bot to your server (needs View Channel and Connect; no privileged intents). While you are in a voice channel and record, the bot joins, listens to each person separately and leaves when you stop; your own voice stays on the microphone channel. Everyone in the call can see the bot, so tell them you are recording. The test joins your call for 8 seconds and reports who it heard and whether the call is end-to-end encrypted.
- **Obsidian**: point it at your vault folder. Notes go to `Meetings/` (configurable) with frontmatter and `[[wikilinks]]` to people and topics.
- **Webhooks**: each POST carries the meeting as JSON (including Markdown); with a secret it is signed in `X-WhisperBrain-Signature: sha256=<hmac>`.

All tokens stay in the local database and are never sent to the UI.

## Run

```bash
npm install
npm start
```

`npm start` opens the app. The first time, go to **Settings → Audio & transcription** and download a speech model. The voice model for speaker recognition (26 MB) is downloaded with it. Then go to **Settings → AI** and point it at an LLM server. For Ollama the defaults work; run `ollama pull llama3.2` and pick that model.

Without Electron (headless server; the UI opens in a browser):

```bash
node src/server/cli.js --port 3787
```

## Build installers

```bash
npm run dist:linux   # AppImage + .deb   (on Linux)
npm run dist:mac     # .dmg + .zip       (on macOS)
npm run dist:win     # NSIS + portable   (on Windows)
```

Each OS must build its own installer, because npm only installs the sherpa-onnx native package for the current platform. `.github/workflows/build.yml` builds all three in CI. Builds are unsigned until signing secrets are added.

## Architecture

```
electron/main.js        window, tray, notifications, global dictation shortcut, loopback capture handler, floating recorder window (electron/float.js, widget-preload.js; page in ui/widget.*)
src/server/app.js       composition root (no HTTP): stores + services + platform adapter
src/server/http.js      local HTTP API + SSE on 127.0.0.1 (random port, per-launch token cookie, Host/Origin checks, CSP)
src/core/               SQLite (node:sqlite, FTS5), notes, spaces, settings, templates, account
src/asr/                model catalog/installer, ASR worker process (VAD + recognizer + voice embeddings + optional streaming drafts)
src/recording/          recording manager (channels, timeline, echo removal, speaker labels), audio import
src/speakers/           online voice clustering, cluster merging, voice profiles, after-recording refinement (pitch + timbre, refine.js)
src/audio/features.js   acoustic voice features: pitch, MFCC timbre, brightness
src/llm/                OpenAI-compatible streaming client, prompts, map-reduce summary, retrieval for chat, structured insights
src/knowledge/          tags, action items, snippets, topics + correlation graph, glossary, people, analytics, unified search,
                        offline keyphrase topics, import orchestration, export renderers (Markdown/HTML/SRT/VTT/JSON)
src/importers/          file detection and parsers (VTT, SRT, TXT, Markdown, JSON, DOCX, HTML, CSV) + a small ZIP reader
src/integrations/       Notion, Linear, Obsidian, webhooks, and the service that sends meetings out / brings them in
src/meetings/           iCalendar parser (RRULE/TZ/overrides), Google Calendar (OAuth loopback + PKCE), meeting detector
src/dictation/          dictate → transcribe → paste
src/platform/           per-OS adapters (below)
ui/                     the interface (vanilla ES modules, no build step): app shell, views/, ⌘K palette, i18n (en, pt)
```

### Platform adapters

Only three things differ per OS. Everything else is shared.

| | Linux | macOS | Windows |
|---|---|---|---|
| System audio | PipeWire: `pw-record` on the default output's monitor | Renderer `getDisplayMedia` + Electron loopback (ScreenCaptureKit, macOS 13+) | Renderer `getDisplayMedia` + Electron loopback (WASAPI loopback) |
| Microphone | `pw-record`, echo-cancelled by PipeWire when possible (below) | Renderer `getUserMedia` (Chromium processing, see below) | Renderer `getUserMedia` (Chromium processing, see below) |
| Microphone in use | `pw-dump` input streams | `pmset -g assertions` (heuristic) | Capability Access Manager registry (`LastUsedTimeStop = 0`) |
| Dictation paste | `xclip` + XTest helper (X11), `wl-copy` + `wtype` (wlroots Wayland) | `osascript` keystroke (needs Accessibility) | `SendKeys` Ctrl+V |

**Honest status:** everything was developed and tested on Linux (X11, PipeWire). The macOS and Windows adapters are written and their parsers are unit-tested, and the Windows and macOS packages were assembled from Linux. They have not yet been run on a real Mac or Windows machine.

### Live draft captions

Final captions appear only after the speech model has decoded a whole utterance, which the voice-activity detector closes after 0.6 s of silence (or 30 s). Someone talking for 15 s used to see nothing for about 16 s. With the optional **Live draft captions** model (NVIDIA Nemotron-3.5 ASR streaming, 453 MB download, Settings → Audio & transcription) a second, streaming recognizer in the live worker writes draft words while people speak (first word after a median 0.7 s), shown dimmed in the transcript, the recording bar and the floating recorder. When the utterance ends, the final text from the main model replaces the draft. Everything else stays as it was:

- **Drafts are never saved, labelled by voice or clustered.** The server publishes them as `transcript.partial` events (`{noteId, ch, speaker, startMs, text}`; `text: ''` clears the line). Only final segments reach the database, the speaker clusterer and the after-recording speaker pass.
- **Echo:** a mic draft that repeats what the system channel just said (or is saying, as its own draft), or whose loudness follows the system audio's, is never shown, using the same two tests as the final segment.
- **Cost:** about 0.9 GB of extra memory while a recording runs, and CPU only while someone is speaking (about 0.6 cores per channel in continuous speech, 2 threads at most, on the live worker's one JS thread so it never competes with the final decode). The model loads when a recording starts, without restarting the worker, and is dropped when it ends.
- **Where it is off:** the setting *Show draft words while people speak* (`liveDraft`, on by default, a no-op until the model is installed); fewer than 4 physical cores; not enough free memory for another ~1 GB model; file imports and dictation never get drafts. A worker that cannot keep up (more than 90% of real time spent on drafts for 3 utterances in a row) switches drafts off for the rest of the recording and says so.
- **Measure it:** `node scripts/bench-live-draft.js [--channels 2]` streams test clips in real time and prints time to first word, the draft's distance from the final text, CPU and memory with drafts on and off.

### Echo cancellation

When the other side of a call plays through speakers, the microphone hears it too and that speech would be transcribed twice, the second time as "Me". Two layers deal with it:

1. **Cancel the echo before the speech model hears it** (setting *Cancel echo before transcribing*, on by default).
2. **Drop what is left after transcribing** (setting *Remove echo*): the old text match (token overlap within 2.5 s), plus a new loudness match. The mic segment's 10 ms loudness contour is compared with the system channel's, allowing the echo to arrive up to 0.8 s late. A segment is dropped only if the contours follow each other closely, with one sharp peak, while the system was speaking, with a steady level difference. Short clips need a closer match. This catches short or differently transcribed echoes the text match cannot. On synthetic echoes made from a real meeting recording it dropped 83% of 0.25–0.6 s echoes and 97–98% of longer ones; it wrongly dropped 0.2–0.4% of unrelated speech played over the system audio. When the user talks over a call and the echo is louder than their voice, some of their speech can still be dropped (up to about 20% of such overlaps in the same simulation).

**Linux (verified here).** PipeWire's `libpipewire-module-echo-cancel` (WebRTC AEC3) is loaded in a private helper process, `pipewire -c <generated config>`, for the length of a recording. In `monitor.mode` it takes the far-end reference from the default output's monitor, with no virtual sink and no change to the default devices, and offers a new source that `pw-record` then reads. The config lives in a temporary directory and is deleted afterwards. Nothing is written to `~/.config/pipewire` or any system config. The helper is stopped when the recording stops, and a small watchdog ends it within about a second if the app itself dies.

It is used only when `libpipewire-module-echo-cancel.so`, the `aec/libspa-aec-webrtc.so` plugin and the `pipewire` binary are present and the module supports monitor mode (PipeWire 0.3.x with monitor mode, 1.0.5 tested). Otherwise, or if the helper fails to start, the microphone is recorded raw as before and the text/loudness backstop does the work. If the helper dies mid-recording, or delivers no audio, the recording switches to the raw microphone and shows a warning. Settings → Audio shows whether it is available, and the recording bar shows when the microphone is echo-cancelled. `GET /api/state` has `capabilities.echoCancel` and `recording.echo`, which carries the live status and the number of segments each backstop dropped.

Noise suppression and automatic gain inside the AEC helper follow *Noise suppression* and *Automatic gain* (`auto` = off on Linux, so audio is as raw as before apart from the echo removal).

**macOS and Windows (not tested; no such machine was available).** The microphone comes from Chromium `getUserMedia`. `echoCancel`, `micNoiseSuppression` and `micAutoGain` map directly onto its `echoCancellation`, `noiseSuppression` and `autoGainControl` constraints. `auto` keeps the previous behaviour (all on), so nothing changes until someone decides otherwise. Published results suggest that enhancement such as noise suppression can *raise* word error rate for a modern ASR model, which is why the switches exist, but the default has not been changed without an A/B test.

What still needs testing on real machines:

- **Does Chromium's echo canceller remove a Zoom/Teams desktop client's audio?** Probably not. Chromium cancels echo against audio *Chromium itself plays* (its own render streams), and a call app playing through the OS output is invisible to it. Chromium's `echoCancellation` has a system-level mode on some platforms (macOS voice processing) that can see all output, but whether Electron 45 uses it for `getUserMedia`, and with which device, is unverified. Test: call a test number on speakers with the system channel on, then compare the mic transcript with *Cancel echo* on and off.
- If it does not cancel it, the planned fix is in-app AEC with the system channel as the far-end reference, for example `webrtc-audio-processing` in a native helper (report §5.7). Not implemented.
- A/B of noise suppression and gain on and off on the same recordings, measuring word error rate, before changing the `auto` default on these platforms.
- Whether the loudness backstop's thresholds hold on real speaker-to-mic paths. They were calibrated on synthetic echoes (delay, attenuation, noise floor, a small room response), not on real rooms, on this machine or any other.

## Tests

```bash
npm test
```

Over 400 tests, including integration tests that use real models and devices:

- real ASR, multilingual ASR and speaker identification on real voices
- a recording through the HTTP API
- PipeWire system-audio capture through a private null sink (nothing audible)
- PipeWire echo cancellation looped back inside a private null sink (no microphone is opened), and a check that the helper dies with the app
- the X11 paste path inside Xvfb
- a real Chromium-based browser showing a mock Meet page, read by the real AT-SPI helper and, separately, by the real browser extension, into the real intake server (skipped without Xvfb, D-Bus or a non-snap browser; `WB_SKIP_BROWSER=1` skips them)
- booting the Electron app (and the packaged AppImage contents) headless
- the knowledge layer, imports of every supported format, exports, Notion/Linear/Google against fake servers, Obsidian against a temporary vault, signed webhooks

Tests that need a model or a device skip themselves when it is missing. `node scripts/fetch-models.js` fetches the test models into `./.models`.

## Privacy

- Audio is never stored; it is transcribed in memory.
- While a recording runs, its raw audio is parked in a private temporary file (`<data>/spool`, user-only permissions) so the speaker double-check can listen again after Stop; the file is deleted as soon as that finishes, and any leftovers from a crash are removed at the next start. Turn it off with *Settings → Double-check speakers after recording*; nothing is then written.
- Voice prints are numeric embeddings kept in the local database. Only voices you choose to remember become profiles.
- Reading the meeting window (the accessibility readers, the browser extension, the optional look at the window) is local, runs only while a recording does, and the extension talks to a port of its own on 127.0.0.1 with its own secret and accepts calls from browser extensions only. Only the optional vision source sends a picture, to the LLM you configured.
- The local server only listens on 127.0.0.1. It requires the per-launch token and refuses foreign `Host` and `Origin` headers.
- API keys are never sent to the UI or included in exports.

## Notes on provenance

WhisperBrain is an independent implementation. It contains no code, text, images or branding from any other meeting-notes product. The speech models are the public k2-fsa/sherpa-onnx releases (NVIDIA Parakeet, OpenAI Whisper, Silero VAD, WeSpeaker), under their own licences.

The two short audio clips in `test/fixtures/` are sample recordings shipped with the public k2-fsa/sherpa-onnx model releases (Apache-2.0), resampled to 16 kHz mono.
