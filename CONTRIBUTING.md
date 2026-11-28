# Contributing

## Setup

```bash
nvm use            # Node 24 (.nvmrc); Electron 45 brings its own
npm ci
npm start          # the app, from the source tree
npm test           # about 1,200 tests (node:test)
npm run lint       # undefined names fail, unused variables warn
```

On Linux, `npm start` passes `--no-sandbox` to the development copy of Electron (it has no setuid sandbox helper); packaged
builds keep the sandbox (`docs/packaging.md` §3). The native helpers are built with `npm run build:x11` and
`npm run build:atspi` (Linux), `npm run build:ax` and `npm run build:tap` (macOS), `npm run build:loopback` (Windows).

## Models

Speech and speaker models are not in the repository. `npm run models` fetches the small English model plus the VAD, voice and
segmentation models into `./.models`; `npm run models -- parakeet-tdt-0.6b-v3` adds the multilingual model, whose sample
voices the speaker tests play. `npm run models -- --list` shows the catalog. `WB_MODELS_DIR` points the tests at another folder.

## Tests

- Run one file with `node --test --test-concurrency=1 test/<name>.test.js`.
- Tests that need a model, PipeWire, Xvfb or a browser skip themselves and say why; `docs/testing.md` has the table of what
  skips locally and on CI.
- Write a failing test first, then the fix. Use `tmpDir(prefix, t)` from `test/helpers.js` for temporary folders (they are
  removed afterwards), and pass fakes instead of touching the network: the built-in OAuth clients are empty under `node --test`.
- Speaker-attribution changes: also run `node eval/run.js` (see `eval/README.md`); CI runs it nightly on libri-call.

## Working in parallel (git worktrees)

Several changes at once are easiest in separate worktrees, one branch each:

```bash
git worktree add ../whisperbrain-my-fix -b my-fix main
cd ../whisperbrain-my-fix
ln -s ../whisperbrain/node_modules node_modules   # optional: share the install
ln -s ../whisperbrain/.models .models             # share the models (hundreds of MB)
```

A shared `node_modules` is read by every worktree: do not run `npm install` or `npm ci` in one that links it (use
`npm install --package-lock-only` to change the lockfile). Do not `git stash` in a checkout others are using.

## Commits and releases

- Plain-English headline that says what changed for the person using the app, a blank line, then a short why/what.
- Releases are made by pushing a `v<version>` tag that matches `package.json`; `.github/workflows/release.yml` tests that
  commit, builds every system and publishes (as a draft if any system failed).
