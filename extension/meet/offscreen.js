// Runs in the extension's offscreen document (a page with no window): it holds the captured tab's audio. The tab is muted while it is
// captured, so the same audio is played back here (the person still hears the call) and a copy goes to the WhisperBrain app,
// 16 kHz mono, over the paired loopback door. Chrome lets a tab be captured only after the person pressed the extension's button.
let ctx = null, stream = null, node = null, sending = 0;

async function start({ streamId, base, token }) {
  await stop();
  stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }, video: false });
  ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  src.connect(ctx.destination);                       // keep playing it: a captured tab is otherwise silent
  const down = new self.WbTabAudio.Downsampler({
    inRate: ctx.sampleRate,
    onChunk: (bytes) => {
      if (sending > 6) return;                          // the app is not keeping up: drop, never queue for ever
      sending++;
      fetch(base + '/meet/audio', { method: 'POST', headers: { 'x-wb-signal-token': token, 'x-wb-end': String(Date.now()), 'Content-Type': 'application/octet-stream' }, body: bytes })
        .then((r) => { if (r.status === 409 || r.status === 401) chrome.runtime.sendMessage({ type: 'tab-audio-refused', status: r.status }); })
        .catch(() => {})
        .finally(() => { sending--; });
    },
  });
  node = ctx.createScriptProcessor(4096, 2, 1);        // simple and enough here; mixes the channels to mono below
  node.onaudioprocess = (e) => {
    const l = e.inputBuffer.getChannelData(0), r = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : l;
    const mono = new Float32Array(l.length);
    for (let i = 0; i < l.length; i++) mono[i] = (l[i] + r[i]) / 2;
    down.push(mono);
  };
  src.connect(node);
  node.connect(ctx.destination);                        // a processor that is not connected is not run; it writes nothing
  stream.getAudioTracks()[0].addEventListener('ended', () => chrome.runtime.sendMessage({ type: 'tab-audio-ended' }));
}

async function stop() {
  try { node && node.disconnect(); } catch (e) { /* gone */ }
  try { stream && stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* gone */ }
  try { ctx && (await ctx.close()); } catch (e) { /* gone */ }
  ctx = stream = node = null;
}

chrome.runtime.onMessage.addListener((m, _s, reply) => {
  if (m && m.target === 'offscreen') {
    (m.type === 'start' ? start(m) : stop()).then(() => reply({ ok: true }), (e) => reply({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  return false;
});
