// AudioWorklet: batches mono Float32 samples and posts them to the main thread (~256 ms at 16 kHz).
class PcmTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage({ samples: this.buf.slice(0), rate: sampleRate }); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
