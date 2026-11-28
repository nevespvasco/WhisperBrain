'use strict';
// Is a URL on our own UI's origin (scheme, host and port all equal)? A string prefix is not enough: it would also accept
// http://127.0.0.1:PORT@evil/ (a user name, the host is "evil") and port PORT1. Pure (no Electron), so it is unit-tested.
function sameOrigin(u, origin) {
  if (!origin) return false;
  try {
    const want = new URL(origin).origin;
    return want !== 'null' && new URL(String(u)).origin === want;
  } catch { return false; }
}

module.exports = { sameOrigin };
