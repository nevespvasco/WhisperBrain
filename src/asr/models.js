'use strict';
// Model catalog + installer. Models are public k2-fsa/sherpa-onnx release archives. Each archive is
// verified against a pinned SHA-256 before it is extracted.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawn } = require('node:child_process');

const REL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';

const CATALOG = [
  {
    id: 'parakeet-tdt-0.6b-v3', name: 'Parakeet TDT 0.6B v3', kind: 'transducer', languages: ['multi'],
    note: '25 European languages incl. Portuguese. Best accuracy; needs ~1.5 GB RAM.',
    url: `${REL}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`, sizeMB: 465, sha256: '1495e91b59d7fc53ddca91f3431758ec99f8fa253fdb0e1e851be0f72b14b0f9',
    maxSegmentSec: 30,
  },
  {
    id: 'parakeet-tdt-110m-en', name: 'Parakeet TDT 110M (English)', kind: 'transducer', languages: ['en'],
    note: 'English only. Very fast and light.',
    url: `${REL}/sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8.tar.bz2`, sizeMB: 110,
    sha256: 'f628312e9fdf8686374cb01a69425c41732529d540860311f16f37cbc32cfe9b',
    maxSegmentSec: 30,
  },
  {
    // Not a transcription model: it writes the grey draft words under a live caption while people are still talking
    // (the VAD segment is then decoded by the model above, and its text replaces the draft). NVIDIA Nemotron-3.5 ASR
    // streaming, 25 languages incl. pt-PT, exported with 320 ms chunks (first word about 0.6 s after speech starts; the
    // 80/160 ms exports cost more CPU, the 560/1120 ms ones add delay). Optional, never picked as the main model.
    id: 'nemotron-3.5-streaming-320ms', role: 'draft', name: 'Live draft captions (Nemotron 3.5 streaming)', kind: 'streaming-transducer', languages: ['multi'],
    note: 'Optional. Shows words within about a second while people speak; the final text still comes from the model above. Uses ~1 GB of RAM and a little CPU during a recording.',
    url: `${REL}/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-320ms-int8-2026-06-11.tar.bz2`, sizeMB: 453, sha256: '5f311142337a5c161e92d49f7a3009d8607d3836f39d610bff5307c74d1d2c53',
  },
  {
    id: 'whisper-small', name: 'Whisper small (multilingual)', kind: 'whisper', languages: ['multi'],
    note: '99 languages. Slower than Parakeet on CPU.',
    // TODO(sha256): the asr-models release publishes no digest for the Whisper archives (the Parakeet ones have one), so
    // pin these by hashing a verified download: sha256sum sherpa-onnx-whisper-small.tar.bz2
    url: `${REL}/sherpa-onnx-whisper-small.tar.bz2`, sizeMB: 610, sha256: null, maxSegmentSec: 25,
  },
  {
    id: 'whisper-base', name: 'Whisper base (multilingual)', kind: 'whisper', languages: ['multi'],
    note: '99 languages. Small and quick, lower accuracy.',
    url: `${REL}/sherpa-onnx-whisper-base.tar.bz2`, sizeMB: 160, sha256: null, maxSegmentSec: 25, // TODO(sha256): see whisper-small
  },
];

const VAD = {
  id: 'silero-vad', name: 'Silero VAD',
  url: `${REL}/silero_vad.onnx`, sizeMB: 1,
  sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
};

// Voice embeddings for telling speakers apart (language-independent). 3D-Speaker CAM++ (Apache-2.0) since 2026-11-26: better than
// the WeSpeaker ResNet34 before it in every saved-voice scenario and in diarization, and 3x faster (eval/bakeoff-results.md).
const SPEAKER = {
  id: 'speaker-voice', name: 'Speaker recognition (3D-Speaker CAM++)',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx',
  sizeMB: 30, sha256: '98daf9bcf1c8abf3db374fec4c27a5eda7c58705bb3f180d057b085a72a88bb5',
};
// The model before it. Kept working where it is already installed, because voices saved with it can only be recognised by it
// (their prints cannot be remade: the audio is deleted); it is never downloaded again.
const SPEAKER_LEGACY = {
  id: 'speaker-voice-resnet34', name: 'Speaker recognition (WeSpeaker ResNet34)',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx',
  sizeMB: 26, sha256: 'e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012',
};

