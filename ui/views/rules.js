// Rules in plain words. Write a sentence; the AI turns it into a fixed structure that is checked in code; you see it in words and what it would
// have matched in the past; then you save it. A rule can only PROPOSE: whatever it proposes waits in the Inbox for your approval.
import { S, $, api, t, esc, icon, fail, done, empty, confirmDialog } from '../lib.js';

export async function render(main, { alive = () => true } = {}) {
  let draft = null;
  const draw = async () => {
    const rules = await api('GET', '/api/rules');
    if (!alive()) return;   // the user moved on meanwhile (app.js route())
    main.innerHTML = `<div class="page narrow">
      <div class="page-head"><div><h1>${t('Rules')}</h1><div class="sub">${t('Say in a sentence what should happen. A rule can only propose: everything it proposes waits in your Inbox for your approval, so nothing is ever sent by itself.')}</div></div></div>
      <section class="panel mb"><div class="panel-head"><h3>${icon('wand')} ${t('New rule')}</h3></div>
        <textarea id="ru-text" rows="2" placeholder="${esc(t('e.g. {x}', { x: t('When somebody promises me something about the budget, propose a Linear issue') }))}" style="width:100%">${esc(draft?.text || '')}</textarea>
        <div class="row mt-s"><button class="btn primary" data-act="parse" ${S.state?.llmConfigured && draft?.text ? '' : 'disabled'}>${icon('sparkles', 'sm')} ${t('Understand it')}</button>${S.state?.llmConfigured ? '' : `<span class="small muted">${t('Needs an AI model (Settings → AI).')}</span>`}</div>
        ${draft?.error ? `<div class="small mt-s" style="color:var(--danger)">${esc(draft.error)}</div>` : ''}
        ${draft?.spec ? `<div class="card mt-s ai"><div class="xsmall muted"><span class="ai-mark">✦</span> ${t('This is how it was understood')}</div><div class="strong" style="margin:4px 0">${esc(draft.explain)}</div>
          <div class="small muted">${draft.preview.count ? t('It would have applied to {n} of your past promises or decisions, for example:', { n: draft.preview.count }) : t('It would not have applied to anything you accepted so far.')}</div>
          ${draft.preview.examples.map((e) => `<div class="small">• ${esc(e.text)}${e.owner ? ` <span class="muted">· ${esc(e.owner)}</span>` : ''}</div>`).join('')}
          <div class="row mt-s" style="gap:8px"><button class="btn sm primary" data-act="save">${t('Save the rule')}</button><button class="btn sm ghost" data-act="discard">${t('Not what I meant')}</button></div></div>` : ''}</section>
      ${rules.length ? `<div class="stack">${rules.map((r) => `<div class="card" data-id="${r.id}"><div class="row between"><div class="grow"><div class="strong">${esc(r.explain)}</div><div class="xsmall muted">“${esc(r.text)}” · ${r.runs} ${t('times')}</div></div>
        <label class="switch" title="${esc(t('On'))}"><input type="checkbox" data-toggle ${r.enabled ? 'checked' : ''} aria-label="${esc(t('On'))}"><i></i></label><button class="btn xs ghost icon" data-act="remove" aria-label="${esc(t('Delete'))}">${icon('trash', 'sm')}</button></div></div>`).join('')}</div>`
        : `<div class="panel">${empty('wand', t('No rules yet'), t('For example: remind me the day before every promise that has a date.'))}</div>`}</div>`;
  };
  await draw();
  main.onclick = async (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    try {
      if (b.dataset.act === 'parse') {
        const text = $('#ru-text', main).value.trim(); if (!text) { $('#ru-text', main).focus(); return; }
        draft = { text }; b.disabled = true; b.textContent = t('Reading…');
        try { draft = { text, ...(await api('POST', '/api/rules/parse', { text })) }; } catch (err) { draft = { text, error: err.message }; }
        await draw();
      } else if (b.dataset.act === 'save') { await api('POST', '/api/rules', { text: draft.text, spec: draft.spec }); draft = null; done(t('Rule saved')); await draw(); }
      else if (b.dataset.act === 'discard') { draft = null; await draw(); }
      else if (b.dataset.act === 'remove' && await confirmDialog(t('Delete this rule?'))) { await api('DELETE', `/api/rules/${b.closest('[data-id]').dataset.id}`); await draw(); }
    } catch (err) { fail(err); }
  };
  // "Understand it" waits for a sentence (the grey one is only an example); Ctrl+Enter is the same as the button
  main.oninput = (e) => { if (e.target.id === 'ru-text') { const b = $('[data-act="parse"]', main); if (b && S.state?.llmConfigured) b.disabled = !e.target.value.trim(); } };
  main.onkeydown = (e) => { if (e.target.id === 'ru-text' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('[data-act="parse"]', main)?.click(); } };
  main.onchange = async (e) => { if (e.target.matches('[data-toggle]')) { try { await api('PATCH', `/api/rules/${e.target.closest('[data-id]').dataset.id}`, { enabled: e.target.checked }); } catch (err) { fail(err); } } };
}
