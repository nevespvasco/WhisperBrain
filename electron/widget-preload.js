'use strict';
// The only things the floating recorder page may ask of the main process. Everything else goes through the app's
// own HTTP API, exactly like the main window.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wbWidget', {
  setExpanded: (expanded) => ipcRenderer.send('widget:expanded', !!expanded),
  // A drag is the window's start position plus the pointer's total offset since the press: never a stream of deltas.
  dragStart: () => ipcRenderer.send('widget:drag-start'),
  dragMove: (dx, dy) => ipcRenderer.send('widget:drag-move', Math.round(Number(dx) || 0), Math.round(Number(dy) || 0)),
  dragEnd: () => ipcRenderer.send('widget:drag-end'),
  openApp: (noteId) => ipcRenderer.send('widget:open', String(noteId || '')),
  // The window is not focusable, so the page's own clipboard API refuses to write: the main process does it.
  copyText: (text) => ipcRenderer.invoke('widget:copy', String(text || '')),
});
