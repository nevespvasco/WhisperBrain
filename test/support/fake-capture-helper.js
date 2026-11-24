'use strict';
// Plays the part of whisperbrain-tap / whisperbrain-loopback.exe for the tests: same command line, same stdout protocol
// (raw s16le, 16 kHz, mono). "--pid 666" and "--exe broken.exe" stand for an application the helper cannot follow.
const mode = process.argv[2];
const args = process.argv.slice(3);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
if (mode === 'probe') { console.log(JSON.stringify({ processTap: true, perProcess: true, voiceProcessing: false })); process.exit(0); }
if (mode === 'system' || mode === 'mic') {
  if (flag('--pid') === '666' || flag('--exe') === 'broken.exe') { console.error('cannot follow that process'); process.exit(2); }
  const hz = flag('--pid') || flag('--exe') ? 440 : 1000;          // which route answered is audible in the samples
  const n = 8000, buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * i / 16000) * 12000), i * 2);
  process.stdout.write(buf);
  setInterval(() => {}, 1000);                                      // a real helper streams until it is stopped
  process.on('SIGTERM', () => process.exit(0));
} else { console.error(`unknown mode ${mode}`); process.exit(64); }
