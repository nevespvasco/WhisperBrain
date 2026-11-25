#!/usr/bin/env node
'use strict';
// Renders the app icon (teal rounded square with a waveform) to PNG without any image library.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const r = size * 0.22;
  const bars = [[0.18, 0.12], [0.30, 0.30], [0.50, 0.50], [0.70, 0.30], [0.82, 0.12]].map(([cx, h]) => ({ cx: cx * size, half: h * size * 0.5, w: size * 0.055 }));
  const inRound = (x, y) => {
    const dx = Math.max(r - x, x - (size - r), 0), dy = Math.max(r - y, y - (size - r), 0);
    return dx * dx + dy * dy <= r * r;
  };
  const inBar = (x, y) => bars.some((b) => {
    const cy = size / 2;
    const dx = Math.abs(x - b.cx), dy = Math.abs(y - cy);
    if (dy > b.half) return false;
    if (dx <= b.w / 2) return true;
    return false;
  }) || bars.some((b) => { // rounded caps
    const cy = size / 2;
    for (const sy of [cy - b.half + b.w / 2, cy + b.half - b.w / 2]) if ((x - b.cx) ** 2 + (y - sy) ** 2 <= (b.w / 2) ** 2) return true;
    return false;
  });
  const N = 3;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let bg = 0, fg = 0;
    for (let sy = 0; sy < N; sy++) for (let sx = 0; sx < N; sx++) {
      const fx = x + (sx + 0.5) / N, fy = y + (sy + 0.5) / N;
      if (inRound(fx, fy)) { bg++; if (inBar(fx, fy)) fg++; }
    }
    const a = bg / (N * N), f = bg ? fg / bg : 0;
    const o = (y * size + x) * 4;
    px[o] = Math.round(0x1f * (1 - f) + 255 * f); px[o + 1] = Math.round(0x7a * (1 - f) + 255 * f); px[o + 2] = Math.round(0x6d * (1 - f) + 255 * f); px[o + 3] = Math.round(a * 255);
  }
  return px;
}

// macOS menu-bar icon: black waveform on transparent, so the system tints it for light/dark bars (needs the *Template name).
function renderTemplate(size) {
  const px = Buffer.alloc(size * size * 4);
  const bars = [[0.14, 0.34], [0.32, 0.62], [0.50, 0.90], [0.68, 0.62], [0.86, 0.34]].map(([cx, h]) => ({ cx: cx * size, half: h * size * 0.5, w: size * 0.12 }));
  const N = 4;
  const inBar = (x, y) => bars.some((b) => {
    const dy = Math.abs(y - size / 2), dx = Math.abs(x - b.cx);
    if (dy <= b.half - b.w / 2) return dx <= b.w / 2;
    return dx * dx + (dy - (b.half - b.w / 2)) ** 2 <= (b.w / 2) ** 2;
  });
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let c = 0;
    for (let sy = 0; sy < N; sy++) for (let sx = 0; sx < N; sx++) if (inBar(x + (sx + 0.5) / N, y + (sy + 0.5) / N)) c++;
    px[(y * size + x) * 4 + 3] = Math.round((c / (N * N)) * 255);
  }
  return px;
}

function png(size, rgba) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const out = path.join(__dirname, '..', 'build');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.png'), png(512, render(512)));
fs.mkdirSync(path.join(__dirname, '..', 'resources'), { recursive: true });
// Panel icons are ~22 px on Linux/Windows and 16-18 pt on macOS: anything bigger is drawn oversized.
fs.writeFileSync(path.join(__dirname, '..', 'resources', 'tray.png'), png(22, render(22)));
fs.writeFileSync(path.join(__dirname, '..', 'resources', 'tray@2x.png'), png(44, render(44)));
fs.writeFileSync(path.join(__dirname, '..', 'resources', 'trayTemplate.png'), png(18, renderTemplate(18)));
fs.writeFileSync(path.join(__dirname, '..', 'resources', 'trayTemplate@2x.png'), png(36, renderTemplate(36)));
console.log('wrote build/icon.png, resources/tray.png (+@2x) and resources/trayTemplate.png (+@2x)');
