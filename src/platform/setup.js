'use strict';
// "Is this computer ready?": what WhisperBrain needs from the operating system beyond its own files, and how to get it.
// buildSetup() is pure (every probe is passed in) so each operating system's list is unit-tested from here; the app only
// supplies the real probes (which, permissions).
const { spawn } = require('node:child_process');

// Is `cmd` on the PATH? `cmd` is always a literal from this file, never user input.
function which(cmd, platform = process.platform) {
  return new Promise((resolve) => {
    const p = platform === 'win32' ? spawn('where', [cmd], { stdio: 'ignore', windowsHide: true }) : spawn('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

const FFMPEG = {
  linux: [['Debian / Ubuntu', 'sudo apt install ffmpeg'], ['Fedora', 'sudo dnf install ffmpeg-free'], ['Arch', 'sudo pacman -S ffmpeg']],
  darwin: [['Homebrew', 'brew install ffmpeg']],
  win32: [['winget', 'winget install Gyan.FFmpeg']],
};

// level: 'required' (recording does not work without it) | 'recommended' (a feature people expect is missing) | 'optional'
// status: 'ok' | 'missing' | 'unknown' (only the operating system can tell: it asks on first use)
const item = (id, level, status, title, why, fix = {}) => ({ id, level, status, title, why, fix });
const perm = (state) => (state === 'granted' ? 'ok' : state === 'denied' || state === 'restricted' ? 'missing' : 'unknown');

const OLLAMA = {
  linux: [['Install Ollama', 'curl -fsSL https://ollama.com/install.sh | sh']],
  darwin: [['Install Ollama', 'brew install ollama   (or download it from ollama.com)'], ['Start it', 'ollama serve']],
  win32: [['Install Ollama', 'winget install Ollama.Ollama']],
};
const PULL = ['Download a model', 'ollama pull llama3.2'];

// The AI server is only "ready" when something answers at its address and it has a model to use: the default address
// (a local Ollama) is filled in whether or not Ollama is installed.
function aiItem(platform, { baseUrl = '', model = '', reachable = false, models = [] } = {}) {
  const why = 'Writes the summary, key points and action items, answers questions, and powers the live assistant. Any OpenAI-compatible server, local or hosted.';
  if (!baseUrl) return item('ai', 'recommended', 'missing', 'AI server', why, { text: 'Add an AI server (for example Ollama, LM Studio or an API key).', settings: 'ai' });
  if (!reachable) {
    return item('ai', 'recommended', 'missing', 'AI server', why, {
      text: `Nothing answers at ${baseUrl}. If you use Ollama, install it, start it and download a model, or point Settings → AI at another server.`,
      commands: [...(OLLAMA[platform] || []), PULL], settings: 'ai',
    });
  }
  if (!model && !models.length) {
    return item('ai', 'recommended', 'missing', 'AI server', why, { text: 'The server answers but has no models.', commands: [PULL], settings: 'ai' });
  }
  return item('ai', 'recommended', 'ok', 'AI server', why);
}

async function buildSetup({ platform, caps = {}, has = () => Promise.resolve(false), perms = {}, models = {}, llm = {}, osRelease = '' }) {
  const items = [];
  const session = caps.session;

  // ---- the same on every system
  const modelOk = !!models.speech && !!models.vad;
  items.push(item('speech-model', 'required', modelOk ? 'ok' : 'missing', 'Speech model',
    'Turns audio into text on this computer. Downloaded once; audio never leaves the machine.',
    modelOk ? {} : { text: 'Download a speech model.', settings: 'audio' }));
  items.push(item('speaker-model', 'recommended', models.speaker ? 'ok' : 'missing', 'Voice models',
    'Tell the people on a call apart, so the transcript says who spoke.',
    models.speaker ? {} : { text: 'Download the voice models.', settings: 'audio' }));
  items.push(aiItem(platform, llm));
  const ffmpeg = await has('ffmpeg');
  items.push(item('ffmpeg', 'optional', ffmpeg ? 'ok' : 'missing', 'ffmpeg',
    'Lets you import audio and video files other than WAV (mp3, m4a, mp4…). Recording does not need it.',
    ffmpeg ? {} : { commands: FFMPEG[platform] || [] }));

  if (platform === 'linux') {
    const [pwRecord, pwDump] = await Promise.all([has('pw-record'), has('pw-dump')]);
    const pw = pwRecord && pwDump;
    items.push(item('pipewire', 'required', pw ? 'ok' : 'missing', 'PipeWire',
      'Captures your microphone and what the computer plays (the other side of the call). Needs pw-record and pw-dump.',
      pw ? {} : { text: `Install PipeWire${pwRecord ? '' : ' (pw-record is missing)'}${pwDump ? '' : ' (pw-dump is missing)'}.`, commands: [
        ['Debian / Ubuntu', 'sudo apt install pipewire-bin pipewire-pulse wireplumber'],
        ['Fedora', 'sudo dnf install pipewire-utils pipewire-pulseaudio wireplumber'],
        ['Arch', 'sudo pacman -S pipewire pipewire-pulse wireplumber'],
      ] }));
    if (pw) {
      const aec = caps.echoCancel;
      items.push(item('echo-cancel', 'optional', aec?.available ? 'ok' : 'missing', 'Echo cancellation',
        'Removes the speakers\' sound from your microphone, so the other side is not transcribed twice.',
        aec?.available ? {} : { text: aec?.reason || 'PipeWire\'s echo-cancel module is not available.' }));
    }
    if (session === 'wayland') {
      const [wl, wtype] = await Promise.all([has('wl-copy'), has('wtype')]);
      items.push(item('paste', 'optional', wl && wtype ? 'ok' : 'missing', 'Dictation auto-paste',
        'Pastes dictated text into the window you were using. Without it the text is only copied.',
        wl && wtype ? {} : { commands: [['Debian / Ubuntu', 'sudo apt install wl-clipboard wtype'], ['Fedora', 'sudo dnf install wl-clipboard wtype'], ['Arch', 'sudo pacman -S wl-clipboard wtype']] }));
    } else if (session === 'x11') {
      const [xclip, xprop, wmctrl] = await Promise.all([has('xclip'), has('xprop'), has('wmctrl')]);
      const pasteOk = xclip && caps.paste !== false;
      items.push(item('paste', 'optional', pasteOk ? 'ok' : 'missing', 'Dictation auto-paste',
        'Pastes dictated text into the window you were using. Without it the text is only copied.',
        pasteOk ? {} : { text: xclip ? 'The X11 helper is not built (npm run build:x11).' : '', commands: xclip ? [] : [['Debian / Ubuntu', 'sudo apt install xclip'], ['Fedora', 'sudo dnf install xclip'], ['Arch', 'sudo pacman -S xclip']] }));
      items.push(item('windows', 'optional', xprop && wmctrl ? 'ok' : 'missing', 'Window titles',
        'Reads window titles to notice that a call is running and which app it is.',
        xprop && wmctrl ? {} : { commands: [['Debian / Ubuntu', 'sudo apt install x11-utils wmctrl'], ['Fedora', 'sudo dnf install xorg-x11-utils wmctrl'], ['Arch', 'sudo pacman -S xorg-xprop wmctrl']] }));
    }
  }

  if (platform === 'darwin') {
    const major = Number(String(osRelease).split('.')[0]);
    const newEnough = !major || major >= 22;   // Darwin 22 = macOS 13, the first with ScreenCaptureKit audio
    items.push(item('macos-version', 'required', newEnough ? 'ok' : 'missing', 'macOS 13 or newer',
      'System audio (the other side of the call) needs it.', newEnough ? {} : { text: 'Update macOS.' }));
    items.push(item('permission-mic', 'required', perm(perms.microphone), 'Microphone permission',
      'To record your own voice. macOS asks the first time you record.',
      perm(perms.microphone) === 'ok' ? {} : { text: 'System Settings → Privacy & Security → Microphone → switch WhisperBrain on.' }));
    items.push(item('permission-system', 'recommended', perm(perms.screen), 'Screen & System Audio Recording permission',
      'To record the other side of the call. macOS asks the first time you record system audio.',
      perm(perms.screen) === 'ok' ? {} : { text: 'System Settings → Privacy & Security → Screen & System Audio Recording → under "System Audio Recording Only" switch WhisperBrain on (press + to add it), then reopen the app.' }));
    items.push(item('permission-accessibility', 'optional', perms.accessibility === true ? 'ok' : perms.accessibility === false ? 'missing' : 'unknown', 'Accessibility permission',
      'For dictation auto-paste and for reading participant names from a meeting window.',
      perms.accessibility === true ? {} : { text: 'System Settings → Privacy & Security → Accessibility → switch WhisperBrain on.' }));
  }

  if (platform === 'win32') {
    items.push(item('permission-mic', 'required', perm(perms.microphone), 'Microphone access',
      'To record your own voice. Windows has to allow desktop apps to use the microphone.',
      perm(perms.microphone) === 'ok' ? {} : { text: 'Settings → Privacy & security → Microphone → allow apps (and desktop apps) to access your microphone.' }));
  }

  const rank = { required: 0, recommended: 1, optional: 2 };
  items.sort((a, b) => rank[a.level] - rank[b.level]);
  const blocking = items.filter((i) => i.level === 'required' && i.status !== 'ok' && i.status !== 'unknown').length;
  const attention = items.filter((i) => i.level !== 'optional' && i.status !== 'ok').length;
  return { platform, session: session || null, ready: blocking === 0, blocking, attention, items };
}

module.exports = { buildSetup, which };
