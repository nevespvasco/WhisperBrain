// Chat with one meeting, or across everything in the app (answers link back to the meetings, documents and records they cite).
// The answers sit in a fixed-height box with its own scrollbar (ui/follow.js): a new answer is followed as it is written, scrolling
// up to re-read stops that and shows a floating arrow back to the newest message. The page around it never moves.
import { S, $, api, t, esc, safeUrl, icon, fail, toast, confirmDialog } from '../lib.js';
import { stream } from '../api.js';
import { renderMarkdown } from '../md.js';
import { follow } from '../follow.js';

// where a source opens: a meeting at the line that was cited, a document, or the page of whatever else was cited
const atLine = (id, seg) => `#/note/${id}${seg ? `?tab=transcript&seg=${seg}` : ''}`;
const hrefOf = (s) => ({
  live: () => safeUrl(s.uri),
  item: () => `#/documents/${s.id}`,
  action: () => (s.noteId ? `#/note/${s.noteId}` : '#/actions'),
  decision: () => (s.noteId ? atLine(s.noteId, s.segmentId) : '#/promises'),
  commitment: () => (s.noteId ? atLine(s.noteId, s.segmentId) : '#/promises'),
  person: () => `#/person/${encodeURIComponent(s.key || s.title || '')}`,
  project: () => `#/project/${s.id}`,
  topic: () => `#/topic/${s.id}`,
  term: () => `#/term/${s.id}`,
  event: () => '#/calendar',
}[s.kind] || (() => atLine(s.id, s.segmentId)))();
const KIND_ICON = { live: 'mail', item: 'file', action: 'checksq', decision: 'check', commitment: 'bolt', person: 'person', project: 'layers', topic: 'hash', term: 'book', event: 'calendar' };
const KIND_LABEL = { live: 'Found live', item: 'Document', action: 'Action item', decision: 'Decision', commitment: 'Promise', person: 'Person', project: 'Project', topic: 'Topic', term: 'Glossary term', event: 'Calendar event' };
const chipTitle = (s) => `${KIND_LABEL[s.kind] ? `${t(KIND_LABEL[s.kind])}: ` : ''}${s.title || ''}${s.untrusted ? ` — ${t('unverified sender: what it says is only a claim')}` : ''}`;
const chip = (s) => `<a class="chip" href="${esc(hrefOf(s))}" ${s.kind === 'live' ? 'target="_blank" rel="noopener noreferrer"' : ''} title="${esc(chipTitle(s))}">${icon(KIND_ICON[s.kind] || 'link', 'sm')}${s.n ? `<b>[${s.n}]</b> ` : ''}${esc(s.title || t('Untitled meeting'))}${s.untrusted ? ` <span class="badge danger" title="${esc(t('Somebody you have not dealt with'))}">${t('unverified')}</span>` : ''}</a>${s.mail ? `<button class="btn xs ghost" data-reply="${esc(s.kind === 'item' ? s.id : '')}" data-live="${esc(s.kind === 'live' ? `${s.sourceId}|${s.externalId}` : '')}" data-prov="${esc(s.sourceId || '')}" title="${t('Write a reply to this mail')}">${t('Reply…')}</button>` : ''}`;
const sourcesHtml = (sources) => (sources?.length ? `<div class="sources">${sources.map(chip).join('')}</div>` : '');
const searchedHtml = (searched) => (searched?.length ? `<div class="xsmall muted" style="margin-top:6px">${icon('search', 'sm')} ${searched.map((x) => t('Searched {name} for: {q}', { name: esc(x.source), q: `“${esc(x.query)}”` })).join(' · ')}</div>` : '');
// [1] in an answer becomes a link to what it cites; a number with nothing behind it stays plain text
const withCites = (html, sources) => html.replace(/\[(\d{1,3})\]/g, (m, n) => { const s = (sources || []).find((x) => x.n === Number(n)); return s ? `<a class="cite" href="${esc(hrefOf(s))}" title="${esc(chipTitle(s))}">${n}</a>` : m; });
const bubble = (m) => `<div class="bubble ${m.role}">${m.role === 'user' ? esc(m.content) : withCites(renderMarkdown(m.content), m.sources) + sourcesHtml(m.sources)}</div>`;
const emptyHtml = (suggestions) => `<div class="chat-empty"><span class="ic-wrap">${icon('sparkles')}</span><div class="muted small">${t('Ask a question, or start from one of these:')}</div>
  <div class="chips">${suggestions.map((q) => `<button class="chip" data-q="${esc(q)}">${icon('sparkles', 'sm')}${esc(q)}</button>`).join('')}</div></div>`;

