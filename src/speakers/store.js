'use strict';
const { newId } = require('../core/ids');
const { tx } = require('../core/db');
const { toBlob, fromBlob, norm, blend, cosine, mergeClusters, matchVoices, addPrint, populationMean, MATCH, MAX_REJECTS, VOICE_MEAN } = require('./cluster');
const { semitones } = require('../audio/features');

const PITCH_VETO = 4;   // semitones: two voices this far apart in pitch are never the same person
// A voice print is biometric data: it is saved only on the say-so of someone, and the profile records whose.
const CONSENT_SOURCES = new Set(['user', 'meeting', 'import']);


// Default label for a speaker that has not been named. Channel "mic" ids are m1, m2…; system audio ids are s1, s2…
function defaultLabel(speakerId, channelSpeaker, userName = '') {
  if (!speakerId) return channelSpeaker === 'me' ? (userName || 'Me') : channelSpeaker === 'them' ? 'Them' : channelSpeaker;
  const n = Number(speakerId.slice(1));
  if (speakerId[0] === 'm') return n === 1 ? (userName || 'Me') : `Room speaker ${n}`;
  return `Speaker ${n}`;
}

class Speakers {
  constructor(db, bus) { this.db = db; this.bus = bus; this.mean = VOICE_MEAN; this.adapt = true; }   // mean: the average voice that prints are centred on, see cluster.js

  // ---- per-note speakers ----
  forNote(noteId) {
    const rows = this.db.prepare(`
      SELECT ns.speaker_id AS speakerId, ns.channel, ns.name, ns.voice_id AS voiceId, v.name AS voiceName, ns.count, ns.centroid, ns.pitch,
             (SELECT COALESCE(SUM(end_ms - start_ms), 0) FROM segments s WHERE s.note_id = ns.note_id AND s.speaker_id = ns.speaker_id) AS talkMs,
             (SELECT COUNT(*) FROM segments s WHERE s.note_id = ns.note_id AND s.speaker_id = ns.speaker_id) AS segments
      FROM note_speakers ns LEFT JOIN voices v ON v.id = ns.voice_id
      WHERE ns.note_id = ? ORDER BY ns.channel, CAST(substr(ns.speaker_id, 2) AS INTEGER)`).all(noteId);
    return rows.map((r) => ({ ...r, centroid: fromBlob(r.centroid) }));
  }

  publicForNote(noteId, userName) {
    return this.forNote(noteId).filter((s) => s.segments > 0).map(({ centroid, ...s }) => ({ ...s, label: s.name || s.voiceName || defaultLabel(s.speakerId, s.channel === 'mic' ? 'me' : 'them', userName) }));
  }

  save(noteId, { speakerId, channel, centroid, count, voiceId, pitch }) {
    this.db.prepare(`INSERT INTO note_speakers(note_id, speaker_id, channel, centroid, count, voice_id, pitch) VALUES(?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(note_id, speaker_id) DO UPDATE SET centroid = excluded.centroid, count = excluded.count, voice_id = COALESCE(note_speakers.voice_id, excluded.voice_id), pitch = COALESCE(excluded.pitch, note_speakers.pitch)`)
      .run(noteId, speakerId, channel, toBlob(centroid), count, voiceId || null, pitch || null);
  }

  // A speaker whose identity is known from outside the audio (a Discord user): no voice print, named from the start.
  // A name the user has already changed is kept.
  ensureNamed(noteId, speakerId, name, channel = 'system') {
    this.db.prepare(`INSERT INTO note_speakers(note_id, speaker_id, channel, count, name) VALUES(?, ?, ?, 0, ?)
      ON CONFLICT(note_id, speaker_id) DO UPDATE SET name = CASE WHEN note_speakers.name = '' THEN excluded.name ELSE note_speakers.name END`)
      .run(noteId, speakerId, channel, String(name || '').slice(0, 80));
    this.bus?.publish('speakers.updated', { noteId });
  }

