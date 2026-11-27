'use strict';
// Release builds only: writes src/core/oauth-clients.local.json from CI secrets so the installers ship with "Sign in with Google"
// ready to use. The file is git-ignored and the secrets never appear in the repository or in the logs.
//   WB_GOOGLE_CLIENT_ID / WB_GOOGLE_CLIENT_SECRET   (GitHub → Settings → Secrets and variables → Actions)
// With no secrets set it writes nothing, and the build ships without a built-in client (people bring their own).
const fs = require('node:fs');
const path = require('node:path');

const id = String(process.env.WB_GOOGLE_CLIENT_ID || '').trim();
const secret = String(process.env.WB_GOOGLE_CLIENT_SECRET || '').trim();
if (!id) { console.log('oauth-clients: no WB_GOOGLE_CLIENT_ID, building without a built-in Google client'); process.exit(0); }

const file = path.join(__dirname, '..', 'src', 'core', 'oauth-clients.local.json');
fs.writeFileSync(file, `${JSON.stringify({ google: { clientId: id, clientSecret: secret } }, null, 2)}\n`, { mode: 0o600 });
console.log('oauth-clients: wrote the built-in Google client (values not shown)');
