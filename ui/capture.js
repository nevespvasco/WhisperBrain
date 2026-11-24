// Renderer-side audio capture, used where the OS adapter cannot capture natively (macOS, Windows):
//   mic    -> getUserMedia
//   system -> getDisplayMedia; the Electron main process answers it with "loopback" audio
//             (ScreenCaptureKit on macOS 13+, WASAPI loopback on Windows)
// Audio is resampled to 16 kHz mono s16le and POSTed to the local server in ~256 ms chunks.
const sessions = new Map(); // key -> { stop }

function floatToPcm16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) { const s = Math.max(-1, Math.min(1, f32[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
  return out;
}
function resample(input, from, to = 16000) {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio, i0 = Math.floor(pos), frac = pos - i0;
    out[i] = input[i0] + ((input[Math.min(i0 + 1, input.length - 1)] - input[i0]) * frac);
  }
  return out;
}

async function openStream(kind, deviceId) {
  if (kind === 'mic') {
    return navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  }
  const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  s.getVideoTracks().forEach((t) => t.stop());
  if (!s.getAudioTracks().length) throw new Error('No system audio was shared');
  return new MediaStream(s.getAudioTracks());
}

export async function startCapture({ key, kind, url, deviceId, onError }) {
  if (sessions.has(key)) return;
  const stream = await openStream(kind, deviceId);
  const ctx = new AudioContext({ sampleRate: 16000 });
  await ctx.audioWorklet.addModule('/pcm-worklet.js');
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-tap');
  const mute = ctx.createGain(); mute.gain.value = 0; // keep the graph pulling without playing anything
  src.connect(node); node.connect(mute); mute.connect(ctx.destination);
  let queue = Promise.resolve();
  node.port.onmessage = (e) => {
    const pcm = floatToPcm16(resample(e.data.samples, e.data.rate));
    queue = queue.then(() => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pcm.buffer })).catch((err) => onError?.(err));
  };
  stream.getAudioTracks()[0].addEventListener('ended', () => stopCapture(key));
  sessions.set(key, { stop: () => { node.disconnect(); src.disconnect(); stream.getTracks().forEach((t) => t.stop()); ctx.close(); } });
}

export function stopCapture(key) {
  const s = sessions.get(key);
  if (s) { sessions.delete(key); try { s.stop(); } catch { /* already closed */ } }
}
export function stopAllCapture() { for (const k of [...sessions.keys()]) stopCapture(k); }
export const isCapturing = (key) => sessions.has(key);

export async function listMicrophones() {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach((t) => t.stop());
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter((d) => d.kind === 'audioinput').map((d) => ({ id: d.deviceId, name: d.label || d.deviceId, default: d.deviceId === 'default' }));
  } catch { return []; }
}
