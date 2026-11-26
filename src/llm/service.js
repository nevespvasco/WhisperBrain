'use strict';
const prompts = require('./prompts');
const retrieve = require('./retrieve');
const ins = require('./insights');
const { fmtClock } = require('../core/notes');
const { isLanguage } = require('./languages');
const { chatScope } = require('./scope');

const HISTORY_TURNS = 10;
// Across all meetings each question brings its own meetings: older turns are kept only so a follow-up makes sense, and fewer of
// them keep a small local model from answering an earlier question again
const GLOBAL_HISTORY_TURNS = 3;
// Output caps for the enhanced notes: the condensed notes of one part, and the final notes
const PARTIAL_MAX_TOKENS = 1024;
const SUMMARY_MAX_TOKENS = 4096;

// Keeps the first copy of each longer line: what is left of a model's repetition loop after the token cap
// (short lines such as '- None' may rightly repeat under different headings)
function dropRepeatedLines(text) {
  const seen = new Set();
  return text.split('\n').filter((l) => {
    const k = l.trim().toLowerCase();
    if (k.length < 12 || !/[\p{L}\p{N}]/u.test(k)) return true;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

class AiService {
  constructor({ notes, templates, settings, llm, bus, knowledge }) { Object.assign(this, { notes, templates, settings, llm, bus, knowledge }); }

  configured() { return !!this.settings.get('llm').baseUrl; }

  // Topics, glossary terms, action items and the structured overview for one meeting. Uses the LLM when one is
  // configured and reachable; otherwise (or if it fails) falls back to offline extraction so the knowledge
  // layer still fills up. Returns { insights, topics, actions, glossary, mode: 'llm' | 'local' }.
  async insights(noteId, { signal, local = false } = {}) {
    const note = this.notes.get(noteId);
    if (!note) throw new Error('Note not found');
    const k = this.knowledge;
    let data = null, mode = 'local', error = null;
    if (!local && this.configured()) {
      try {
        const budget = this.budget();
        let transcript = prompts.formatTranscript(this.notes.segments(noteId));
        if (transcript.length > budget) {
          const lines = transcript.split('\n');
          transcript = retrieve.pick(note.title + ' ' + note.body + ' ' + note.summary, lines, Math.floor(budget * 0.7)).map((w) => w.text).join('\n…\n');
        }
        const messages = ins.insightsMessages({ note, transcript, existingTopics: k.topics({ limit: 120 }).map((t) => t.name), existingTerms: k.glossary().map((g) => g.term), userName: this.settings.get('userName') });
        data = ins.parseInsights(await this.llm.complete(messages, { signal, temperature: 0.1 }));
        if (data) mode = 'llm';
        else error = 'The model did not return valid JSON; used offline extraction instead.';
      } catch (e) {
        if (signal?.aborted) throw e;
        error = e.message;
      }
    }
    if (!data) data = ins.localInsights(note);
    const topics = data.topics.length ? k.setNoteTopics(noteId, data.topics) : k.autoTopics(noteId);
    for (const g of data.glossary) { try { k.upsertTerm({ ...g, noteId, auto: true }); } catch { /* skip bad term */ } }
    const actions = k.replaceAutoActions(noteId, data.actionItems);
    const { topics: _t, glossary: _g, actionItems: _a, ...rest } = data;
    const stored = { ...rest, mode, generatedAt: Date.now() };
    this.notes.update(noteId, { insights: stored });
    this.bus?.publish('note.insights', { id: noteId, mode });
    return { insights: stored, topics, actions, glossary: data.glossary, mode, warning: error };
  }

  // Cross-meeting synthesis of one topic (streamed).
  async topicBrief(topicId, { onDelta, signal } = {}) {
    const t = this.knowledge.topic(topicId);
    if (!t) throw new Error('Topic not found');
    const budget = this.budget();
    const parts = [];
    for (const n of [...t.notes].reverse()) {
      const quotes = t.quotes.filter((q) => q.noteId === n.id).slice(0, 8).map((q) => `- ${q.label} [${fmtClock(q.startMs)}]: ${q.text}`);
      parts.push(`### ${n.title || '(untitled)'} — ${new Date(n.createdAt).toISOString().slice(0, 10)}\n${n.topicSummary || ''}\n${quotes.join('\n')}`);
    }
    let items = parts.join('\n\n');
    if (items.length > budget) items = items.slice(items.length - budget);
    if (!items.trim()) throw new Error('No meetings discuss this topic yet.');
    let out = '';
    for await (const d of this.llm.stream(ins.topicBriefMessages({ topic: t, items }), { signal })) { out += d; onDelta?.(d); }
    out = out.trim();
    if (out) this.knowledge.updateTopic(topicId, { description: out.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.slice(0, 600) || '' });
    return { text: out };
  }

  budget() { return Math.max(2000, this.settings.get('llm').contextChars); }

  // Generates (and stores) the enhanced notes. Long transcripts are reduced chunk by chunk first.
  // language: write the notes in it (an ISO code); left out, the language chosen in Settings → Translation (when translation is on),
  // else the language of the meeting
  async summarize(noteId, { templateId, onDelta, onStage, signal, language } = {}) {
    const note = this.notes.get(noteId);
    if (!note) throw new Error('Note not found');
    const template = this.templates.get(templateId || note.templateId || this.settings.get('defaultTemplate')) || this.templates.get('general');
    const segments = this.notes.segments(noteId);
    if (!note.body.trim() && !segments.length) throw new Error('Nothing to summarize yet: add notes or record a transcript first.');
    const budget = this.budget();
    let transcript = prompts.formatTranscript(segments);
    if (transcript.length > budget) {
      const chunks = prompts.chunkText(transcript, Math.floor(budget * 0.8));
      const partials = [];
      for (let i = 0; i < chunks.length; i++) {
        onStage?.({ stage: 'reduce', index: i + 1, total: chunks.length });
        // Capped: a small local model can fall into a repetition loop and, with context shifting on, never stop by itself
        const part = await this.llm.complete(prompts.partialMessages({ chunk: chunks[i], index: i, total: chunks.length }), { signal, temperature: 0.1, maxTokens: PARTIAL_MAX_TOKENS, frequencyPenalty: 0.3 });
        partials.push(dropRepeatedLines(part));
      }
      transcript = `(The transcript was long; these are condensed notes of each part, in order.)\n\n${partials.map((p, i) => `--- Part ${i + 1} ---\n${p}`).join('\n\n')}`;
    }
    onStage?.({ stage: 'write' });
    const tr = this.settings.get('translation');
    const wanted = language ?? (tr.enabled ? tr.notesLanguage : '');
    const messages = prompts.summaryMessages({ note, transcript, template, userName: this.settings.get('userName'), language: isLanguage(wanted) ? wanted : '' });
    let summary = '';
    for await (const d of this.llm.stream(messages, { signal, maxTokens: SUMMARY_MAX_TOKENS })) { summary += d; onDelta?.(d); }
    summary = summary.trim();
    if (!summary) throw new Error('The model returned an empty summary.');
    this.notes.update(noteId, { summary, templateId: template.id });
    if (!note.title.trim()) await this.autoTitle(noteId, { summary, transcript, signal }).catch(() => {});
    return this.notes.get(noteId);
  }

  async autoTitle(noteId, { summary, transcript, signal } = {}) {
    const note = this.notes.get(noteId);
    if (!note) return null;
    let title = await this.llm.complete(prompts.titleMessages({ note, summary: summary ?? note.summary, transcript: transcript ?? '' }), { signal, temperature: 0.2, maxTokens: 40 });
    title = title.split('\n')[0].replace(/^["'#*\s]+|["'.\s]+$/g, '').slice(0, 100);
    if (title) return this.notes.update(noteId, { title });
    return note;
  }

  // Pieces of text from meetings and notes that may answer the question, numbered for citing. A private source is left out when the AI
  // server is not on this computer. `skip`: meetings whose whole text is already in the context.
  async excerpts(question, { skip = new Set(), limit = 6 } = {}) {
    if (!this.index) return [];
    try {
      const hits = await this.index.search(question, { limit: limit + skip.size, allow: (k, id) => (k !== 'note' || !skip.has(id)) && (this.mayShare ? this.mayShare(k, id) : true) });
      return hits.slice(0, limit).map((h, i) => ({ ...h, n: i + 1 }));
    } catch { return []; }
  }

  excerptContext(list) {
    if (!list.length) return '';
    const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');
    return `Excerpts that may be relevant. Cite one as [n] when a statement rests on it:\n${list.map((e) => `[${e.n}] ${e.kind === 'note' ? 'Meeting' : 'Note'} “${e.title || 'untitled'}”${day(e.at) ? ` (${day(e.at)})` : ''}:\n${e.text.slice(0, 900)}`).join('\n\n')}`;
  }

  // Only the numbers that were given may be cited: any other [n] is removed. -> { answer, cited: [excerpt] } in the order first cited
  validateCitations(answer, list) {
    const byN = new Map(list.map((e) => [e.n, e]));
    const cited = [];
    const text = answer.replace(/\s?\[(\d{1,3})\]/g, (m, d) => {
      const e = byN.get(Number(d));
      if (!e) return '';                                      // an invented number: dropped
      if (!cited.includes(e)) cited.push(e);
      return m;
    });
    return { answer: text, cited };
  }

  // Chat about one note (noteId) or across all notes (noteId = null).
  async chat(noteId, question, { onDelta, signal } = {}) {
    const q = String(question || '').trim();
    if (!q) throw new Error('Empty question');
    let { context, sources } = noteId ? this.noteContext(noteId, q) : this.globalContext(q);
    let ex = [];
    if (!noteId) {
      ex = await this.excerpts(q, { skip: new Set(sources.map((s) => s.id)) });
      const extra = this.excerptContext(ex);
      if (extra) context += `\n\n${extra}`;
    }
    const history = this.notes.chatHistory(noteId).slice(-(noteId ? HISTORY_TURNS : GLOBAL_HISTORY_TURNS) * 2);
    const messages = prompts.chatMessages({ history, question: q, context });
    let answer = '';
    for await (const d of this.llm.stream(messages, { signal })) { answer += d; onDelta?.(d); }
    answer = answer.trim();
    if (!answer) throw new Error('The model returned an empty answer.');
    const checked = this.validateCitations(answer, ex);
    answer = checked.answer;
    // what the answer rests on: the meetings it was about, then the excerpts it cited (each with its number and where to open it)
    sources = [...sources, ...checked.cited.map((e) => ({ id: e.id, kind: e.kind === 'note' ? 'meeting' : 'item', title: e.title, n: e.n, segmentId: e.segmentId, startMs: e.startMs, uri: e.uri || undefined }))];
    this.notes.addChat(noteId, 'user', q);
    this.notes.addChat(noteId, 'assistant', answer, noteId ? null : sources);
    return { answer, sources };
  }

  noteContext(noteId, question) {
    const note = this.notes.get(noteId);
    if (!note) throw new Error('Note not found');
    const budget = this.budget();
    const parts = [prompts.meetingHeader(note)];
    if (note.summary) parts.push(`## Enhanced notes\n${note.summary.slice(0, Math.floor(budget * 0.25))}`);
    if (note.body.trim()) parts.push(`## The user's own notes\n${note.body.slice(0, Math.floor(budget * 0.15))}`);
    const used = parts.join('\n\n').length;
    const lines = prompts.formatTranscript(this.notes.segments(noteId)).split('\n').filter(Boolean);
    if (lines.length) {
      const full = lines.join('\n');
      const room = Math.max(1000, budget - used);
      if (full.length <= room) parts.push(`## Transcript\n${full}`);
      else {
        const wins = retrieve.pick(question, lines, room);
        parts.push(`## Transcript (excerpts most relevant to the question; ${wins.length} of the meeting's parts)\n${wins.map((w) => w.text).join('\n…\n')}`);
      }
    }
    return { context: parts.join('\n\n'), sources: [{ id: note.id, title: note.title }] };
  }

  // The meetings a question across all meetings is about (src/llm/scope.js): "the last meeting" / "this week" pick them by date,
  // the words left over search their text. Sources are only meetings that were picked for the question; when nothing matched,
  // the model gets the list of recent meetings (titles and dates) and says so, instead of guessing from unrelated ones.
  globalContext(question, now = Date.now()) {
    const budget = this.budget();
    const scope = chatScope(question, now);
    const hasContent = (n) => !!(n.summary.trim() || n.body.trim() || this.notes.hasSegments(n.id));
    const recent = this.notes.list({ limit: 40 }).filter(hasContent);
    const hits = scope.terms ? this.notes.search(scope.terms, 8, { any: true }).map((h) => h.note).filter(hasContent) : [];
    const hitIds = new Set(hits.map((n) => n.id));
    let chosen, why;
    if (scope.latest) {
      // "the last meeting about pricing": the newest meetings that match, else just the newest
      const pool = scope.terms && hits.length ? recent.filter((n) => hitIds.has(n.id)) : recent;
      chosen = (pool.length ? pool : recent).slice(0, scope.latest);
      why = scope.latest === 1 ? 'the most recent meeting' : `the ${chosen.length} most recent meetings`;
    } else if (scope.when) {
      const inRange = recent.filter((n) => n.createdAt >= scope.when.from && n.createdAt < scope.when.to);
      const matching = inRange.filter((n) => hitIds.has(n.id));
      chosen = (matching.length ? matching : inRange).slice(0, 6);
      why = `meetings from ${scope.when.label}`;
    } else if (hits.length) { chosen = hits.slice(0, 6); why = 'meetings that mention the question\'s words'; }
    else if (!scope.terms) { chosen = recent.slice(0, 4); why = 'the most recent meetings'; }
    else { chosen = []; why = ''; }

    const day = (ms) => new Date(ms).toISOString().slice(0, 10);
    const when = (n) => { const d = new Date(n.startedAt || n.createdAt); return `${day(d.getTime())} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
    const terms = this.knowledge ? this.knowledge.glossary().filter((g) => new RegExp(`\\b${g.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(question)) : [];
    const parts = [];
    if (terms.length) parts.push(`Glossary:\n${terms.map((g) => `- ${g.term}: ${g.definition}`).join('\n')}`);
    parts.push(`All recent meetings (newest first):\n${recent.slice(0, 25).map((n, i) => `- ${n.title || '(untitled)'} — ${when(n)}${i === 0 ? ' (the most recent)' : ''}`).join('\n') || '- (none yet)'}`);
    if (!chosen.length) {
      parts.push(scope.when ? `No meeting was recorded ${scope.when.label}.` : 'No meeting mentions what the question asks about. Say so plainly; do not answer from other meetings.');
      return { context: parts.join('\n\n'), sources: [] };
    }
    parts.push(`The question is about ${why}; their content follows.`);
    const per = Math.floor((budget * 0.85) / chosen.length);
    for (const n of chosen) {
      let block = `### ${n.title || '(untitled)'} (${when(n)})\n`;
      const notes = [n.summary.trim() && `Enhanced notes:\n${n.summary.trim()}`, n.body.trim() && `The user's own notes:\n${n.body.trim()}`].filter(Boolean).join('\n\n');
      if (notes) block += `${notes.slice(0, Math.floor(per * (scope.terms ? 0.4 : 0.5)))}\n`;
      const lines = prompts.formatTranscript(this.notes.segments(n.id)).split('\n').filter(Boolean);
      if (lines.length) {
        const room = Math.max(500, per - block.length);
        const full = lines.join('\n');
        if (full.length <= room) block += `Transcript:\n${full}`;
        // a summary of a whole meeting wants all of it, so with no words to look for the excerpts are spread over the meeting
        else block += `Transcript excerpts:\n${retrieve.pick(scope.terms || '', lines, room).map((w) => w.text).join('\n…\n')}`;
      }
      parts.push(block);
    }
    return { context: parts.join('\n\n'), sources: chosen.map((n) => ({ id: n.id, title: n.title })) };
  }
}

module.exports = { AiService, dropRepeatedLines };