// Who is speaking when, frame by frame and overlap included (pyannote segmentation-3.0, MIT licence), for the
// after-recording diarization. Only `file` is kept from the archive.
const SEGMENTATION = {
  id: 'speaker-segmentation', name: 'Speaker segmentation (pyannote 3.0)',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2',
  sizeMB: 7, sha256: '24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488', file: 'model.onnx',
};

// Preference when settings say "auto": the most capable model that is installed. Whisper invents text on silence and
// has no checksum, so the Parakeet models come first; it is used only when nothing else is installed. Draft (streaming)
// models are never a candidate: they cannot produce final text.
const AUTO_ORDER = ['parakeet-tdt-0.6b-v3', 'parakeet-tdt-110m-en', 'whisper-small', 'whisper-base'];

// Which speech models suit this computer, and when each one is the right choice. `language` is the meeting language
// ('auto' = unknown; English matters because the 110M model is English-only). -> { machine, main, draft, models } where
// models[id] = { fit: 'best'|'good'|'optional'|'skip', when } and `when` is a code the UI turns into a sentence.
// Physical cores are estimated as half the logical CPUs, like the worker pools; live drafts need 4 (DRAFT_MIN_CORES).
function recommend({ totalMemMB = os.totalmem() / 1048576, cpus = os.availableParallelism(), language = 'auto' } = {}) {
  const memGB = Math.round(totalMemMB / 1024);
  const cores = Math.max(1, Math.round(cpus / 2));
  const tier = memGB < 6 || cores < 3 ? 'small' : memGB >= 12 && cores >= 6 ? 'large' : 'medium';
  const english = language === 'en';
  const tiny = memGB < 4; // Parakeet 0.6B wants ~1.5 GB on top of the OS and the app
  const main = !tiny ? 'parakeet-tdt-0.6b-v3' : english ? 'parakeet-tdt-110m-en' : 'whisper-base';
  const draft = cores >= 4 && memGB >= 8; // ~1 GB more while recording; smaller machines get captions when a phrase ends
  const models = {
    'parakeet-tdt-0.6b-v3': main === 'parakeet-tdt-0.6b-v3' ? { fit: 'best', when: 'main' } : { fit: 'skip', when: 'low-memory' },
    'parakeet-tdt-110m-en': main === 'parakeet-tdt-110m-en' ? { fit: 'best', when: 'main-english' }
      : tier === 'large' ? { fit: 'skip', when: 'english-not-needed' } : { fit: 'optional', when: 'english-light' },
    'nemotron-3.5-streaming-320ms': draft ? { fit: tier === 'large' ? 'good' : 'optional', when: 'draft' } : { fit: 'skip', when: 'draft-small' },
    // Whisper only for languages Parakeet lacks: small where the computer can carry it, base on small computers
    'whisper-small': tier === 'small' ? { fit: 'skip', when: 'other-languages-slow' } : { fit: 'optional', when: 'other-languages' },
    'whisper-base': main === 'whisper-base' ? { fit: 'best', when: 'main-tiny' }
      : tier === 'small' ? { fit: 'optional', when: 'other-languages-light' } : { fit: 'skip', when: 'whisper-small-better' },
  };
  return { machine: { memGB, cores, cpus, tier }, main, draft, models };
}

