// The call's tab as audio for the WhisperBrain app: 16 kHz, 16-bit, mono, in chunks of about half a second. Pure (no browser APIs), so
// it can be tested outside a browser; the offscreen document feeds it what the tab's audio graph produces.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.WbTabAudio = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const OUT_RATE = 16000;

  // Float32 samples at inRate (what a Web Audio graph gives, one or more channels mixed to mono by the caller) -> Int16 at 16 kHz.
  // A box filter over the input samples of each output sample: enough to keep speech clean for recognition.
  class Downsampler {
    constructor({ inRate, chunkMs = 500, onChunk }) {
      this.step = inRate / OUT_RATE;       // input samples per output sample (3 for 48 kHz)
      this.size = Math.round((OUT_RATE * chunkMs) / 1000);
      this.onChunk = onChunk;
      this.pos = 0;                         // where the next output sample starts, in input samples, counted from the start of this block
      this.acc = 0; this.n = 0;             // the sum and count of the output sample being made
      this.out = new Int16Array(this.size); this.filled = 0;
    }

    push(block) {
      for (let i = 0; i < block.length; i++) {
        this.acc += block[i]; this.n++; this.pos++;
        if (this.pos >= this.step) {
          this.pos -= this.step;
          const v = Math.max(-1, Math.min(1, this.acc / this.n));
          this.out[this.filled++] = Math.round(v < 0 ? v * 32768 : v * 32767);
          this.acc = 0; this.n = 0;
          if (this.filled === this.size) {
            this.onChunk(new Uint8Array(this.out.buffer.slice(0)));
            this.filled = 0;
          }
        }
      }
    }
  }

  return { Downsampler, OUT_RATE };
});
