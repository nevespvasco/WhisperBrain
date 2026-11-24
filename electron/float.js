'use strict';
// Floating recorder: when it shows, how big it is, where it may sit. Pure (no Electron), so it is unit-tested.

const SIZE = {
  collapsed: { width: 212, height: 60 },   // includes the margin that holds the drop shadow
  expanded: { width: 380, height: 470 },
};
const MARGIN = 16;

// mode: 'off' | 'background' | 'always'. main: { minimized, visible, focused } of the app window, or null if it is gone.
// 'background' = whenever WhisperBrain is not what the user is looking at (another app in front, or minimised/hidden).
function shouldShow({ recording, mode, main }) {
  if (!recording || mode === 'off') return false;
  if (mode === 'always') return true;
  return !main || main.minimized || !main.visible || !main.focused;
}

// Keep a window fully on a screen: the work area nearest to the window's centre (the one holding it, when it is on one).
function placeWithin(bounds, workAreas) {
  const areas = workAreas.length ? workAreas : [{ x: 0, y: 0, width: 1280, height: 800 }];
  const cx = bounds.x + bounds.width / 2, cy = bounds.y + bounds.height / 2;
  const gap = (a) => Math.hypot(Math.max(a.x - cx, 0, cx - (a.x + a.width)), Math.max(a.y - cy, 0, cy - (a.y + a.height)));
  const wa = areas.reduce((best, a) => (gap(a) < gap(best) ? a : best), areas[0]);
  const x = Math.min(Math.max(bounds.x, wa.x), wa.x + wa.width - bounds.width);
  const y = Math.min(Math.max(bounds.y, wa.y), wa.y + wa.height - bounds.height);
  return { x: Math.round(x), y: Math.round(y), width: bounds.width, height: bounds.height };
}

// First position: top-right corner of the work area, like a status indicator.
function defaultBounds(workArea, size = SIZE.collapsed) {
  return { x: Math.round(workArea.x + workArea.width - size.width - MARGIN), y: Math.round(workArea.y + MARGIN), ...size };
}

module.exports = { SIZE, MARGIN, shouldShow, placeWithin, defaultBounds };
