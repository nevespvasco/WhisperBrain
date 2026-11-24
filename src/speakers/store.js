'use strict';
const { newId } = require('../core/ids');
const { tx } = require('../core/db');
const { toBlob, fromBlob, blend, norm, mergeClusters, matchVoices } = require('./cluster');
const { semitones } = require('../audio/features');

const PITCH_VETO = 4;   // semitones: two voices this far apart in pitch are never the same person


// Default label for a speaker that has not been named. Channel "mic" ids are m1, m2…; system audio ids are s1, s2…
function defaultLabel(speakerId, channelSpeaker, userName = '') {
  if (!speakerId) return channelSpeaker === 'me' ? (userName || 'Me') : channelSpeaker === 'them' ? 'Them' : channelSpeaker;
  const n = Number(speakerId.slice(1));
  if (speakerId[0] === 'm') return n === 1 ? (userName || 'Me') : `Room speaker ${n}`;
  return `Speaker ${n}`;
}

class Speakers {
  constructor(db, bus) { this.db = db; this.bus = bus; }

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

  // Name a speaker in one note. With remember=true the voice is saved (or reinforced) as a profile, so future
  // meetings recognise this person automatically.
  rename(noteId, speakerId, name, { remember = false } = {}) {
    const sp = this.forNote(noteId).find((s) => s.speakerId === speakerId);
    if (!sp) return null;
    const clean = String(name || '').trim().slice(0, 80);
    let voiceId = sp.voiceId;
    if (remember && clean && sp.centroid) {
      const existing = voiceId ? this.voice(voiceId) : this.voices().find((v) => v.name.toLowerCase() === clean.toLowerCase());
      if (existing) {
        const emb = blend(existing.embedding, existing.samples, sp.centroid, Math.max(1, sp.count));
        const pitch = existing.pitch && sp.pitch ? (existing.pitch * existing.samples + sp.pitch * Math.max(1, sp.count)) / (existing.samples + Math.max(1, sp.count)) : (sp.pitch || existing.pitch || null);
        this.db.prepare('UPDATE voices SET name = ?, embedding = ?, samples = samples + ?, pitch = ?, updated_at = ? WHERE id = ?').run(clean, toBlob(emb), Math.max(1, sp.count), pitch, Date.now(), existing.id);
        voiceId = existing.id;
      } else {
        voiceId = newId();
        this.db.prepare('INSERT INTO voices(id, name, embedding, samples, pitch, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)').run(voiceId, clean, toBlob(norm(sp.centroid)), Math.max(1, sp.count), sp.pitch || null, Date.now(), Date.now());
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
      const seg = this.db.prepare('SELECT speaker FROM segments WHERE id = ? AND note_id = ?').get(segmentId, noteId);
      if (!seg) return false;
      this.db.prepare('INSERT INTO note_speakers(note_id, speaker_id, channel, count) VALUES(?, ?, ?, 0)').run(noteId, speakerId, seg.speaker === 'me' ? 'mic' : 'system');
    }
    const ok = this.db.prepare('UPDATE segments SET speaker_id = ? WHERE id = ? AND note_id = ?').run(speakerId, segmentId, noteId).changes > 0;
    if (ok) this.bus?.publish('speakers.updated', { noteId });
    return ok;
  }

  // Fold speakers that turned out to be the same voice (run when a recording stops).
  consolidate(noteId, threshold = 0.6) {
    const all = this.forNote(noteId).filter((s) => s.centroid);
    const changes = new Map();
    for (const channel of ['mic', 'system']) {
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

  // Link unnamed speakers of a note to saved voices they sound like (each voice used once per note).
  autoMatch(noteId, threshold = 0.65) {
    const all = this.forNote(noteId);
    const used = new Set(all.map((s) => s.voiceId).filter(Boolean));
    const free = all.filter((s) => !s.voiceId && !s.name && s.centroid).map((s) => ({ id: s.speakerId, centroid: s.centroid }));
    if (!free.length) return 0;
    const pitchOf = new Map(all.map((s) => [s.speakerId, s.pitch]));
    const voices = this.voices().filter((v) => !used.has(v.id));
    const matches = matchVoices(free, voices, threshold, (s, v) => !(pitchOf.get(s.id) && v.pitch && semitones(pitchOf.get(s.id), v.pitch) > PITCH_VETO));
    for (const [speakerId, { voiceId }] of matches) this.db.prepare('UPDATE note_speakers SET voice_id = ? WHERE note_id = ? AND speaker_id = ?').run(voiceId, noteId, speakerId);
    if (matches.size) this.bus?.publish('speakers.updated', { noteId });
    return matches.size;
  }

  label(noteId, speakerId, channelSpeaker) {
    const r = this.db.prepare('SELECT ns.name, v.name AS voiceName FROM note_speakers ns LEFT JOIN voices v ON v.id = ns.voice_id WHERE ns.note_id = ? AND ns.speaker_id = ?').get(noteId, speakerId);
    return r?.name || r?.voiceName || defaultLabel(speakerId, channelSpeaker);
  }

  // ---- voice profiles ----
  voices() {
    return this.db.prepare('SELECT id, name, embedding, samples, pitch, created_at AS createdAt FROM voices ORDER BY name COLLATE NOCASE').all()
      .map((v) => ({ ...v, embedding: fromBlob(v.embedding) }));
  }
  voice(id) { return this.voices().find((v) => v.id === id) || null; }
  publicVoices() {
    return this.db.prepare(`SELECT v.id, v.name, v.samples, v.created_at AS createdAt, (SELECT COUNT(DISTINCT note_id) FROM note_speakers ns WHERE ns.voice_id = v.id) AS meetings FROM voices v ORDER BY v.name COLLATE NOCASE`).all();
  }
  renameVoice(id, name) { return this.db.prepare('UPDATE voices SET name = ?, updated_at = ? WHERE id = ?').run(String(name).trim(), Date.now(), id).changes > 0; }
  removeVoice(id) { return this.db.prepare('DELETE FROM voices WHERE id = ?').run(id).changes > 0; }
  removeAllVoices() { this.db.prepare('UPDATE note_speakers SET voice_id = NULL').run(); return this.db.prepare('DELETE FROM voices').run().changes; }
}

module.exports = { Speakers, defaultLabel };
