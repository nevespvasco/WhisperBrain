'use strict';
// A tiny typed event bus. The server fans events out to the UI over SSE.
const { EventEmitter } = require('node:events');

class Bus extends EventEmitter {
  // live: the notes being recorded right now, noteId -> the order their voices were numbered in (the recording manager keeps it);
  // what is shown of who spoke depends on it, see speakers/display.js
  constructor() { super(); this.setMaxListeners(100); this.live = new Map(); }
  publish(type, data = {}) { this.emit('event', { type, data, at: Date.now() }); }
  subscribe(fn) { this.on('event', fn); return () => this.off('event', fn); }
}

module.exports = { Bus };
