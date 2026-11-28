// Is the AI server on this computer? The same rule as src/core/policy.js isThisComputer (the UI cannot load that CommonJS file;
// test/policy.test.js checks the two agree): localhost, 127.0.0.0/8 and ::1 only; no server set means nothing leaves. A server
// elsewhere on the local network is another computer.
export function isThisComputer(url) {
  if (!String(url || '').trim()) return true;
  let host;
  try { host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return false; }
  return host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}
