# Architecture

```
electron/main.js        window, tray, notifications, global dictation shortcut, loopback capture handler, floating recorder window (electron/float.js, widget-preload.js; page in ui/widget.*)
src/server/app.js       composition root (no HTTP): stores + services + platform adapter
src/server/http.js      local HTTP API + SSE on 127.0.0.1 (random port, per-launch token cookie, Host/Origin checks, CSP)
src/core/               SQLite (node:sqlite, FTS5), notes, spaces, settings, templates, account
src/jobs/               durable background work: a jobs table (queue.js) and its runner with lanes; the steps after a recording
                        run here and resume after a quit (docs/adr/0001-brain-data-model.md)
src/items/              sources and items (one row per thing from any source, updated in place, tombstoned when gone); sensitivity rule
src/connectors/         folder / Obsidian vault reader (pointer mode: files stay the originals) and the manager that scans and watches
src/graph/              people as entities: identities (e-mail, voice, name), merge proposals, reversible merges, mentions
src/audit/              the AI-run ledger: every AI call, and whether it left this computer (never the text)
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
src/platform/           per-OS adapters (table below)
ui/                     the interface (vanilla ES modules, no build step): app shell, views/, ⌘K palette, i18n (en, pt);
                        navigation = four doors (Today, Ask, Library, Setup) in ui/nav.js, each page behind exactly one
```

## Platform adapters

Only three things differ per OS. Everything else is shared.

| | Linux | macOS | Windows |
|---|---|---|---|
| System audio | PipeWire: `pw-record` on the default output's monitor | Renderer `getDisplayMedia` + Electron loopback (ScreenCaptureKit, macOS 13+) | Renderer `getDisplayMedia` + Electron loopback (WASAPI loopback) |
| Microphone | `pw-record`, echo-cancelled by PipeWire when possible, see [echo cancellation](echo-cancellation.md) | Renderer `getUserMedia` (Chromium processing, see [echo cancellation](echo-cancellation.md)) | Renderer `getUserMedia` (Chromium processing, see [echo cancellation](echo-cancellation.md)) |
| Microphone in use | `pw-dump` input streams | `pmset -g assertions` (heuristic) | Capability Access Manager registry (`LastUsedTimeStop = 0`) |
| Dictation paste | `xclip` + XTest helper (X11), `wl-copy` + `wtype` (wlroots Wayland) | `osascript` keystroke (needs Accessibility) | `SendKeys` Ctrl+V |

**Honest status:** everything was developed and tested on Linux (X11, PipeWire). The macOS and Windows adapters are written and their parsers are unit-tested, and the Windows and macOS packages were assembled from Linux. They have not yet been run on a real Mac or Windows machine.