  // A name read from the meeting window (who was highlighted while this voice spoke). It never replaces a name the user
  // typed, and it never overrules a saved voice: a speaker that sounds like a saved person keeps that person. A saved
  // voice with the name is linked to the speaker only when the two sound alike.
  // -> 'named' | 'agrees' (it is the person the voice already matched) | 'conflict' (the voice matched somebody else) |
  //    'kept' (the user already named it) | null (no such speaker)
  nameFromMeeting(noteId, speakerId, name) {
    const clean = String(name || '').trim().slice(0, 80);
    const all = this.forNote(noteId);
    const sp = all.find((x) => x.speakerId === speakerId);
    if (!sp || !clean) return null;
    if (sp.name) return 'kept';
    const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
    if (sp.voiceId && sp.voiceName && !same(sp.voiceName, clean)) return 'conflict';
    const voice = this.voiceByName(clean);
    let link = null;
    if (voice && !all.some((x) => x.voiceId === voice.id && x.speakerId !== speakerId)) {
      const fits = sp.voiceId === voice.id || (sp.centroid && matchVoices([{ id: sp.speakerId, centroid: sp.centroid, channel: sp.channel }], [voice], MATCH.threshold - 0.2, null, { mu: this.channelMeans() }).has(sp.speakerId));
      if (fits || !sp.centroid) link = voice.id;
    }
    this.db.prepare('UPDATE note_speakers SET name = ?, voice_id = COALESCE(?, voice_id) WHERE note_id = ? AND speaker_id = ?').run(clean, link, noteId, speakerId);
    this.bus?.publish('speakers.updated', { noteId });
    return sp.voiceId && sp.voiceName && same(sp.voiceName, clean) ? 'agrees' : 'named';
  }

  // Remember a voice the meeting window named, for the next meetings: the speaker's print becomes (one more print of) a
  // saved voice. Refused when a voice with that name exists and this one does not sound like it: two people may share a
  // first name, and a wrong highlight must not teach a profile somebody else's voice. Refused too unless the caller
  // attests consent ({ consent: true }: the "remember voices the call named" setting is on). -> true when learned
  learnFromMeeting(noteId, speakerId, { consent = false } = {}) {
    if (consent !== true) return false;
    const sp = this.forNote(noteId).find((x) => x.speakerId === speakerId);
    if (!sp?.name || !sp.centroid || sp.talkMs < 8000) return false; // a voice print needs some seconds of speech to mean anything
    const existing = this.voiceByName(sp.name);
    if (existing && sp.voiceId !== existing.id) return false;
    this.rename(noteId, speakerId, sp.name, { remember: true, consentSource: 'meeting' });
    return true;
  }

  // Fold one speaker of a note into another (the same person heard as two voices): its utterances move, the voice prints
  // are pooled, and the name and saved-voice link carry over. Refused for voices that clearly differ: unlike names read
  // off a screen, the sound is not a guess. -> true when merged
  mergeSpeakers(noteId, from, into, { minSimilarity = 0.25 } = {}) {
    const all = this.forNote(noteId);
    const a = all.find((x) => x.speakerId === into), b = all.find((x) => x.speakerId === from);
    if (!a || !b || a.channel !== b.channel || from === into) return false;
    if (a.centroid && b.centroid && cosine(a.centroid, b.centroid) < minSimilarity) return false;
    if (a.pitch && b.pitch && semitones(a.pitch, b.pitch) > PITCH_VETO) return false;
    if (a.name && b.name && a.name.toLowerCase() !== b.name.toLowerCase()) return false;
    tx(this.db, () => {
      this.db.prepare('UPDATE segments SET speaker_id = ? WHERE note_id = ? AND speaker_id = ?').run(into, noteId, from);
      const centroid = a.centroid && b.centroid ? blend(norm(a.centroid), a.count || 1, norm(b.centroid), b.count || 1) : (a.centroid || b.centroid);
      this.db.prepare('UPDATE note_speakers SET centroid = ?, count = ?, name = CASE WHEN name = \'\' THEN ? ELSE name END, voice_id = COALESCE(voice_id, ?), pitch = COALESCE(pitch, ?) WHERE note_id = ? AND speaker_id = ?')
        .run(toBlob(centroid), a.count + b.count, b.name, b.voiceId, b.pitch, noteId, into);
      this.db.prepare('DELETE FROM note_speakers WHERE note_id = ? AND speaker_id = ?').run(noteId, from);
    });
    this.bus?.publish('speakers.updated', { noteId });
    return true;
  }

