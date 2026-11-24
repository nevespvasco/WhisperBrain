'use strict';
const zlib = require('node:zlib');

const MAX_TOTAL = 100 * 1024 * 1024; // uncompressed bytes we are willing to produce from one archive
const fail = (msg) => Object.assign(new Error(msg), { code: 'EZIP' });

// Minimal read-only ZIP: End Of Central Directory → central directory → local headers.
// Stored (0) and deflate (8) only; zip64, multi-disk and encrypted entries are refused.
function readZip(input, { maxTotal = MAX_TOTAL, maxEntries = 20000 } = {}) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw fail('not a ZIP archive (no central directory)');
  const disk = buf.readUInt16LE(eocd + 4), total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12), cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff || (eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50)) throw fail('ZIP64 archives are not supported');
  if (disk !== 0) throw fail('multi-part ZIP archives are not supported');
  if (total > maxEntries) throw fail('too many entries in the archive');
  if (cdOffset + cdSize > eocd) throw fail('corrupt archive (central directory out of range)');

  const entries = [];
  let p = cdOffset, declared = 0;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw fail('corrupt archive (bad central directory entry)');
    const flags = buf.readUInt16LE(p + 8), nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const e = {
      name: buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen),
      flags, method: buf.readUInt16LE(p + 10), crc: buf.readUInt32LE(p + 16),
      csize: buf.readUInt32LE(p + 20), usize: buf.readUInt32LE(p + 24), offset: buf.readUInt32LE(p + 42),
      encrypted: !!(flags & 1),
    };
    if (e.csize === 0xffffffff || e.usize === 0xffffffff || e.offset === 0xffffffff) throw fail('ZIP64 archives are not supported');
    declared += e.usize;
    if (declared > maxTotal) throw fail(`archive is too large when uncompressed (over ${Math.round(maxTotal / 1048576)} MB)`);
    entries.push(e);
    p += 46 + nameLen + extraLen + commentLen;
  }

  const byName = new Map(entries.map((e) => [e.name, e]));
  let produced = 0;
  function read(name) {
    const e = typeof name === 'string' ? byName.get(name) : name;
    if (!e) throw fail(`missing entry ${name}`);
    if (e.encrypted) throw fail('the archive is encrypted (password-protected)');
    if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) throw fail(`corrupt archive (bad local header for ${e.name})`);
    const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
    if (start + e.csize > buf.length) throw fail(`corrupt archive (${e.name} is truncated)`);
    const raw = buf.subarray(start, start + e.csize);
    const room = maxTotal - produced;
    let data;
    if (e.method === 0) data = raw;
    else if (e.method === 8) {
      // never inflate past the declared size or the remaining budget: a lying header is how zip bombs work
      try { data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, Math.min(e.usize, room)) }); }
      catch (err) {
        if (err.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) throw fail(`${e.name} inflates beyond its declared size (possible zip bomb)`);
        throw fail(`corrupt archive (${e.name} cannot be decompressed)`);
      }
    } else throw fail(`unsupported compression method ${e.method} for ${e.name}`);
    if (data.length !== e.usize) throw fail(`corrupt archive (${e.name} has the wrong size)`);
    if (data.length > room) throw fail(`archive is too large when uncompressed (over ${Math.round(maxTotal / 1048576)} MB)`);
    if (typeof zlib.crc32 === 'function' && (zlib.crc32(data) >>> 0) !== e.crc) throw fail(`corrupt archive (checksum mismatch in ${e.name})`);
    produced += data.length;
    return data;
  }

  return { entries, has: (name) => byName.has(name), read };
}

module.exports = { readZip, MAX_TOTAL };
