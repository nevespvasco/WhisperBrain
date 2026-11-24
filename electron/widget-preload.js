'use strict';
// The only things the floating recorder page may ask of the main process. Everything else goes through the app's
// own HTTP API, exactly like the main window.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wbWidget', {
  setExpanded: (expanded) => ipcRenderer.send('widget:expanded', !!expanded),
  move: (dx, dy) => ipcRenderer.send('widget:move', Math.round(Number(dx) || 0), Math.round(Number(dy) || 0)),
  openApp: (noteId) => ipcRenderer.send('widget:open', String(noteId || '')),
});
