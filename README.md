# WhisperBrain

A local-first AI notepad for meetings. Type your own notes, record the call (microphone plus system audio), get an on-device transcript that says **who** said what, then enhance the notes and chat with them using any LLM you choose (Ollama, or any OpenAI-compatible server).

Everything stays on your computer: audio is transcribed locally with [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), notes live in a local SQLite file, and the only text that leaves the machine goes to the LLM server you configure.

## Features

| | |
|---|---|
| Home | Start an online meeting (paste the link), an in-person one (microphone only) or upload one; recent meetings; today's calendar with per-meeting "record automatically" switches; open to-dos |
| Record | Mic ("Me") and system audio ("Them") as separate channels, live transcript, levels, pause/resume, echo removal |
| Who is talking | Voice prints per utterance, live clustering into *Speaker 1, 2…*, one-click naming with attendee suggestions, "remember this voice" across meetings, per-line reassignment |
| Speaker analytics | Talk time, words per minute, turns, questions, talk % / listen %, and a timeline of who spoke when |
| Recognise meetings | Notices Zoom, Teams, Meet (in a browser tab), Slack, Discord… using the microphone, reads meeting window titles on X11, matches the calendar event by time and meeting link. Then: ask, record automatically, or nothing; auto-stop when the call ends |
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
electron/main.js        window, tray, notifications, global dictation shortcut, loopback capture handler
src/server/app.js       composition root (no HTTP): stores + services + platform adapter
src/server/http.js      local HTTP API + SSE on 127.0.0.1 (random port, per-launch token cookie, Host/Origin checks, CSP)
src/core/               SQLite (node:sqlite, FTS5), notes, spaces, settings, templates, account
src/asr/                model catalog/installer, ASR worker process (VAD + recognizer + voice embeddings)
src/recording/          recording manager (channels, timeline, echo removal, speaker labels), audio import
src/speakers/           online voice clustering, cluster merging, voice profiles
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
| Microphone in use | `pw-dump` input streams | `pmset -g assertions` (heuristic) | Capability Access Manager registry (`LastUsedTimeStop = 0`) |
| Dictation paste | `xclip` + XTest helper (X11), `wl-copy` + `wtype` (wlroots Wayland) | `osascript` keystroke (needs Accessibility) | `SendKeys` Ctrl+V |

**Honest status:** everything was developed and tested on Linux (X11, PipeWire). The macOS and Windows adapters are written and their parsers are unit-tested, and the Windows and macOS packages were assembled from Linux. They have not yet been run on a real Mac or Windows machine.

## Tests

```bash
npm test
```

Over 150 tests, including integration tests that use real models and devices:

- real ASR, multilingual ASR and speaker identification on real voices
- a recording through the HTTP API
- PipeWire system-audio capture through a private null sink (nothing audible)
- the X11 paste path inside Xvfb
- booting the Electron app (and the packaged AppImage contents) headless
- the knowledge layer, imports of every supported format, exports, Notion/Linear/Google against fake servers, Obsidian against a temporary vault, signed webhooks

Tests that need a model or a device skip themselves when it is missing. `node scripts/fetch-models.js` fetches the test models into `./.models`.

## Privacy

- Audio is never stored; it is transcribed in memory.
- Voice prints are numeric embeddings kept in the local database. Only voices you choose to remember become profiles.
- The local server only listens on 127.0.0.1. It requires the per-launch token and refuses foreign `Host` and `Origin` headers.
- API keys are never sent to the UI or included in exports.

## Notes on provenance

WhisperBrain is an independent implementation. It contains no code, text, images or branding from any other meeting-notes product. The speech models are the public k2-fsa/sherpa-onnx releases (NVIDIA Parakeet, OpenAI Whisper, Silero VAD, WeSpeaker), under their own licences.

The two short audio clips in `test/fixtures/` are sample recordings shipped with the public k2-fsa/sherpa-onnx model releases (Apache-2.0), resampled to 16 kHz mono.