class Models {
  constructor(dir, { catalog = CATALOG, vad = VAD, speaker = SPEAKER, speakerLegacy = SPEAKER_LEGACY, segmentation = SEGMENTATION, bus } = {}) {
    this.dir = dir;
    this.catalog = catalog;
    this.vad = vad;
    this.speaker = speaker;
    this.speakerLegacy = speakerLegacy;
    this.segmentation = segmentation;
    this.bus = bus;
    this.downloads = new Map(); // id -> { progress, abort }
    this.depsPending = null;    // installDeps() in progress
    fs.mkdirSync(dir, { recursive: true });
  }

  modelDir(id) { return path.join(this.dir, id); }
  vadPath() { return path.join(this.dir, 'silero-vad', 'silero_vad.onnx'); }
  // The voice model in use: the current one, or the one before it where that is all this install has (it keeps working until the
  // current one is downloaded). Speaker features need any of them: speakerInstalled().
  currentSpeakerPath() { return path.join(this.dir, 'speaker', path.basename(new URL(this.speaker.url).pathname)); }
  legacySpeakerPath() { return path.join(this.dir, 'speaker', path.basename(new URL(this.speakerLegacy.url).pathname)); }
  speakerPath() { const cur = this.currentSpeakerPath(); return !fs.existsSync(cur) && fs.existsSync(this.legacySpeakerPath()) ? this.legacySpeakerPath() : cur; }
  speakerInstalled() { return fs.existsSync(this.speakerPath()); }
  speakerUpToDate() { return fs.existsSync(this.currentSpeakerPath()); }   // false while only the model before it is installed
  legacySpeakerInstalled() { return fs.existsSync(this.legacySpeakerPath()); }
  segmentationPath() { return path.join(this.dir, 'segmentation', path.basename(this.segmentation.file)); }
  segmentationInstalled() { return fs.existsSync(this.segmentationPath()); }

  files(id) {
    const d = this.modelDir(id);
    if (!fs.existsSync(d)) return null;
    const entry = this.catalog.find((m) => m.id === id);
    if (!entry) return null;
    return resolveFiles(entry.kind, d);
  }

  isInstalled(id) { return !!this.files(id); }

  // The streaming model for live draft captions, when one is installed (see the `role: 'draft'` catalog entry).
  draftModel() {
    const m = this.catalog.find((x) => x.role === 'draft' && this.isInstalled(x.id));
    return m ? this.describe(m.id) : null;
  }
  vadInstalled() { return fs.existsSync(this.vadPath()); }

  list() {
    return this.catalog.map((m) => ({
      id: m.id, name: m.name, languages: m.languages, note: m.note, sizeMB: m.sizeMB, kind: m.kind, role: m.role || 'main',
      installed: this.isInstalled(m.id),
      downloading: this.downloads.has(m.id) ? this.downloads.get(m.id).progress : null,
    }));
  }

  // Resolve the setting ('auto' or an id) to an installed model, or null.
  resolve(pref = 'auto') {
    const main = (id) => this.catalog.find((m) => m.id === id)?.role !== 'draft';
    if (pref !== 'auto') return main(pref) && this.isInstalled(pref) ? this.describe(pref) : null;
    for (const id of AUTO_ORDER) if (this.isInstalled(id)) return this.describe(id);
    const any = this.catalog.find((m) => m.role !== 'draft' && this.isInstalled(m.id));
    return any ? this.describe(any.id) : null;
  }

  describe(id) {
    const m = this.catalog.find((x) => x.id === id);
    return { id, kind: m.kind, role: m.role || 'main', languages: m.languages, maxSegmentSec: m.maxSegmentSec, files: this.files(id) };
  }

