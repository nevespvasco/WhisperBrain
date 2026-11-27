// Briefings: the user's own material (project notes, an agenda, client or company notes) that the live assistant grounds
// its suggestions on. Added by pasting text or importing a file (PDF, Word, Markdown, text); attached to a meeting from its page.
import { api, t, esc, icon, fail, done, modal, confirmDialog, fmtDate, empty } from '../lib.js';

const KINDS = [['project', 'Project'], ['agenda', 'Agenda'], ['client', 'Client'], ['company', 'Company'], ['notes', 'Notes']];
const kindLabel = (k) => t((KINDS.find(([v]) => v === k) || [k, k])[1]);

export async function render(main) {
  const list = await api('GET', '/api/briefings');
  main.innerHTML = `<div class="page">
    <div class="page-head row between"><div><h1>${t('Briefings')}</h1><p class="muted small" style="margin:4px 0 0">${t('Your own material for the live assistant: suggestions only use facts found here and in the conversation. It stays on this computer.')}</p></div>
      <div class="row"><label class="btn">${icon('upload', 'sm')} ${t('Import file')}<input type="file" id="br-file" accept=".pdf,.docx,.md,.markdown,.txt,.html,.htm" hidden></label><button class="btn primary" data-act="new">${icon('plus', 'sm')} ${t('New briefing')}</button></div></div>
    ${list.length ? `<div class="list">${list.map((b) => `<div class="li">
        <div class="grow" style="min-width:0"><div class="main-t">${icon('doc', 'sm')} ${esc(b.title || t('Untitled'))} <span class="badge">${esc(kindLabel(b.kind))}</span></div>
          <div class="xsmall muted">${fmtDate(b.updatedAt)} · ${Math.max(1, Math.round(b.size / 1000))} k ${t('characters')}${b.terms?.length ? ` · ${esc(b.terms.slice(0, 8).join(', '))}` : ''}</div></div>
        <button class="btn xs" data-edit="${esc(b.id)}">${t('Edit')}</button><button class="btn xs danger-outline" data-del="${esc(b.id)}">${t('Delete')}</button></div>`).join('')}</div>`
      : empty('doc', t('No briefings yet'), t('Import or paste project notes, an agenda, or client or company notes. Then attach them to a meeting from the meeting page.'))}
  </div>`;
  bind(main);
}

// also used by a meeting's assistant panel, to write or edit a briefing without leaving the meeting
export function editor(b = {}) {
  return modal({
    title: b.id ? t('Edit briefing') : t('New briefing'), wide: true,
    body: `<form class="stack" id="br-form">
      <div class="row"><input id="br-title" class="grow" placeholder="${esc(t('Title'))}" value="${esc(b.title || '')}"><select id="br-kind">${KINDS.map(([v, l]) => `<option value="${v}" ${v === (b.kind || 'notes') ? 'selected' : ''}>${esc(t(l))}</option>`).join('')}</select></div>
      <textarea id="br-text" rows="16" placeholder="${esc(t('Paste the text here…'))}">${esc(b.text || '')}</textarea></form>`,
    foot: `<button class="btn" data-close>${t('Cancel')}</button><button class="btn primary" data-ok>${t('Save')}</button>`,
    onMount: (d, close) => {
      d.querySelector('[data-ok]').onclick = () => close({ title: d.querySelector('#br-title').value.trim(), kind: d.querySelector('#br-kind').value, text: d.querySelector('#br-text').value });
      d.querySelector('#br-title').focus();
    },
  });
}

function bind(main) {
  const rerender = () => render(main);
  main.onclick = async (e) => {   // assigned, not added: main outlives this page
    const b = e.target.closest('button');
    if (!b) return;
    try {
      if (b.dataset.act === 'new') {
        const v = await editor();
        if (!v) return;
        await api('POST', '/api/briefings', v);
        done(t('Saved')); rerender();
      } else if (b.dataset.edit) {
        const v = await editor(await api('GET', `/api/briefings/${encodeURIComponent(b.dataset.edit)}`));
        if (!v) return;
        await api('PATCH', `/api/briefings/${encodeURIComponent(b.dataset.edit)}`, v);
        done(t('Saved')); rerender();
      } else if (b.dataset.del) {
        if (!(await confirmDialog(t('Delete this briefing? Meetings it is attached to lose it.')))) return;
        await api('DELETE', `/api/briefings/${encodeURIComponent(b.dataset.del)}`);
        rerender();
      }
    } catch (err) { fail(err); }
  };
  main.querySelector('#br-file')?.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      await api('POST', `/api/briefings/import?name=${encodeURIComponent(f.name)}`, await f.arrayBuffer());
      done(t('Imported')); rerender();
    } catch (err) { fail(err); }
  });
}
