# Tests

```bash
npm test
```

About 1,200 tests (`node:test`), including integration tests that use real models and devices:

- real ASR, multilingual ASR and speaker identification on real voices
- a recording through the HTTP API
- PipeWire system-audio capture through a private null sink (nothing audible)
- PipeWire echo cancellation looped back inside a private null sink (no microphone is opened), and a check that the helper dies with the app
- the X11 paste path inside Xvfb
- a real Chromium-based browser showing a mock Meet page, read by the real AT-SPI helper and, separately, by the real browser extension, into the real intake server; and the extension's own reader and selectors run in a real browser over simulated Teams, Zoom and Discord pages (`test/fixtures/pages`, `test/support/read-pages.js`; those pages are simulated from what the selectors expect, not recorded from the real sites) (skipped without Xvfb, D-Bus or a non-snap browser; `WB_SKIP_BROWSER=1` skips them)
- booting the Electron app from the source tree headless (`test/electron-smoke.test.js`); the packaged installers are smoke-tested
  on CI instead (`.github/workflows/build.yml` and `release.yml`: the built app starts, serves its UI, opens its windows and, on
  Linux and macOS, runs its speech worker)
- the knowledge layer, imports of every supported format, exports, Notion/Linear/Google against fake servers, Obsidian against a temporary vault, signed webhooks

Tests that need a model or a device skip themselves when it is missing. `node scripts/fetch-models.js` fetches the test models into `./.models`.

## What skips, and where it runs

| Needs | Tests | Locally | CI (`build.yml`) |
|---|---|---|---|
| `parakeet-tdt-110m-en` + VAD + voice and segmentation models | ASR, recording through the API | `npm run models` | yes (cached) |
| `parakeet-tdt-0.6b-v3` (its `test_wavs` are the sample voices) | multilingual ASR, owned diarization, overlap, real-voice speakers, two-voice import | `npm run models -- parakeet-tdt-0.6b-v3` | yes (cached) |
| the CAM++ model in `.models/candidates` | dual voice prints (`owned-live.test.js`) | copy it there by hand | skipped |
| PipeWire | live capture, echo cancellation | a desktop session | skipped (no PipeWire on the runner) |
| Xvfb, D-Bus, a non-snap Chromium browser | live Meet/extension tests | `WB_BROWSER_BIN=...` | yes (Chrome for Testing) |

The speaker-attribution evaluation (`eval/`, WDER/cpWER on libri-call) runs every night in `.github/workflows/nightly.yml`; its
report is an artifact of that run (no pass/fail thresholds yet).

## Hygiene

- Temporary folders: use `tmpDir(prefix, t)` from `test/helpers.js`. It is removed when the test `t` ends and in any case when
  the test file's process exits; `WB_KEEP_TMP=1` keeps them for a look after a failure.
- The built-in Google/Microsoft OAuth clients are empty under `node --test` (it sets `NODE_TEST_CONTEXT`), so a local
  `src/core/oauth-clients.local.json` or `WB_*_CLIENT_*` variable cannot change a result; a test that needs one passes `builtIn`.
- `npm run lint`: undefined names fail, unused variables warn (ESLint through npx, no devDependency).
