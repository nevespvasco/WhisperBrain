'use strict';
// The only things the teleprompter page may ask of the main process. Everything else (the suggestions, the microphone's
// transcript, the settings it saves) goes through the app's own HTTP API and its event stream, exactly like the main window.
const { contextBridge, ipcRenderer } = require('electron');

const num = (v) => Math.round(Number(v) || 0);

contextBridge.exposeInMainWorld('wbPrompter', {
  // Moving and resizing: the bounds at the press plus the pointer's total offset since (the window is frameless and not focusable).
  grab: () => ipcRenderer.send('prompter:grab'),
  drag: (dx, dy) => ipcRenderer.send('prompter:drag', num(dx), num(dy)),
  resize: (dx, dy) => ipcRenderer.send('prompter:resize', num(dx), num(dy)),
  release: () => ipcRenderer.send('prompter:release'),
  // Hide it until the recording ends (the show / hide shortcut brings it back).
  hide: () => ipcRenderer.send('prompter:hide'),
  // The global shortcuts: 'pause' | 'back' | 'next'.
  onCmd: (cb) => { ipcRenderer.on('prompter:cmd', (_e, action) => cb(String(action))); },
});
