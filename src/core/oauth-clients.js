'use strict';
// The OAuth "client" WhisperBrain itself is registered as with each provider, so a person only presses "Sign in" and approves.
//
// These are PUBLIC identifiers in the sense that matter: a desktop app cannot keep a secret (Google's own docs say the "client
// secret" of a Desktop-app client is not confidential, and the flow is protected by PKCE plus a loopback redirect instead). They
// are the same for everybody who runs the app. They are still kept OUT of the public repository (GitHub's secret scanning flags
// a Google client secret and Google may disable it), and put in the build instead:
//   1. src/core/oauth-clients.local.json (git-ignored; it is inside src/, so the packaged app carries it):
//        { "google": { "clientId": "123-abc.apps.googleusercontent.com", "clientSecret": "<the client secret from Google Cloud>" } }
//      Make it yourself for a local run; a release build writes it from CI secrets before packaging.
//   2. or the environment, which wins: WB_GOOGLE_CLIENT_ID / WB_GOOGLE_CLIENT_SECRET.
// While no client is shipped the Integrations page asks the person for their own, as before.
//
// Registering once (Google): console.cloud.google.com → new project → enable "Google Calendar API" and "Gmail API" →
// OAuth consent screen (External; add the scopes calendar.readonly and gmail.readonly) → Credentials → OAuth client ID →
// "Desktop app". An app left in "Testing" makes refresh tokens expire after 7 days; publish it ("In production") so they
// do not. Without Google's verification the person sees an "unverified app" warning and the app is capped at 100 users;
// calendar.readonly needs a verification review and gmail.readonly a security assessment before that cap is lifted.
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, 'oauth-clients.local.json');

function fromFile(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
}

// The client for a provider: { clientId, clientSecret } (both '' when WhisperBrain ships none). Read when the app starts, so a
// file or variable added while developing needs only a restart, not a rebuild. `file` and `env` are for tests.
// Under `node --test` (which sets NODE_TEST_CONTEXT) the defaults give none, so a developer's local file or variables never change
// what a test sees; a test that needs a shipped client passes `builtIn`, or `file`/`env` here.
function builtInClient(provider, { file = FILE, env = process.env } = {}) {
  if (file === FILE && env === process.env && process.env.NODE_TEST_CONTEXT) return { clientId: '', clientSecret: '' };
  const fileClient = fromFile(file)[provider] || {};
  const prefix = `WB_${provider.toUpperCase()}_CLIENT_`;
  return {
    clientId: String(env[`${prefix}ID`] || fileClient.clientId || '').trim(),
    clientSecret: String(env[`${prefix}SECRET`] || fileClient.clientSecret || '').trim(),
  };
}

module.exports = { builtInClient };
