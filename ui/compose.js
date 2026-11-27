// Write a reply (or a new message) and PROPOSE it: nothing is sent or saved in Gmail until you approve it in the Inbox, where the exact
// text is shown again with any warning (a new recipient, a new link, material from another source).
import { api, t, esc, icon, modal, fail, toast } from './lib.js';

// itemId: a mail thread to reply to. sourceId + to + subject + body: a new message. provenance: sources the text came from (an Ask answer).
export async function composeMail({ itemId = null, sourceId = null, to = [], subject = '', body = '', title = t('Reply'), provenance = [], origin = 'user', canSuggest = !!itemId } = {}) {
  const r = await modal({
    title, wide: true,
    body: `<div class="stack">
      <div class="field"><label for="cm-to">${t('To')}</label><input id="cm-to" value="${esc(to.join(', '))}" placeholder="${itemId ? t('The other person in the thread') : 'name@example.com'}" autocomplete="off"><div class="hint">${t('Leave it empty to reply to the person who wrote last. Addresses you type here are yours: they are not flagged.')}</div></div>
      ${itemId ? '' : `<div class="field"><label for="cm-subject">${t('Subject')}</label><input id="cm-subject" value="${esc(subject)}" autocomplete="off"></div>`}
      <div class="field"><label for="cm-body">${t('Message')}</label><textarea id="cm-body" rows="9">${esc(body)}</textarea></div>
      ${canSuggest ? `<div class="row" style="gap:8px;align-items:end;flex-wrap:wrap"><div class="field grow" style="margin:0;min-width:200px"><label for="cm-hint">${t('What should it say? (optional)')}</label><input id="cm-hint" placeholder="${t('say yes, Friday works')}" autocomplete="off"></div><button class="btn" data-suggest>${icon('sparkles', 'sm')} ${t('Suggest the text')}</button></div><div class="small" id="cm-msg"></div>` : ''}
      <div class="xsmall muted">${t('This only proposes it. You approve it in the Inbox, and nothing leaves before that.')}</div></div>`,
    foot: `<button class="btn" data-close>${t('Cancel')}</button><button class="btn" data-kind="gmail.draft">${t('Propose as a draft')}</button><button class="btn primary" data-kind="gmail.send">${t('Propose to send')}</button>`,
    onMount: (d, close) => {
      const msg = d.querySelector('#cm-msg');
      d.querySelector('[data-suggest]')?.addEventListener('click', async (e) => {
        e.target.closest('button').disabled = true; msg.style.color = ''; msg.textContent = t('Writing…');
        try { const out = await api('POST', '/api/mail/suggest', { itemId, instruction: d.querySelector('#cm-hint').value }); d.querySelector('#cm-body').value = out.text; msg.textContent = ''; }
        catch (err) { msg.style.color = 'var(--danger)'; msg.textContent = err.message; } finally { e.target.closest('button').disabled = false; }
      });
      for (const b of d.querySelectorAll('[data-kind]')) b.onclick = () => {
        const list = d.querySelector('#cm-to').value.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
        close({ kind: b.dataset.kind, to: list, subject: d.querySelector('#cm-subject')?.value || subject, body: d.querySelector('#cm-body').value });
      };
    },
  });
  if (!r) return null;
  try {
    const a = await api('POST', '/api/mail/propose', { kind: r.kind, itemId, sourceId, to: r.to.length ? r.to : undefined, subject: r.subject || undefined, body: r.body, typedRecipients: r.to, provenance, origin });
    toast(a.flags?.length ? t('Proposed, with {n} warning(s). It is waiting in the Inbox.', { n: a.flags.length }) : t('Proposed. It is waiting in the Inbox for your approval.'), { ok: true, actions: [{ label: t('Open the Inbox'), run: () => { location.hash = '#/inbox'; } }] });
    window.dispatchEvent(new Event('wb:refresh'));
    return a;
  } catch (e) { fail(e); return null; }
}
