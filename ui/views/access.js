// Access & privacy: every account and source with what it may do, what has been read, where copies live, what to review, who was forgotten,
// and what happened (docs/access.md). Lives under the Setup door.
import { S, $, api, t, esc, icon, fail, done, debounce, empty, confirmDialog, modal, fmtDate, pickFrom } from '../lib.js';
import { openAccessSheet, grantSummary, connectGoogle, scopeWords } from '../access-sheet.js';

let onEvent = null;
const when = (ms) => (ms ? fmtDate(ms, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : t('never'));
const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const OPS = { 'live.search': 'Live search sent', 'live.open': 'A result was opened', 'action.run': 'Action run', 'grant.changed': 'Access changed', 'grant.revoked': 'Access revoked' };

export async function render(main, { alive = () => true } = {}) {
  const draw = async () => {
    const [ov, log, people] = await Promise.all([api('GET', '/api/access'), api('GET', '/api/access-log?limit=40'), api('GET', '/api/people').catch(() => [])]);
    if (!alive()) return;   // the user moved on meanwhile (app.js route())
    const byId = new Map(ov.sources.map((s) => [s.id, s]));
    main.innerHTML = `<div class="page">
      <div class="page-head"><div><h1>${t('Access & privacy')}</h1><div class="sub">${t('What each connected service may do, what has been read from it, and where copies of it are. Narrowing an access forgets what is no longer allowed straight away.')}</div></div></div>
      ${ov.notice ? `<div class="banner mb">${icon('shield')}<div class="grow"><b>${t('Your connected sources now have an access setting')}</b><div class="small muted">${ov.notice.map((n) => `${esc(n.name)}: ${esc(grantSummary(n))}`).join(' · ')}</div><div class="xsmall muted">${t('Nothing changed in what they do. Change any of them below.')}</div></div><button class="btn sm primary" data-act="notice">${t('Got it')}</button></div>` : ''}
      ${ov.review.map((r) => `<div class="banner warn mb">${icon('clock')}<div class="grow"><b>${esc(r.name)}</b><div class="small muted">${t('Nobody has looked at this access for {n} days. Is it still what you want?', { n: r.days })}</div></div><button class="btn sm" data-review="${r.id}">${t('It is right')}</button><button class="btn sm primary" data-edit="${r.id}">${t('Change it')}</button></div>`).join('')}
      <section class="panel mb"><div class="panel-head"><h3>${icon('mail')} ${t('Google accounts')}</h3><button class="btn sm" data-act="add-google">${icon('plus', 'sm')} ${t('Add a Google account')}</button></div>
        ${ov.accounts.length ? `<div class="stack tight">${ov.accounts.map((a) => `<div class="row between" style="gap:10px;flex-wrap:wrap"><div><div class="strong">${esc(a.email || t('Google'))} ${a.primary ? `<span class="badge">${t('calendar sign-in')}</span>` : ''}</div>
          <div class="xsmall muted">${a.needsReconnect ? `<span style="color:var(--danger)">${icon('alert', 'sm')} ${t('Access expired or was withdrawn')}</span>` : a.connected ? `${t('Google gave')}: ${esc(a.scopes.length ? scopeWords(a.scopes) : (a.gmail ? t('read mail') : t('calendar only')))}` : t('Signed out')}</div></div>
          <div class="row" style="gap:8px">${a.needsReconnect || !a.connected ? `<button class="btn sm primary" data-reconnect="${esc(a.id)}">${t('Reconnect')}</button>` : ''}${a.connected ? `<button class="btn sm ghost" data-signout="${esc(a.id)}">${t('Sign out')}</button>` : ''}</div></div>`).join('')}</div>`
          : `<div class="small muted">${t('No Google account is connected. Add one to read its mail.')}</div>`}
        ${(ov.others || []).length ? `<div class="stack tight mt-s">${ov.others.map((a) => `<div class="row between" style="gap:10px;flex-wrap:wrap"><div><div class="strong">${esc(a.email || a.id)} <span class="badge">${a.kind === 'outlook' ? 'Outlook' : `IMAP ${esc(a.host || '')}`}</span></div><div class="xsmall muted">${a.needsReconnect ? `<span style="color:var(--danger)">${icon('alert', 'sm')} ${t('Access expired or was withdrawn')}</span>` : t('Connected')}</div></div>${a.needsReconnect ? `<button class="btn sm primary" data-source-reconnect="${esc(ov.sources.find((s) => s.kind === a.kind)?.id || '')}">${t('Reconnect')}</button>` : ''}</div>`).join('')}</div>` : ''}
        <div class="xsmall muted mt-s">${t('Google can only take back all of a sign-in at once. Signing out of the calendar sign-in also ends the calendar.')}</div></section>
      <section class="panel mb"><div class="panel-head"><h3>${icon('plug')} ${t('Sources')}</h3></div>
        ${ov.sources.filter((s) => !s.imported).length ? `<div class="stack">${ov.sources.filter((s) => !s.imported).map(sourceCard).join('')}</div>` : empty('plug', t('Nothing connected'), t('Connect mail, chat or a folder under Folders & vaults, and its access shows up here.'))}</section>
      <section class="panel mb"><div class="panel-head"><h3>${icon('folder')} ${t('Where copies are')}</h3></div>
        <div class="small">${t('Besides the live database, copies of it exist here, and they may hold what was read:')}</div>
        <div class="stack tight mt-s">
          <div class="row between small"><span>${t('Copies made before an update')} (${ov.copies.preUpdate.length})</span>${ov.copies.preUpdate.length ? `<button class="btn sm danger" data-act="del-copies">${t('Delete them')}</button>` : `<span class="muted">${t('none')}</span>`}</div>
          <div class="row between small"><span>${t('Backups in the folder you chose')} (${ov.copies.backups.length})</span><span class="muted">${ov.copies.backups.length ? t('Yours to keep or delete: they are not touched here.') : t('none')}</span></div></div></section>
      <section class="panel mb"><div class="panel-head"><h3>${icon('users')} ${t('Forget a person')}</h3></div>
        <div class="small muted">${t('Deletes the mail that is only between you and them, forgets their addresses and never reads them again. The meetings they were in stay: they are your own record.')}</div>
        <div class="row mt-s" style="gap:8px;align-items:end;flex-wrap:wrap"><div class="field grow" style="margin:0;min-width:240px"><label for="fg-person">${t('Who')}</label><select id="fg-person"><option value="">${t('Choose…')}</option>${people.map((p) => `<option value="${esc(p.key || p.id)}" data-id="${esc(p.id || '')}">${esc(p.name)}</option>`).join('')}</select></div><button class="btn danger" data-act="forget">${t('Forget them')}</button></div>
        ${ov.blocked ? `<div class="xsmall muted mt-s">${t('{n} addresses are blocked from being read again.', { n: ov.blocked })}</div>` : ''}</section>
      <section class="panel"><div class="panel-head"><h3>${icon('refresh')} ${t('What happened')}</h3><a class="link" href="#/activity">${t('AI calls')} ${icon('chevright', 'sm')}</a></div>
        ${log.length ? `<div class="stack tight">${log.map((l) => `<div class="row small" style="gap:10px"><span class="muted" style="width:120px">${esc(when(l.at))}</span><span class="grow ellipsis">${t(OPS[l.op] || l.op)}${l.sourceId && byId.get(l.sourceId) ? ` · ${esc(byId.get(l.sourceId).name)}` : ''}</span><span class="muted ellipsis" style="max-width:260px">${esc(l.detail)}</span></div>`).join('')}</div>` : `<div class="small muted">${t('Nothing yet.')}</div>`}
        <div class="xsmall muted mt-s">${t('Only that something happened, never the text.')}</div></section></div>`;
    main._ov = ov;
  };
  const sourceCard = (s) => `<div class="card" data-src="${s.id}" style="padding:12px 14px">
      <div class="row between" style="gap:10px;flex-wrap:wrap"><div class="strong">${esc(s.name)} <span class="badge">${esc(s.kind)}</span>${s.account && s.kind === 'gmail' ? ` <span class="xsmall muted">${esc(s.account === 'primary' ? '' : s.account)}</span>` : ''}</div>
        <span class="badge ${s.needsReconnect ? 'danger' : s.enabled ? 'ok' : ''}">${s.needsReconnect ? t('Reconnect') : s.enabled ? t('On') : t('Paused')}</span></div>
      <div class="small mt-s">${esc(grantSummary(s))}${s.expiresAt ? ` · ${t('ends {d}', { d: fmtDate(s.expiresAt, { day: 'numeric', month: 'short' }) })}` : ''}</div>
      <div class="xsmall muted">${s.items} ${t('items kept')}${s.liveItems ? ` (${s.liveItems} ${t('opened live')})` : ''} · ${t('last used')} ${esc(when(s.lastUsedAt))}${s.aiCalls ? ` · ${t('{n} AI calls carried it', { n: s.aiCalls })}` : ''}${s.cacheBytes ? ` · ${t('search cache')} ${kb(s.cacheBytes)}` : ''}</div>
      ${s.lastError ? `<div class="xsmall mt-s" style="color:var(--danger)">${icon('alert', 'sm')} ${esc(s.lastError)}</div>` : ''}
      <div class="row mt" style="gap:8px;flex-wrap:wrap">${s.needsReconnect ? `<button class="btn sm primary" data-source-reconnect="${s.id}">${t('Reconnect')}</button>` : ''}<button class="btn sm primary" data-edit="${s.id}">${t('Change access')}</button>
        <button class="btn sm" data-review="${s.id}" title="${t('Mark as looked at')}">${t('It is right')}</button><button class="btn sm danger" data-revoke="${s.id}">${t('Revoke…')}</button></div></div>`;

  await draw();
  const reload = async () => { await draw(); window.dispatchEvent(new Event('wb:refresh')); };

  const edit = async (id) => {
    const s = main._ov.sources.find((x) => x.id === id); if (!s) return;
    const r = await openAccessSheet({ provider: s.kind, mode: 'change', current: { ...s, config: s.config }, accounts: main._ov.accounts.filter((a) => a.gmail) });
    if (!r) return;
    const narrower = ['none', 'metadata'].includes(r.grant.readLevel) && s.readLevel !== r.grant.readLevel && s.readLevel !== 'none' && !(s.readLevel === 'metadata' && r.grant.readLevel === 'none' ? false : false);
    if (narrower && !(await confirmDialog(r.grant.readLevel === 'none' ? t('Everything read from {name} will be forgotten now. You can open it up again later.', { name: s.name }) : t('The text of everything read from {name} will be forgotten now; who, when and subject stay.', { name: s.name }), { ok: t('Forget it'), title: t('Narrow this access?') }))) return;
    await api('PATCH', `/api/sources/${id}`, { config: r.config });
    const res = await api('PATCH', `/api/sources/${id}/grant`, r.grant);
    // Gmail: a different level or action set needs different Google permissions: sign in again with exactly those
    if (s.kind === 'outlook' && r.grant.readLevel !== 'none' && (r.grant.readLevel === 'metadata') !== (s.readLevel === 'metadata')) {   // Microsoft is asked for different permissions: sign in again
      done(t('Saved. Microsoft must be asked again for the new permissions: finish the sign-in in your browser.'));
      const c = await api('POST', '/api/outlook/connect', { level: r.grant.readLevel, actions: r.grant.actions }); if (!c.opened && c.authUrl) window.open(c.authUrl, '_blank', 'noopener');
    }
    if (s.kind === 'gmail') {
      const need = JSON.stringify([r.grant.readLevel === 'metadata' ? 'm' : 'r', ...[...r.grant.actions].sort()]);
      const had = JSON.stringify([s.readLevel === 'metadata' ? 'm' : 'r', ...[...(s.actions || [])].sort()]);
      if (need !== had && r.grant.readLevel !== 'none') { done(t('Saved. Google must be asked again for the new permissions: finish the sign-in in your browser.')); await connectGoogle({ account: s.account || 'primary', level: r.grant.readLevel, actions: r.grant.actions }); }
    }
    await api('POST', `/api/access/review/${id}`);
    done(res.purged ? t('Saved. {n} items were forgotten.', { n: res.purged }) : t('Saved'));
    await reload();
  };

  main.onclick = async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.act === 'notice') { await api('POST', '/api/access/notice/dismiss'); await reload(); }
      else if (b.dataset.act === 'add-google') {
        const r = await openAccessSheet({ provider: 'gmail', mode: 'connect', accounts: [] });
        if (!r) return;
        done(t('Finish the sign-in in your browser.'));
        const ev = await connectGoogle({ account: 'new', level: r.grant.readLevel, actions: r.grant.actions });
        if (ev.type === 'google.connected') { await api('POST', '/api/sources', { service: 'gmail', name: `Gmail ${ev.data?.email || ''}`.trim(), config: { ...r.config, account: ev.data?.account }, grant: r.grant }); done(t('Added. Reading…')); } else if (ev.type === 'google.error') fail(new Error(ev.data?.message || t('Sign-in failed')));
        await reload();
      } else if (b.dataset.reconnect) {
        const a = main._ov.accounts.find((x) => x.id === b.dataset.reconnect);
        const src = main._ov.sources.find((s) => s.kind === 'gmail' && (s.account || 'primary') === a.id);
        await connectGoogle({ account: a.id, level: src?.readLevel === 'metadata' ? 'metadata' : 'part', actions: src?.actions || [] }); await reload();
      } else if (b.dataset.sourceReconnect) {
        const s = main._ov.sources.find((x) => x.id === b.dataset.sourceReconnect);
        if (s?.kind === 'outlook') { const c = await api('POST', '/api/outlook/connect', { level: s.readLevel === 'metadata' ? 'metadata' : 'part', actions: s.actions || [] }); if (!c.opened && c.authUrl) window.open(c.authUrl, '_blank', 'noopener'); done(t('Finish the sign-in in your browser.')); return; }
        await connectGoogle({ account: s.account || 'primary', level: s.readLevel === 'metadata' ? 'metadata' : 'part', actions: s.actions || [] });
        await api('POST', `/api/sources/${s.id}/sync`); await reload();
      } else if (b.dataset.signout) {
        const id = b.dataset.signout;
        if (await confirmDialog(id === 'primary' ? t('Sign out of Google? The calendar stops too. What was already read stays until you revoke it.') : t('Sign out of this Google account? What was already read stays until you revoke it.'), { ok: t('Sign out') })) { await api('POST', '/api/google/disconnect', { account: id }); await reload(); }
      } else if (b.dataset.edit) await edit(b.dataset.edit);
      else if (b.dataset.review) { await api('POST', `/api/access/review/${b.dataset.review}`); await reload(); }
      else if (b.dataset.revoke) {
        const s = main._ov.sources.find((x) => x.id === b.dataset.revoke);
        const r = await modal({ title: t('Revoke {name}', { name: s.name }), body: `<p style="margin:0 0 10px">${t('Everything read from it is forgotten now: the text, the search entries and the live-search cache. Nothing at the service is touched.')}</p>${s.kind === 'gmail' ? `<label class="row" style="gap:8px"><input type="checkbox" id="rv-out"> <span class="small">${t('Also sign this account out at Google (for the calendar sign-in this ends the calendar too)')}</span></label>` : ['outlook', 'imap'].includes(s.kind) ? `<label class="row" style="gap:8px"><input type="checkbox" id="rv-out"> <span class="small">${s.kind === 'outlook' ? t('Also sign out of Microsoft here') : t('Also forget the password of this mailbox')}</span></label>` : ''}`, foot: `<button class="btn" data-close>${t('Cancel')}</button><button class="btn danger" data-ok>${t('Revoke')}</button>`, onMount: (d, close) => { d.querySelector('[data-ok]').onclick = () => close({ signOut: !!d.querySelector('#rv-out')?.checked }); } });
        if (r) { const out = await api('POST', `/api/sources/${s.id}/revoke`, { signOut: r.signOut }); done(t('{n} items forgotten.', { n: out.forgotten })); await reload(); }
      } else if (b.dataset.act === 'del-copies') {
        if (await confirmDialog(t('Delete the copies made before updates? They cannot be restored.'), { ok: t('Delete') })) { const out = await api('DELETE', '/api/access/copies'); done(t('{n} copies deleted.', { n: out.removed })); await reload(); }
      } else if (b.dataset.act === 'forget') {
        const sel = $('#fg-person', main); if (!sel.value) return;
        const name = sel.selectedOptions[0].textContent;
        if (await confirmDialog(t('Forget {name}? Their one-to-one mail is deleted and their addresses are never read again. This cannot be undone.', { name }), { ok: t('Forget them') })) { const out = await api('POST', `/api/people/${encodeURIComponent(sel.value)}/forget`); done(t('{n} threads deleted, {m} addresses blocked. {k} meetings stay.', { n: out.items, m: out.addresses, k: out.meetings })); await reload(); }
      }
    } catch (err) { fail(err); }
  };
  const redraw = debounce(() => { if (S.view.name === 'access') draw().catch(() => {}); }, 400);
  if (onEvent) window.removeEventListener('wb:event', onEvent);
  onEvent = (e) => { if (S.view.name !== 'access') { window.removeEventListener('wb:event', onEvent); onEvent = null; return; } if (['sources.changed', 'google.connected', 'items.purged', 'actions.changed'].includes(e.detail?.type)) redraw(); };
  window.addEventListener('wb:event', onEvent, { signal: S.route.signal });   // and gone with the page (app.js route())
}