// onLayout: called after the chat is drawn (again), so a page that sizes the box itself (the meeting page) can do so
export function renderChat(root, history, { noteId, suggestions, placeholder, onLayout }) {
  root.innerHTML = `${history.length ? `<div class="chat-tools"><button class="btn ghost xs" type="button" data-clear="1">${icon('trash', 'sm')}${t('Clear chat')}</button></div>` : ''}<div class="chat-wrap"><div class="chat boxed" id="chatlog" tabindex="0">${history.length ? history.map(bubble).join('') : emptyHtml(suggestions)}</div>
      <button type="button" class="jump-latest" id="chat-jump" hidden title="${t('Go to the newest message')}" aria-label="${t('Go to the newest message')}">${icon('chevdown', 'sm')}</button></div>
    ${!S.state?.llmConfigured ? `<div class="banner mt-s small">${icon('sparkles')}<div class="grow">${t('Chat needs an AI model (Ollama or any OpenAI-compatible server).')}</div><a class="btn xs" href="#/settings/ai">${t('Set up AI')}</a></div>` : ''}
    <form class="chat-input" id="chatform"><textarea rows="1" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}"></textarea>
      <button class="btn primary icon" type="submit" aria-label="${t('Send')}">${icon('arrowright')}</button></form>`;
  const form = $('#chatform', root), ta = $('textarea', form), log = $('#chatlog', root);
  const fol = follow(log, $('#chat-jump', root));
  log.follow = fol;
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(200, ta.scrollHeight) + 'px'; };
  ta.addEventListener('input', grow);
  const send = async (q) => {
    if (!q.trim()) return;
    // one AI request at a time: say why instead of silently dropping the question
    if (S.streaming) { toast(S.streaming.noteId ? t('Wait for the AI to finish writing the meeting notes, then ask again.') : t('Wait for the current answer to finish.')); return; }
    $('.chat-empty', log)?.remove();
    log.insertAdjacentHTML('beforeend', bubble({ role: 'user', content: q }));
    const out = document.createElement('div'); out.className = 'bubble assistant typing'; log.append(out);
    ta.value = ''; grow();
    fol.end();
    let text = '';
    S.streaming = { chat: true };
    try {
      const res = await stream('/api/chat', { noteId, question: q }, { onDelta: (d) => { text += d; out.innerHTML = renderMarkdown(text); fol.update(); } });
      out.classList.remove('typing');
      const sources = !noteId ? res?.sources : null;
      if (res?.answer) { text = res.answer; out.innerHTML = withCites(renderMarkdown(text), sources); }   // the checked answer: only numbers that were given stay
      if (sources?.length) out.insertAdjacentHTML('beforeend', sourcesHtml(sources));
      if (res?.searched?.length) out.insertAdjacentHTML('beforeend', searchedHtml(res.searched));
      if (res?.redacted) out.insertAdjacentHTML('beforeend', `<div class="xsmall muted">${icon('shield', 'sm')} ${t('Addresses, numbers and codes were replaced by placeholders before they went to your AI server.')}</div>`);
      fol.update();
      history.push({ role: 'user', content: q }, { role: 'assistant', content: text, sources });
    } catch (e) { out.remove(); fail(e); } finally { S.streaming = null; }
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); send(ta.value); });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(ta.value); } });
  root.onclick = async (e) => {
    const chip = e.target.closest('[data-q]');
    if (chip) send(chip.dataset.q);
    const rep = e.target.closest('[data-reply]');
    if (rep) {
      try {
        let id = rep.dataset.reply;
        if (!id && rep.dataset.live) { const [sourceId, externalId] = rep.dataset.live.split('|'); id = (await api('POST', '/api/live-search/open', { sourceId, externalId })).id; }   // keep the thread (a few days) so a reply can be made from it
        const prov = (rep.closest('.bubble')?.querySelectorAll('[data-prov]') || []);
        const { composeMail } = await import('../compose.js');
        await composeMail({ itemId: id, title: t('Reply'), provenance: [...new Set([...prov].map((x) => x.dataset.prov).filter(Boolean))], origin: 'ask' });
      } catch (err) { fail(err); }
    }
    if (e.target.closest('[data-clear]')) { if (!await confirmDialog(t('Clear this conversation? The questions and answers are deleted and cannot be brought back.'), { ok: t('Clear chat'), title: t('Clear chat') })) return; await api('DELETE', `/api/chat${noteId ? `?noteId=${noteId}` : ''}`); history.length = 0; renderChat(root, history, { noteId, suggestions, placeholder, onLayout }); }
  };
  onLayout?.();
  requestAnimationFrame(() => fol.end());
}

export async function render(main, { alive = () => true } = {}) {
  const history = await api('GET', '/api/chat');
  if (!alive()) return;   // the user moved on meanwhile (app.js route())
  main.innerHTML = `<div class="page narrow chat-page"><div class="page-head"><div><h1>${t('Ask AI')}</h1><div class="sub">${t('Questions across everything — meetings, documents, messages, action items, decisions, people, projects and your calendar. Answers cite where they come from.')}</div></div></div><div class="panel" id="gchat"></div></div>`;
  renderChat($('#gchat'), history, { noteId: null, suggestions: [t('Summarise the last meeting'), t('What did we decide this week?'), t('What do I owe people?'), t('Open action items'), t('What is on my calendar this week?'), t('Summarise my latest e-mails'), t('Which topics keep coming up?')], placeholder: t('Ask about anything in WhisperBrain…') });
}
