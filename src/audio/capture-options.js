'use strict';
// How the microphone is prepared before speech recognition. noiseSuppression and autoGain are user settings
// ('auto' | 'on' | 'off'); "auto" keeps what each platform did before they existed: Chromium (macOS/Windows)
// enhances, raw pw-record on Linux does not. ui/capture.js applies the same rule with its own default (on).
function enhancement(mode, autoDefault) {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return autoDefault;
}

module.exports = { enhancement };
