'use strict';
// Where secrets (API keys, tokens, webhook secrets) are kept at rest. Settings holds plaintext only in memory and asks a
// SecretBox to seal what it writes to the database, so a copied or backed-up database does not carry the keys with it.
//
// A box says how much protection it gives:
//   strong    the operating system's keystore (Keychain, DPAPI, libsecret / KWallet), tied to the logged-in user
//   fallback  a key file next to the data (server mode without a keystore): keeps secrets out of a copied database,
//             nothing more. Always shown as a warning.
//   weak      a keystore that is not one (Linux "basic_text": a fixed password): sealing would only look like protection,
//             so Settings asks the person what to do instead of sealing
//   none      no encryption available at all
const fs = require('node:fs');
const crypto = require('node:crypto');

const PREFIX = 'wbs1:';

class SecretBox {
  // encrypt(text) -> Buffer and decrypt(Buffer) -> text, both may be async
  constructor({ kind, strength, encrypt, decrypt }) { Object.assign(this, { kind, strength }); this.encrypt = encrypt; this.decrypt = decrypt; }
  static isSealed(v) { return typeof v === 'string' && v.startsWith(PREFIX); }
  async seal(text) { return PREFIX + Buffer.from(await this.encrypt(String(text))).toString('base64'); }
  async open(sealed) {
    if (!SecretBox.isSealed(sealed)) throw new Error('not a sealed value');
    return this.decrypt(Buffer.from(sealed.slice(PREFIX.length), 'base64'));
  }
}

// Electron's safeStorage (async calls: the synchronous ones are on their way out). `platform` is injectable for tests.
function electronSecretBox(safeStorage, platform = process.platform) {
  let strength = 'strong', kind = 'os';
  if (!safeStorage.isEncryptionAvailable()) { strength = 'none'; kind = 'unavailable'; }
  else if (platform === 'linux') {
    const backend = typeof safeStorage.getSelectedStorageBackend === 'function' ? safeStorage.getSelectedStorageBackend() : 'unknown';
    kind = backend;
    if (backend === 'basic_text' || backend === 'unknown') strength = 'weak';
  }
  return new SecretBox({
    kind, strength,
    encrypt: (text) => safeStorage.encryptStringAsync(text),
    decrypt: async (buf) => (await safeStorage.decryptStringAsync(buf)).result,
  });
}

// AES-256-GCM with a random key kept in a file only the user can read. For the headless server.
function fileSecretBox(keyFile) {
  let key = null;
  const load = () => {
    if (key) return key;
    try { key = fs.readFileSync(keyFile); } catch {
      key = crypto.randomBytes(32);
      fs.writeFileSync(keyFile, key, { mode: 0o600 });
    }
    if (key.length !== 32) throw new Error(`${keyFile} is not a valid key file`);
    return key;
  };
  return new SecretBox({
    kind: 'file', strength: 'fallback',
    encrypt: (text) => {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', load(), iv);
      const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]);
    },
    decrypt: (buf) => {
      const d = crypto.createDecipheriv('aes-256-gcm', load(), buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
    },
  });
}

module.exports = { SecretBox, electronSecretBox, fileSecretBox, PREFIX };
