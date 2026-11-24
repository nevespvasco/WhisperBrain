// Chat with one meeting, or across all of them (answers link back to their source meetings).
import { S, $, $$, api, t, esc, icon, fail } from '../lib.js';
import { stream } from '../api.js';
import { renderMarkdown } from '../md.js';

const bubble = (m) => `<div class="bubble ${m.role}">${m.role === 'user' ? esc(m.content) : renderMarkdown(m.content)}</div>`;

export function renderChat(root, history, { noteId, suggestions, placeholder }) {
  root.innerHTML = `<div class="chat" id="chatlog">${history.map(bubble).join('')}</div>
    ${history.length ? '' : `<div class="chips mt-s" id="chat-sugg">${suggestions.map((q) => `<button class="chip" data-q="${esc(q)}">${icon('sparkles', 'sm')}${esc(q)}</button>`).join('')}</div>`}
    ${!S.state?.llmConfigured ? `<div class="banner mt-s small">${icon('sparkles')}<div class="grow">${t('Chat needs an AI model (Ollama or any OpenAI-compatible server).')}</div><a class="btn xs" href="#/settings/ai">${t('Set up AI')}</a></div>` : ''}
    <form class="chat-input" id="chatform"><textarea rows="1" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}"></textarea>
      ${history.length ? `<button class="btn ghost icon" type="button" data-clear="1" title="${t('Clear chat')}" aria-label="${t('Clear chat')}">${icon('trash', 'sm')}</button>` : ''}<button class="btn primary icon" type="submit" aria-label="${t('Send')}">${icon('arrowright')}</button></form>`;
  const form = $('#chatform', root), ta = $('textarea', form);
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(200, ta.scrollHeight) + 'px'; };
  ta.addEventListener('input', grow);
  const send = async (q) => {
    if (!q.trim() || S.streaming) return;
    const log = $('#chatlog', root);
    $('#chat-sugg', root)?.remove();
    log.insertAdjacentHTML('beforeend', bubble({ role: 'user', content: q }));
    const out = document.createElement('div'); out.className = 'bubble assistant typing'; log.append(out);
    ta.value = ''; grow();
    let text = '';
    S.streaming = { chat: true };
    const scroller = document.getElementById('main');
    try {
      const res = await stream('/api/chat', { noteId, question: q }, { onDelta: (d) => { text += d; out.innerHTML = renderMarkdown(text); scroller.scrollTop = scroller.scrollHeight; } });
      out.classList.remove('typing');
      if (res?.sources?.length && !noteId) out.insertAdjacentHTML('beforeend', `<div class="sources">${res.sources.map((s) => `<a class="chip" href="#/note/${s.id}">${icon('link', 'sm')}${esc(s.title || t('Untitled meeting'))}</a>`).join('')}</div>`);
      history.push({ role: 'user', content: q }, { role: 'assistant', content: text });
    } catch (e) { out.remove(); fail(e); } finally { S.streaming = null; }
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); send(ta.value); });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(ta.value); } });
  root.addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-q]');
    if (chip) send(chip.dataset.q);
    if (e.target.closest('[data-clear]')) { await api('DELETE', `/api/chat${noteId ? `?noteId=${noteId}` : ''}`); history.length = 0; renderChat(root, history, { noteId, suggestions, placeholder }); }
  });
}

export async function render(main) {
  const history = await api('GET', '/api/chat');
  main.innerHTML = `<div class="page narrow"><div class="page-head"><div><h1>${t('Ask AI')}</h1><div class="sub">${t('Questions across every meeting — answers cite the meetings they come from.')}</div></div></div><div class="panel" id="gchat"></div></div>`;
  renderChat($('#gchat'), history, { noteId: null, suggestions: [t('What did we decide this week?'), t('Open action items across meetings'), t('What did customers ask for?'), t('Which topics keep coming up?'), t('Summarise everything about pricing')], placeholder: t('Ask across all your meetings…') });
  void $$;
}
