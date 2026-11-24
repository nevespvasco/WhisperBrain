'use strict';
const prompts = require('./prompts');
const retrieve = require('./retrieve');
const ins = require('./insights');
const { fmtClock } = require('../core/notes');

const HISTORY_TURNS = 10;

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
  async summarize(noteId, { templateId, onDelta, onStage, signal } = {}) {
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
        partials.push(await this.llm.complete(prompts.partialMessages({ chunk: chunks[i], index: i, total: chunks.length }), { signal, temperature: 0.1 }));
      }
      transcript = `(The transcript was long; these are condensed notes of each part, in order.)\n\n${partials.map((p, i) => `--- Part ${i + 1} ---\n${p}`).join('\n\n')}`;
    }
    onStage?.({ stage: 'write' });
    const messages = prompts.summaryMessages({ note, transcript, template, userName: this.settings.get('userName') });
    let summary = '';
    for await (const d of this.llm.stream(messages, { signal })) { summary += d; onDelta?.(d); }
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

  // Chat about one note (noteId) or across all notes (noteId = null).
  async chat(noteId, question, { onDelta, signal } = {}) {
    const q = String(question || '').trim();
    if (!q) throw new Error('Empty question');
    const { context, sources } = noteId ? this.noteContext(noteId, q) : this.globalContext(q);
    const history = this.notes.chatHistory(noteId).slice(-HISTORY_TURNS * 2);
    const messages = [
      { role: 'system', content: `${prompts.CHAT_SYSTEM}\n\n<context>\n${context}\n</context>` },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: q },
    ];
    let answer = '';
    for await (const d of this.llm.stream(messages, { signal })) { answer += d; onDelta?.(d); }
    answer = answer.trim();
    if (!answer) throw new Error('The model returned an empty answer.');
    this.notes.addChat(noteId, 'user', q);
    this.notes.addChat(noteId, 'assistant', answer);
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

  globalContext(question) {
    const budget = this.budget();
    const hits = this.notes.search(question, 6, { any: true }).map((h) => h.note);
    const recent = this.notes.list({ limit: 25 });
    const chosen = hits.length ? hits : recent.slice(0, 4);
    const per = Math.floor((budget * 0.8) / Math.max(1, chosen.length));
    const terms = this.knowledge ? this.knowledge.glossary().filter((g) => new RegExp(`\\b${g.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(question)) : [];
    const parts = [];
    if (terms.length) parts.push(`Glossary:\n${terms.map((g) => `- ${g.term}: ${g.definition}`).join('\n')}`);
    parts.push(`Recent meetings (newest first):\n${recent.map((n) => `- ${n.title || '(untitled)'} — ${new Date(n.createdAt).toISOString().slice(0, 10)}`).join('\n')}`);
    for (const n of chosen) {
      const lines = prompts.formatTranscript(this.notes.segments(n.id)).split('\n').filter(Boolean);
      let block = `### ${n.title || '(untitled)'} (${new Date(n.createdAt).toISOString().slice(0, 10)})\n`;
      const head = (n.summary || n.body || '').slice(0, Math.floor(per * 0.5));
      if (head) block += `${head}\n`;
      if (lines.length) {
        const room = per - block.length;
        const wins = retrieve.pick(question, lines, Math.max(500, room));
        block += `Transcript excerpts:\n${wins.map((w) => w.text).join('\n…\n')}`;
      }
      parts.push(block);
    }
    return { context: parts.join('\n\n'), sources: chosen.map((n) => ({ id: n.id, title: n.title })) };
  }
}

module.exports = { AiService };
