'use strict';
// Teleprompter window: when it shows, how big it is, where it sits. Pure (no Electron), so it is unit-tested.
// It opens at the top centre of the screen, just under where a laptop camera is, and keeps the place and size the user gives it.
const { placeWithin } = require('./float');

const SIZE = { width: 720, height: 220 };
const MIN = { width: 360, height: 120 };
const TOP = 8;

// enabled: settings.teleprompter.enabled. recording: a recording runs. assistantOn: the assistant helps with it (it may be
// switched on for one meeting only). hidden: the user hid it with the shortcut for this recording.
function shouldShowPrompter({ enabled, recording, assistantOn, hidden }) {
  return !!(enabled && recording && assistantOn && !hidden);
}

// First place: centred at the top of the work area, never wider than it.
function defaultPrompterBounds(workArea) {
  const width = Math.min(SIZE.width, workArea.width), height = Math.min(SIZE.height, workArea.height);
  return { x: Math.round(workArea.x + (workArea.width - width) / 2), y: Math.round(workArea.y + TOP), width, height };
}

// A remembered place ({x, y, width, height} from teleprompter.json), made to fit a screen that is there now; null when unusable.
function restorePrompterBounds(saved, workAreas) {
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) return null;
  const areas = workAreas.length ? workAreas : [{ x: 0, y: 0, width: 1280, height: 800 }];
  const widest = Math.max(...areas.map((a) => a.width)), tallest = Math.max(...areas.map((a) => a.height));
  const width = Math.round(Math.min(Math.max(saved.width, MIN.width), widest));
  const height = Math.round(Math.min(Math.max(saved.height, MIN.height), tallest));
  return placeWithin({ x: saved.x, y: saved.y, width, height }, areas);
}

module.exports = { SIZE, MIN, shouldShowPrompter, defaultPrompterBounds, restorePrompterBounds };
