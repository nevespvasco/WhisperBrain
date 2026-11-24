'use strict';
// Admin policy: a read-only JSON file an organisation puts on a computer to fix some of WhisperBrain's settings. Nothing here
// writes to it, and a person cannot change what it fixes. Where it is looked for:
//   Linux    /etc/whisperbrain/policy.json
//   macOS    /Library/Application Support/WhisperBrain/policy.json
//   Windows  %ProgramData%\WhisperBrain\policy.json
// (WB_POLICY_FILE names another file, for testing). Shape:
//   { "lock": { "voiceprints": false, "meet.learnVoices": false, "retentionDays": 90 }, "requireLocalLlm": true }
// lock: setting -> the value it has, always. "section.field" reaches inside a settings group. requireLocalLlm: the AI server must
// be this computer or on the local network. A file that cannot be read locks nothing and says why (`problems`).
const fs = require('node:fs');
const path = require('node:path');

function policyFiles({ platform = process.platform, env = process.env } = {}) {
  if (env.WB_POLICY_FILE) return [env.WB_POLICY_FILE];
  if (platform === 'win32') return [path.win32.join(env.ProgramData || 'C:\\ProgramData', 'WhisperBrain', 'policy.json')];
  if (platform === 'darwin') return ['/Library/Application Support/WhisperBrain/policy.json'];
  return ['/etc/whisperbrain/policy.json'];
}

// the setting a lock path names, if there is one: its default value tells the type
function defaultAt(pathStr) {
  const { DEFAULTS } = require('./settings');   // settings.js uses this file too: required when needed, not at load
  const [a, b, ...rest] = pathStr.split('.');
  if (rest.length || !(a in DEFAULTS)) return undefined;
  if (b === undefined) return DEFAULTS[a];
  const d = DEFAULTS[a];
  return d && typeof d === 'object' && !Array.isArray(d) && b in d ? d[b] : undefined;
}

// -> { locked: { path: value }, requireLocalLlm, file, problems: [text] }
function loadPolicy({ files = policyFiles(), read = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const out = { locked: {}, requireLocalLlm: false, file: null, problems: [] };
  for (const file of files) {
    let text;
    try { text = read(file); } catch (e) { if (e.code === 'ENOENT') continue; out.file = file; out.problems.push(`${file} could not be read: ${e.message}`); return out; }
    out.file = file;
    let json;
    try { json = JSON.parse(text); } catch (e) { out.problems.push(`${file} could not be read: ${e.message}`); return out; }
    for (const [key, value] of Object.entries(json?.lock || {})) {
      const d = defaultAt(key);
      if (d === undefined) out.problems.push(`${file}: "${key}" is not a setting`);
      else if (typeof d !== typeof value) out.problems.push(`${file}: "${key}" must be a ${typeof d}`);
      else out.locked[key] = value;
    }
    out.requireLocalLlm = json?.requireLocalLlm === true;
    return out;
  }
  return out;
}

// this computer or the local network: loopback, private addresses, and names ending .local / .lan
function isLocalUrl(url) {
  if (!String(url || '').trim()) return true;           // no server set: nothing leaves
  let host;
  try { host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return false; }
  if (host === 'localhost' || host === '::1' || host.endsWith('.local') || host.endsWith('.lan')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

module.exports = { loadPolicy, policyFiles, isLocalUrl };