  async install(id, { onProgress } = {}) {
    const m = this.catalog.find((x) => x.id === id);
    if (!m) throw new Error(`unknown model: ${id}`);
    if (this.downloads.has(id)) throw new Error(`${id} is already downloading`);
    const ctl = { progress: 0, abort: new AbortController() };
    this.downloads.set(id, ctl);
    // download() reports every network chunk; tell the UI only when the whole percentage moves (≤100 events)
    let shown = -1;
    const report = (p) => {
      ctl.progress = p; onProgress?.(p);
      const pct = Math.floor(p * 100);
      if (pct !== shown) { shown = pct; this.bus?.publish('model.progress', { id, progress: p }); }
    };
    const tmp = path.join(this.dir, `.tmp-${id}-${process.pid}`);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });
      await this.installDeps();
      const archive = path.join(tmp, 'model.tar.bz2');
      const sha = await download(m.url, archive, { signal: ctl.abort.signal, onProgress: report });
      if (m.sha256 && sha !== m.sha256) throw new Error(`checksum mismatch for ${id}: got ${sha}`);
      await untar(archive, tmp);
      fs.rmSync(archive);
      const root = fs.readdirSync(tmp).map((n) => path.join(tmp, n)).find((p) => fs.statSync(p).isDirectory());
      if (!root || !resolveFiles(m.kind, root)) throw new Error(`archive for ${id} does not contain the expected model files`);
      const dest = this.modelDir(id);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(root, dest);
      fs.writeFileSync(path.join(dest, '.sha256'), sha + '\n');
      report(1);
      this.bus?.publish('model.installed', { id });
      return this.describe(id);
    } finally {
      this.downloads.delete(id);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // The VAD and speaker models every transcription model needs. Shared by installs that run at the same time, so two
  // downloads never write the same file.
  installDeps() {
    this.depsPending ??= (async () => {
      if (!this.vadInstalled()) await this.installVad();
      if (!this.speakerUpToDate()) await this.installSpeaker().catch((e) => this.bus?.publish('model.error', { id: this.speaker.id, message: `speaker recognition: ${e.message}` }));
      if (!this.segmentationInstalled()) await this.installSegmentation().catch((e) => this.bus?.publish('model.error', { id: this.segmentation.id, message: `speaker segmentation: ${e.message}` }));
    })().finally(() => { this.depsPending = null; });
    return this.depsPending;
  }

  async installVad() {
    const dest = this.vadPath();
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.part';
    const sha = await download(this.vad.url, tmp, {});
    if (this.vad.sha256 && sha !== this.vad.sha256) { fs.rmSync(tmp, { force: true }); throw new Error('checksum mismatch for the VAD model'); }
    fs.renameSync(tmp, dest);
  }

  async installSpeaker() {
    const dest = this.currentSpeakerPath();
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.part';
    const sha = await download(this.speaker.url, tmp, {});
    if (this.speaker.sha256 && sha !== this.speaker.sha256) { fs.rmSync(tmp, { force: true }); throw new Error('checksum mismatch for the speaker model'); }
    fs.renameSync(tmp, dest);
    this.bus?.publish('model.installed', { id: this.speaker.id });
  }

  async installSegmentation() {
    const dest = this.segmentationPath();
    const tmp = path.join(this.dir, `.tmp-segmentation-${process.pid}`);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });
      const archive = path.join(tmp, 'seg.tar.bz2');
      const sha = await download(this.segmentation.url, archive, {});
      if (this.segmentation.sha256 && sha !== this.segmentation.sha256) throw new Error('checksum mismatch for the speaker segmentation model');
      await untar(archive, tmp);
      const found = findFile(tmp, path.basename(this.segmentation.file));
      if (!found) throw new Error(`the speaker segmentation archive has no ${this.segmentation.file}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(found, dest);
      this.bus?.publish('model.installed', { id: this.segmentation.id });
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  // The voice model and the segmentation model, whichever is missing (both are needed to tell speakers apart).
  async installSpeakerModels() {
    if (!this.speakerUpToDate()) await this.installSpeaker();
    if (!this.segmentationInstalled()) await this.installSegmentation();
  }

  cancel(id) { this.downloads.get(id)?.abort.abort(); }

  remove(id) {
    fs.rmSync(this.modelDir(id), { recursive: true, force: true });
    this.bus?.publish('model.removed', { id });
  }
}

// Locate the files sherpa needs by suffix, so renamed archives (e.g. "small-encoder.int8.onnx") keep working.
function resolveFiles(kind, dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  const pick = (re) => {
    const hits = names.filter((n) => re.test(n));
    hits.sort((a, b) => (/int8/.test(b) ? 1 : 0) - (/int8/.test(a) ? 1 : 0)); // prefer int8
    return hits[0] ? path.join(dir, hits[0]) : null;
  };
  const tokens = pick(/tokens\.txt$/);
  if (kind === 'transducer' || kind === 'streaming-transducer') {
    const f = { encoder: pick(/encoder.*\.onnx$/), decoder: pick(/decoder.*\.onnx$/), joiner: pick(/joiner.*\.onnx$/), tokens };
    return Object.values(f).every(Boolean) ? f : null;
  }
  if (kind === 'whisper') {
    const f = { encoder: pick(/encoder.*\.onnx$/), decoder: pick(/decoder.*\.onnx$/), tokens };
    return Object.values(f).every(Boolean) ? f : null;
  }
  return null;
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const hit = findFile(p, name); if (hit) return hit; } else if (e.name === name) return p;
  }
  return null;
}

// sherpa-onnx OfflineRecognizer config for a resolved model. `beam` selects modified_beam_search, which transducer
// models need for hotwords (about 20% more CPU than the greedy default; the decoding method is fixed when the
// recognizer is created).
function recognizerConfig(model, { threads = 2, language = 'auto', beam = false, hotwordsScore = 1.5 } = {}) {
  const f = model.files;
  const base = { tokens: f.tokens, numThreads: threads, provider: 'cpu', debug: 0 };
  if (model.kind === 'transducer') {
    const cfg = { featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: { ...base, transducer: { encoder: f.encoder, decoder: f.decoder, joiner: f.joiner }, modelType: 'nemo_transducer' } };
    if (beam) Object.assign(cfg, { decodingMethod: 'modified_beam_search', maxActivePaths: 4, hotwordsScore });
    return cfg;
  }
  if (model.kind === 'whisper') {
    return {
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: { ...base, whisper: { encoder: f.encoder, decoder: f.decoder, language: language === 'auto' ? '' : language, task: 'transcribe', tailPaddings: -1 } },
    };
  }
  throw new Error(`unsupported model kind: ${model.kind}`);
}

// sherpa-onnx OnlineRecognizer config for a streaming model (live draft captions). Greedy search is enough for a draft
// and the cheapest; the model type is detected from the files. Endpointing is off: the VAD decides where utterances end.
function onlineRecognizerConfig(model, { threads = 2 } = {}) {
  const f = model.files;
  return {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { tokens: f.tokens, numThreads: threads, provider: 'cpu', debug: 0, transducer: { encoder: f.encoder, decoder: f.decoder, joiner: f.joiner } },
    decodingMethod: 'greedy_search', enableEndpoint: false,
  };
}

async function download(url, dest, { signal, onProgress } = {}) {
  const res = await fetch(url, { signal, redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  let got = 0;
  const out = fs.createWriteStream(dest);
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    hash.update(chunk);
    got += chunk.length;
    if (total && onProgress) onProgress(Math.min(0.99, got / total));
  });
  await pipeline(body, out);
  return hash.digest('hex');
}

function untar(archive, cwd) {
  return new Promise((resolve, reject) => {
    // bsdtar (macOS, Windows 10+) and GNU tar (Linux, with bzip2) both understand -xjf.
    const p = spawn('tar', ['-xjf', archive, '-C', cwd], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar failed (${code}): ${err.trim()}`))));
  });
}

module.exports = { Models, CATALOG, VAD, SPEAKER, SEGMENTATION, AUTO_ORDER, recommend, resolveFiles, recognizerConfig, onlineRecognizerConfig, download };
