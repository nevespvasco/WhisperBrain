'use strict';
// The release pipeline feeds the auto-updater of every Windows and AppImage install, so its gates are checked here as text
// (the workflows only run on GitHub). See the comment at the top of .github/workflows/release.yml.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./helpers');

const read = (f) => fs.readFileSync(path.join(ROOT, '.github', f), 'utf8');
const WORKFLOWS = fs.readdirSync(path.join(ROOT, '.github', 'workflows')).filter((f) => f.endsWith('.yml')).map((f) => `workflows/${f}`);
// the text of each job (two-space-indented keys under jobs:)
function jobs(text) {
  const body = text.slice(text.indexOf('\njobs:\n') + 7);
  const out = {};
  let name = null;
  for (const line of body.split('\n')) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) { name = m[1]; out[name] = ''; } else if (name) out[name] += line + '\n';
  }
  return out;
}
const release = read('workflows/release.yml');
const rj = jobs(release);

test('every workflow: read-only token by default, checkouts without a stored token, actions pinned by commit', () => {
  for (const f of WORKFLOWS) {
    const text = read(f);
    assert.match(text, /^permissions:\n {2}contents: read$/m, `${f}: top-level permissions: contents: read`);
    const checkouts = text.split('\n').map((l, i) => [l, i]).filter(([l]) => /uses: actions\/checkout@/.test(l));
    assert.ok(checkouts.length, `${f} checks out the code`);
    const lines = text.split('\n');
    for (const [, i] of checkouts) assert.match(lines.slice(i, i + 3).join('\n'), /persist-credentials: false/, `${f}:${i + 1} persist-credentials: false`);
    for (const m of text.matchAll(/uses: ([^\s#]+)/g)) {
      if (m[1].startsWith('./')) continue;
      assert.match(m[1], /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${f}: ${m[1]} must be pinned by a full commit SHA`);
    }
  }
});

test('release: only the publish job can write, and it needs the tag check and the tests', () => {
  assert.equal((release.match(/contents: write/g) || []).length, 1);
  assert.match(rj.publish, /permissions:\n\s+contents: write/);
  assert.match(rj.publish, /needs: \[check, test, build\]/);
  assert.match(rj.publish, /needs\.check\.result == 'success' && needs\.test\.result == 'success'/);
});

test('release: the tests run on the tagged commit before any installer is built', () => {
  assert.match(rj.test, /uses: \.\/\.github\/workflows\/build\.yml/);
  assert.match(rj.test, /tests_only: true/);
  assert.match(rj.test, /ref: \$\{\{ needs\.check\.outputs\.ref \}\}/);
  assert.match(rj.build, /needs: \[check, test\]/);
  assert.match(rj.build, /ref: '\$\{\{ needs\.check\.outputs\.ref \}\}'/, 'a run by hand builds the tag, not the branch it was started from');
  const build = read('workflows/build.yml');
  assert.match(build, /workflow_call:\n\s+inputs:/);
  for (const job of ['native', 'dist']) assert.match(jobs(build)[job], /if: \$\{\{ !inputs\.tests_only \}\}/, `build.yml ${job} is skipped for the release's test run`);
});

test('release: the tag must be a version tag equal to package.json', () => {
  assert.match(rj.check, /TAG: \$\{\{ inputs\.tag \|\| github\.ref_name \}\}/);
  assert.match(rj.check, /require\('\.\/package\.json'\)\.version/);
  assert.match(rj.check, /does not match package\.json/);
});

test('release: a published release is never overwritten; a partial build stays a draft', () => {
  const run = rj.publish;
  assert.match(run, /already published/);
  const clobber = run.indexOf('--clobber');
  assert.ok(clobber > run.indexOf('if [ "$STATE" != "true" ]; then') && run.indexOf('if [ "$STATE" != "true" ]; then') > 0, '--clobber only after the draft check');
  assert.match(run, /gh release create "\$TAG" out\/\* --draft --verify-tag/);
  assert.match(run, /ALL_BUILT: \$\{\{ needs\.build\.result == 'success' \}\}/);
  assert.match(run, /if \[ "\$ALL_BUILT" = "true" \]; then\n\s+gh release edit "\$TAG" --draft=false/);
  assert.match(run, /SHA256SUMS\.txt/);
});

test('release: the installers still pass the smoke test before they are uploaded', () => {
  for (const os of ['Linux', 'macOS', 'Windows']) assert.match(rj.build, new RegExp(`if: runner\\.os == '${os}'[\\s\\S]*?SMOKE_OK`), os);
});

test('dependabot watches npm and the pinned actions', () => {
  const d = read('dependabot.yml');
  assert.match(d, /package-ecosystem: npm/);
  assert.match(d, /package-ecosystem: github-actions/);
  assert.match(d, /'electron', 'electron-builder'/);
});
