# Tests

```bash
npm test
```

Over 400 tests, including integration tests that use real models and devices:

- real ASR, multilingual ASR and speaker identification on real voices
- a recording through the HTTP API
- PipeWire system-audio capture through a private null sink (nothing audible)
- PipeWire echo cancellation looped back inside a private null sink (no microphone is opened), and a check that the helper dies with the app
- the X11 paste path inside Xvfb
- a real Chromium-based browser showing a mock Meet page, read by the real AT-SPI helper and, separately, by the real browser extension, into the real intake server; and the extension's own reader and selectors run in a real browser over simulated Teams, Zoom and Discord pages (`test/fixtures/pages`, `test/support/read-pages.js`; those pages are simulated from what the selectors expect, not recorded from the real sites) (skipped without Xvfb, D-Bus or a non-snap browser; `WB_SKIP_BROWSER=1` skips them)
- booting the Electron app (and the packaged AppImage contents) headless
- the knowledge layer, imports of every supported format, exports, Notion/Linear/Google against fake servers, Obsidian against a temporary vault, signed webhooks

Tests that need a model or a device skip themselves when it is missing. `node scripts/fetch-models.js` fetches the test models into `./.models`.
