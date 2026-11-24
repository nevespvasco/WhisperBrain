'use strict';
// A tiny typed event bus. The server fans events out to the UI over SSE.
const { EventEmitter } = require('node:events');

class Bus extends EventEmitter {
  constructor() { super(); this.setMaxListeners(100); }
  publish(type, data = {}) { this.emit('event', { type, data, at: Date.now() }); }
  subscribe(fn) { this.on('event', fn); return () => this.off('event', fn); }
}

module.exports = { Bus };