  // The next free id for a speaker of a channel: s5 when s1..s4 exist ('m' for the microphone).
  freeSpeakerId(noteId, channel) {
    const prefix = channel === 'mic' ? 'm' : 's';
    const used = this.db.prepare('SELECT speaker_id AS id FROM note_speakers WHERE note_id = ? UNION SELECT DISTINCT speaker_id FROM segments WHERE note_id = ? AND speaker_id IS NOT NULL').all(noteId, noteId)
      .filter((r) => String(r.id).startsWith(prefix)).map((r) => Number(String(r.id).slice(1))).filter((n) => Number.isSafeInteger(n) && n < 1000); // d<snowflake> ids are Discord people, not voice numbers
    return `${prefix}${Math.max(0, ...used) + 1}`;
  }

  // Name a speaker in one note. With remember=true the voice is saved (or reinforced) as a profile, so future
  // meetings recognise this person automatically: the speaker's voice print is added to the profile as one more print
  // (a speaker confirmed twice replaces its own print), weighted by the seconds this person spoke.
  // Naming a speaker that was linked to a profile under another name is a correction: that profile is told "this voice
  // is not you" (a rejected print, so the same wrong match is not made again) and the speaker goes with the new name.
  // Only a link the user had already confirmed under that very name and now renames to a new name nobody has is read as
  // renaming the profile itself.
  // remember saves a voice only together with consentSource ('user' | 'meeting' | 'import'); without it the speaker is
  // named and nothing biometric is stored. The profile keeps when and from which speaker consent was given.
  rename(noteId, speakerId, name, { remember = false, consentSource = null } = {}) {
    const sp = this.forNote(noteId).find((s) => s.speakerId === speakerId);
    if (!sp) return null;
    const clean = String(name || '').trim().slice(0, 80);
    const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
    const source = `${noteId}:${speakerId}`;
    let voiceId = sp.voiceId;
    const linked = voiceId && clean ? this.voice(voiceId) : null;
    if (linked && !same(linked.name, clean)) {
      const confirmedHere = sp.name && same(sp.name, linked.name);
      if (!confirmedHere || this.voiceByName(clean)) {
        if (sp.centroid) this.reject(linked.id, sp.centroid, source);
        voiceId = null;
      }
    }
    if (remember && clean && sp.centroid && CONSENT_SOURCES.has(consentSource)) {
      const existing = voiceId ? this.voice(voiceId) : this.voiceByName(clean);
      const seconds = sp.talkMs > 0 ? sp.talkMs / 1000 : Math.max(1, sp.count) * 3;
      const print = { embedding: sp.centroid, weight: Math.min(30, seconds), channel: sp.channel === 'mic' ? 'mic' : 'system', pitch: sp.pitch, source };
      if (existing) {
        this.reinforce(existing.id, print, { name: clean, utterances: Math.max(1, sp.count) });
        this.db.prepare('UPDATE voices SET consent_at = COALESCE(consent_at, ?), consent_source = COALESCE(consent_source, ?), enrolled_from = COALESCE(enrolled_from, ?) WHERE id = ?').run(Date.now(), consentSource, source, existing.id);
        voiceId = existing.id;
      } else {
        voiceId = newId();
        tx(this.db, () => {
          this.db.prepare('INSERT INTO voices(id, name, embedding, samples, pitch, created_at, updated_at, consent_at, consent_source, enrolled_from) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(voiceId, clean, toBlob(norm(sp.centroid)), Math.max(1, sp.count), sp.pitch || null, Date.now(), Date.now(), Date.now(), consentSource, source);
          this.writePrints(voiceId, addPrint([], print));
        });
      }
    }
    this.db.prepare('UPDATE note_speakers SET name = ?, voice_id = ? WHERE note_id = ? AND speaker_id = ?').run(clean, voiceId || null, noteId, speakerId);
    this.bus?.publish('speakers.updated', { noteId });
    return this.publicForNote(noteId).find((s) => s.speakerId === speakerId);
  }

  // Reassign one segment to another (possibly new) speaker, for corrections.
  reassignSegment(noteId, segmentId, speakerId) {
    const exists = this.db.prepare('SELECT channel FROM note_speakers WHERE note_id = ? AND speaker_id = ?').get(noteId, speakerId);
    if (!exists) {
      if (!/^[ms]\d{1,3}$/.test(speakerId)) return false; // only a new voice number may be made up; a Discord person must have been on the call
      const seg = this.db.prepare('SELECT speaker FROM segments WHERE id = ? AND note_id = ?').get(segmentId, noteId);
      if (!seg) return false;
      this.db.prepare('INSERT INTO note_speakers(note_id, speaker_id, channel, count) VALUES(?, ?, ?, 0)').run(noteId, speakerId, seg.speaker === 'me' ? 'mic' : 'system');
    }
    const ok = this.db.prepare('UPDATE segments SET speaker_id = ? WHERE id = ? AND note_id = ?').run(speakerId, segmentId, noteId).changes > 0;
    if (ok) this.bus?.publish('speakers.updated', { noteId });
    return ok;
  }

  // Fold speakers that turned out to be the same voice (run when a recording stops). A channel that was diarized is
  // left out: its clustering already saw the whole meeting, and greedy centroid merging undoes it (on a far-field mix
  // every pooled voice print is within 0.6 of the others).
  consolidate(noteId, threshold = 0.6, { channels = ['mic', 'system'] } = {}) {
    const all = this.forNote(noteId).filter((s) => s.centroid);
    const changes = new Map();
    for (const channel of channels) {
      const list = all.filter((s) => s.channel === channel).map((s) => ({ id: s.speakerId, centroid: s.centroid, count: s.count, name: s.name, voiceId: s.voiceId, pitch: s.pitch }));
      // never merge two speakers the user (or a voice profile) has told apart, nor two with clearly different pitch
      const named = (x) => x.name || x.voiceId;
      const canMerge = (a, b) => !(named(a) && named(b) && (a.name !== b.name || a.voiceId !== b.voiceId))
        && !(a.pitch && b.pitch && semitones(a.pitch, b.pitch) > PITCH_VETO);
      const { merged, speakers } = mergeClusters(list, threshold, canMerge);
      for (const [from, into] of merged) changes.set(from, { into, keep: speakers.find((x) => x.id === into) });
    }
    if (!changes.size) return 0;
    tx(this.db, () => {
      for (const [from, { into, keep }] of changes) {
        const src = all.find((s) => s.speakerId === from);
        this.db.prepare('UPDATE segments SET speaker_id = ? WHERE note_id = ? AND speaker_id = ?').run(into, noteId, from);
        this.db.prepare('UPDATE note_speakers SET centroid = ?, count = ?, name = CASE WHEN name = \'\' THEN ? ELSE name END, voice_id = COALESCE(voice_id, ?) WHERE note_id = ? AND speaker_id = ?')
          .run(toBlob(keep.centroid), keep.count, src.name, src.voiceId, noteId, into);
        this.db.prepare('DELETE FROM note_speakers WHERE note_id = ? AND speaker_id = ?').run(noteId, from);
      }
    });
    this.bus?.publish('speakers.updated', { noteId });
    return changes.size;
  }

  // Every utterance of a note with the voice it was judged to have (for the after-recording refinement).
  segmentVoices(noteId) {
    return this.db.prepare('SELECT id, speaker, speaker_id AS speakerId, embedding FROM segments WHERE note_id = ? ORDER BY start_ms, id').all(noteId)
      .map((r) => ({ id: r.id, channel: r.speaker === 'me' ? 'mic' : 'system', speakerId: r.speakerId, embedding: fromBlob(r.embedding) }));
  }

  // Store the outcome of refineChannel(): corrected labels, new speakers (splits), folded speakers (merges), pitches.
  applyRefinement(noteId, channel, { assignments, speakers, removed }) {
    tx(this.db, () => {
      const known = new Set(this.forNote(noteId).map((s) => s.speakerId));
      for (const sp of speakers) {
        if (known.has(sp.id)) this.db.prepare('UPDATE note_speakers SET centroid = ?, count = ?, pitch = COALESCE(?, pitch) WHERE note_id = ? AND speaker_id = ?').run(toBlob(sp.centroid), sp.count, sp.pitch || null, noteId, sp.id);
        else this.db.prepare('INSERT INTO note_speakers(note_id, speaker_id, channel, centroid, count, pitch) VALUES(?, ?, ?, ?, ?, ?)').run(noteId, sp.id, channel, toBlob(sp.centroid), sp.count, sp.pitch || null);
      }
      const move = this.db.prepare('UPDATE segments SET speaker_id = ? WHERE id = ? AND note_id = ?');
      for (const [segId, speakerId] of assignments) move.run(speakerId, segId, noteId);
      for (const [from, into] of removed) {
        const src = this.db.prepare('SELECT name, voice_id AS voiceId FROM note_speakers WHERE note_id = ? AND speaker_id = ?').get(noteId, from);
        if (into && src) this.db.prepare('UPDATE note_speakers SET name = CASE WHEN name = \'\' THEN ? ELSE name END, voice_id = COALESCE(voice_id, ?) WHERE note_id = ? AND speaker_id = ?').run(src.name, src.voiceId, noteId, into);
        this.db.prepare('DELETE FROM note_speakers WHERE note_id = ? AND speaker_id = ?').run(noteId, from);
      }
    });
    if (assignments.size || removed.size || speakers.some((s) => s.isNew)) this.bus?.publish('speakers.updated', { noteId });
  }

  // Store the outcome of the after-recording diarization of one channel: each final speaker's pooled voice print, pitch
  // and utterance count (ids already mapped onto the live ones, so names stay put). Live speakers of the channel left
  // with no utterance and no name are dropped.
  adoptDiarization(noteId, channel, voices) {
    tx(this.db, () => {
      const known = new Map(this.forNote(noteId).map((s) => [s.speakerId, s]));
      for (const v of voices) {
        const old = known.get(v.speakerId);
        this.save(noteId, { speakerId: v.speakerId, channel, centroid: v.centroid || old?.centroid || null, count: v.count, pitch: v.pitch });
      }
      this.db.prepare(`DELETE FROM note_speakers WHERE note_id = ? AND channel = ? AND name = '' AND voice_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM segments s WHERE s.note_id = note_speakers.note_id AND s.speaker_id = note_speakers.speaker_id)`).run(noteId, channel);
    });
    this.bus?.publish('speakers.updated', { noteId });
  }

  // Link unnamed speakers of a note to the saved voices they sound like, each voice to at most one speaker. Speakers the user
  // named are left alone; links made automatically earlier (live, on a few utterances) are judged again on what is known
  // now, so a better voice print can correct a wrong guess. -> number of speakers linked.
  autoMatch(noteId, threshold = MATCH.threshold, opts = {}) {
    const all = this.forNote(noteId);
    const used = new Set(all.filter((s) => s.name).map((s) => s.voiceId).filter(Boolean));
    const free = all.filter((s) => !s.name && s.centroid);
    if (!free.length) return 0;
    const pitchOf = new Map(all.map((s) => [s.speakerId, s.pitch]));
    const voices = this.voices().filter((v) => !used.has(v.id));
    const cands = free.map((s) => ({ id: s.speakerId, centroid: s.centroid, channel: s.channel }));
    const matches = matchVoices(cands, voices, threshold, (s, v) => !(pitchOf.get(s.id) && v.pitch && semitones(pitchOf.get(s.id), v.pitch) > PITCH_VETO), { mu: this.channelMeans(), ...opts });
    let changed = 0;
    for (const s of free) {
      const next = matches.get(s.speakerId)?.voiceId || null;
      if (next === (s.voiceId || null)) continue;
      this.db.prepare('UPDATE note_speakers SET voice_id = ? WHERE note_id = ? AND speaker_id = ?').run(next, noteId, s.speakerId);
      changed++;
    }
    if (changed) this.bus?.publish('speakers.updated', { noteId });
    return matches.size;
  }

  // The average voice of each channel, to centre voice prints on (see cluster.js): the shipped mean pulled towards the
  // distinct voices heard on that channel so far, i.e. every speaker of every note and every saved print. -> channel -> mean
  channelMeans() {
    const per = { mic: [], system: [] };
    for (const r of this.db.prepare('SELECT channel, centroid FROM note_speakers WHERE centroid IS NOT NULL ORDER BY rowid DESC LIMIT 800').all()) if (per[r.channel] && per[r.channel].length < 250) per[r.channel].push(fromBlob(r.centroid));
    for (const r of this.db.prepare("SELECT channel, embedding FROM voice_exemplars WHERE negative = 0 AND channel != ''").all()) if (per[r.channel]) per[r.channel].push(fromBlob(r.embedding));
    const mu = Object.fromEntries(Object.keys(per).map((ch) => [ch, this.adapt ? populationMean(per[ch], this.mean, MATCH.prior[ch]) : this.mean]));
    return (channel) => mu[channel] || this.mean;
  }

  label(noteId, speakerId, channelSpeaker) {
    const r = this.db.prepare('SELECT ns.name, v.name AS voiceName FROM note_speakers ns LEFT JOIN voices v ON v.id = ns.voice_id WHERE ns.note_id = ? AND ns.speaker_id = ?').get(noteId, speakerId);
    return r?.name || r?.voiceName || defaultLabel(speakerId, channelSpeaker);
  }

  // ---- voice profiles ----
  // A profile is its mean (voices.embedding, what older versions read) plus a few voice prints (voice_exemplars): one per
  // kind of sound (a room microphone, a call), so a person who is heard both ways is recognised either way, and prints of
  // voices the user said are not this person.
  voices() {
    const rows = this.db.prepare('SELECT id, name, embedding, samples, pitch, created_at AS createdAt FROM voices ORDER BY name COLLATE NOCASE').all();
    const by = new Map();
    for (const x of this.db.prepare('SELECT id, voice_id AS voiceId, embedding, weight, channel, pitch, negative, source FROM voice_exemplars ORDER BY id').all()) {
      if (!by.has(x.voiceId)) by.set(x.voiceId, []);
      by.get(x.voiceId).push({ id: x.id, embedding: fromBlob(x.embedding), weight: x.weight, channel: x.channel, pitch: x.pitch, negative: !!x.negative, source: x.source });
    }
    return rows.map((v) => ({ ...v, embedding: fromBlob(v.embedding), exemplars: by.get(v.id) || [] }));
  }
  voice(id) { return this.voices().find((v) => v.id === id) || null; }
  voiceByName(name) { return this.voices().find((v) => v.name.toLowerCase() === String(name).toLowerCase()) || null; }

  // Replace a voice's positive prints (rejected ones stay) and refresh the mean and pitch kept on the profile.
  writePrints(voiceId, prints) {
    this.db.prepare('DELETE FROM voice_exemplars WHERE voice_id = ? AND negative = 0').run(voiceId);
    const ins = this.db.prepare('INSERT INTO voice_exemplars(voice_id, embedding, weight, channel, pitch, negative, source, created_at) VALUES(?, ?, ?, ?, ?, 0, ?, ?)');
    let mean = null, w = 0, pw = 0, pitch = 0;
    for (const p of prints) {
      ins.run(voiceId, toBlob(p.embedding), p.weight, p.channel || '', p.pitch || null, p.source || null, Date.now());
      mean = mean ? blend(mean, w, p.embedding, p.weight) : norm(p.embedding);
      w += p.weight;
      if (p.pitch) { pitch += p.pitch * p.weight; pw += p.weight; }
    }
    if (mean) this.db.prepare('UPDATE voices SET embedding = ?, pitch = ? WHERE id = ?').run(toBlob(mean), pw ? pitch / pw : null, voiceId);
  }

  // Add what a speaker sounded like to a saved voice. print: { embedding, weight (seconds), channel, pitch, source }.
  reinforce(voiceId, print, { name, utterances = 1 } = {}) {
    const v = this.voice(voiceId);
    if (!v) return false;
    tx(this.db, () => {
      const known = v.exemplars.filter((x) => !x.negative);
      this.writePrints(voiceId, addPrint(known.length ? known : [{ embedding: v.embedding, weight: (v.samples || 1) * 4, channel: '', pitch: v.pitch, source: null }], print));
      this.db.prepare('UPDATE voices SET name = ?, samples = samples + ?, updated_at = ? WHERE id = ?').run(name || v.name, utterances, Date.now(), voiceId);
    });
    return true;
  }

  // Remember that this voice print is NOT the saved voice (the user corrected an automatic link).
  reject(voiceId, embedding, source) {
    tx(this.db, () => {
      if (source) this.db.prepare('DELETE FROM voice_exemplars WHERE voice_id = ? AND negative = 1 AND source = ?').run(voiceId, source);
      this.db.prepare('INSERT INTO voice_exemplars(voice_id, embedding, weight, channel, pitch, negative, source, created_at) VALUES(?, ?, 1, \'\', NULL, 1, ?, ?)').run(voiceId, toBlob(norm(embedding)), source || null, Date.now());
      this.db.prepare('DELETE FROM voice_exemplars WHERE negative = 1 AND voice_id = ? AND id NOT IN (SELECT id FROM voice_exemplars WHERE negative = 1 AND voice_id = ? ORDER BY id DESC LIMIT ?)').run(voiceId, voiceId, MAX_REJECTS);
    });
  }

  publicVoices() {
    return this.db.prepare(`SELECT v.id, v.name, v.samples, v.created_at AS createdAt, (SELECT COUNT(DISTINCT note_id) FROM note_speakers ns WHERE ns.voice_id = v.id) AS meetings,
      (SELECT COUNT(*) FROM voice_exemplars e WHERE e.voice_id = v.id AND e.negative = 0) AS prints FROM voices v ORDER BY v.name COLLATE NOCASE`).all();
  }
  renameVoice(id, name) { return this.db.prepare('UPDATE voices SET name = ?, updated_at = ? WHERE id = ?').run(String(name).trim(), Date.now(), id).changes > 0; }
  removeVoice(id) { return this.db.prepare('DELETE FROM voices WHERE id = ?').run(id).changes > 0; }
  removeAllVoices() { this.db.prepare('UPDATE note_speakers SET voice_id = NULL').run(); return this.db.prepare('DELETE FROM voices').run().changes; }
}

module.exports = { Speakers, defaultLabel };
