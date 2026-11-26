// Home: start a meeting (online / in person / upload), recent meetings, today's calendar with auto-capture
// toggles, and open action items.
import { S, $, $$, api, t, esc, icon, fail, go, meetingCard, fmtHour, dayStart, relDay, switchEl, menu, done, empty, PLATFORMS, callLabel, loc } from '../lib.js';
import { startRecording, takeNotesFor, recordDetected } from '../recording.js';
import { openImport } from './transfer.js';
import { openBrief } from '../brief.js';

const platformFromUrl = (u) => (/meet\.google/.test(u) ? 'meet' : /zoom\.us/.test(u) ? 'zoom' : /teams\.(microsoft|live)/.test(u) ? 'teams' : /webex/.test(u) ? 'webex' : /whereby/.test(u) ? 'whereby' : /jit\.si|jitsi/.test(u) ? 'jitsi' : null);
let mode = 'online';

export async function render(main) {
  const hour = new Date().getHours();
  const greet = hour < 5 ? t('Good evening') : hour < 12 ? t('Good morning') : hour < 18 ? t('Good afternoon') : t('Good evening');
  const now = Date.now();
  const [recent, cal, prefs, todos] = await Promise.all([
    api('GET', '/api/meetings?limit=6&sort=newest'),
    api('GET', `/api/calendar/events?from=${dayStart()}&to=${dayStart() + 2 * 86400000}`).catch(() => ({ events: [], errors: [] })),
    api('GET', '/api/calendar/prefs').catch(() => ({})),
    api('GET', '/api/actions?done=0&limit=6'),
  ]);
  const events = cal.events.filter((e) => !e.allDay && e.end > now).slice(0, 6);
  const st = S.state?.stats || {};
  const needModel = !S.models.some((m) => m.installed);
  const needLlm = !S.state?.llmConfigured;
  const [needs, open] = await Promise.all([api('GET', '/api/inbox').then((r) => r.counts).catch(() => null), api('GET', '/api/commitments').catch(() => null)]);
  const hasCal = (S.settings.calendar?.sources?.length || 0) > 0 || !!S.settings.google?.refreshToken;
  main.innerHTML = `<div class="page">
    <div class="page-head hello"><div><h1>${greet}${S.settings.userName ? `, ${esc(S.settings.userName.split(' ')[0])}` : ''}</h1><div class="sub">${new Date().toLocaleDateString(loc(), { weekday: 'long', day: 'numeric', month: 'long' })}</div></div></div>
    ${S.detector?.active && !S.rec.active ? `<div class="banner ok mb" role="status">${icon('video')}<div class="grow"><b>${t('You are in a meeting')}</b><div class="small muted">${esc(callLabel(S.detector) || S.detector.apps?.join(', ') || '')}${S.detector.event ? ' — ' + esc(S.detector.event.summary) : ''}</div></div><button class="btn sm primary" data-act="detected">${icon('mic', 'sm')} ${t('Take notes')}</button></div>` : ''}
    ${needModel ? `<div class="banner mb">${icon('mic')}<div class="grow"><b>${t('Set up on-device transcription')}</b><div class="small muted">${t('Download a speech model once. Audio never leaves this computer.')}</div></div><a class="btn sm primary" href="#/settings/audio">${t('Choose a model')}</a></div>` : ''}
    <div class="cols-main">
      <div class="stack loose">
        <section class="panel newmeeting">
          <div class="panel-head"><h2>${t('New meeting')}</h2></div>
          <div class="seg-ctl lg full" role="tablist">${[['online', t('Online meeting'), t('Online'), 'video'], ['person', t('In-person meeting'), t('In person'), 'users'], ['upload', t('Upload meeting'), t('Upload'), 'upload']].map(([k, l, sh, ic]) => `<button type="button" role="tab" data-mode="${k}" aria-selected="${mode === k}">${icon(ic, 'sm')}<span class="lbl-long">${l}</span><span class="lbl-short">${sh}</span></button>`).join('')}</div>
          <div class="body" id="nm-body"></div>
        </section>
        <div class="stats-row">
          <a class="card hover stat" href="#/meetings"><b>${st.notes || 0}</b><span>${t('Meetings')}</span></a>
          <a class="card hover stat" href="#/actions"><b>${st.openActions || 0}</b><span>${t('Open action items')}</span></a>
          <a class="card hover stat" href="#/topics"><b>${st.topics || 0}</b><span>${t('Topics')}</span></a>
          <a class="card hover stat" href="#/glossary"><b>${st.glossary || 0}</b><span>${t('Glossary terms')}</span></a>
        </div>
        <section>
          <div class="panel-head"><h2>${t('Recent meetings')}</h2><a class="link" href="#/meetings">${t('Go to Meetings')} ${icon('chevright', 'sm')}</a></div>
          ${recent.length ? `<div class="cards">${recent.map(meetingCard).join('')}</div>` : `<div class="panel">${empty('video', t('No meetings yet'), t('Record your next call, or import past recordings, transcripts and notes.'), `<div class="row"><button class="btn primary" data-act="rec">${icon('mic', 'sm')} ${t('Record')}</button><button class="btn" data-act="import">${icon('upload', 'sm')} ${t('Import')}</button></div>`)}</div>`}
        </section>
      </div>
      <aside class="stack loose">
        ${needs && (needs.total || (open && (open.mine.length || open.theirs.length))) ? `<section class="panel"><div class="panel-head"><h2>${t('Needs you')}</h2><a class="link" href="#/inbox">${t('Open Inbox')} ${icon('chevright', 'sm')}</a></div>
          <div class="stack tight small">${needs.suggestions ? `<div>${icon('sparkles', 'sm')} ${needs.suggestions === 1 ? t('1 suggestion to review') : t('{n} suggestions to review', { n: needs.suggestions })}</div>` : ''}${needs.overdue ? `<div style="color:var(--danger)">${icon('clock', 'sm')} ${t('Late promises of yours: {n}', { n: needs.overdue })}</div>` : ''}${needs.waiting ? `<div>${icon('clock', 'sm')} ${t('Late promises to you: {n}', { n: needs.waiting })}</div>` : ''}${needs.reminders ? `<div>${icon('bell', 'sm')} ${t('Reminders waiting: {n}', { n: needs.reminders })}</div>` : ''}
          ${open ? `<a href="#/promises">${t('I owe')} <b>${open.mine.length}</b> · ${t('Owed to me')} <b>${open.theirs.length}</b></a>` : ''}</div></section>` : ''}
        <section class="panel">
          <div class="panel-head"><h2>${t('Today')}</h2><a class="btn ghost icon sm" href="#/calendar" title="${t('Calendar')}" aria-label="${t('Calendar')}">${icon('calendar')}</a></div>
          <div class="row between" style="margin-bottom:10px"><span class="strong">${t('Meetings')}</span>
            <button class="btn soft sm" data-act="capture">${S.settings.captureCalendar === 'all' ? t('Capture all') : S.settings.captureCalendar === 'selected' ? t('Capture selected') : t('Capture off')} ${icon('chevdown', 'sm')}</button></div>
          <div class="stack tight">${events.length ? events.map((e) => eventCard(e, prefs, now)).join('') : hasCal ? `<div class="card dashed small muted">${t('Nothing else on your calendar today.')}</div>` : `<div class="card dashed small"><div class="muted">${t('Connect your calendar to see meetings here and record them automatically.')}</div><a class="btn sm soft mt-s" href="#/integrations">${icon('calendar', 'sm')} ${t('Connect Google Calendar')}</a></div>`}</div>
          ${cal.errors?.length ? `<div class="xsmall muted mt-s">${icon('alert', 'sm')} ${esc(cal.errors[0].source)}: ${esc(cal.errors[0].error)}</div>` : ''}
        </section>
        <section class="panel">
          <div class="panel-head"><h2>${t('To do')}</h2><a class="link" href="#/actions">${t('Go to Action items')} ${icon('chevright', 'sm')}</a></div>
          <div class="stack tight" id="todos">${todos.length ? todos.map(todoCard).join('') : `<div class="card dashed small muted">${t('No open action items. They are extracted from your meetings automatically.')}</div>`}</div>
        </section>
        ${needLlm ? `<section class="panel"><div class="panel-head"><h3>${icon('sparkles')} ${t('Connect an AI model')}</h3></div><p class="small muted" style="margin:0 0 10px">${t('Summaries, topics, glossary and chat use any OpenAI-compatible server — Ollama runs locally.')}</p><a class="btn sm" href="#/settings/ai">${t('Set up AI')}</a></section>` : ''}
      </aside>
    </div></div>`;
  renderMode();

  main.onclick = async (e) => {
    const m = e.target.closest('[data-mode]');
    if (m) { mode = m.dataset.mode; $$('[data-mode]', main).forEach((b) => b.setAttribute('aria-selected', String(b === m))); renderMode(); return; }
    const a = e.target.closest('[data-act]')?.dataset.act;
    try {
      if (a === 'rec') startRecording(null);
      else if (a === 'import') openImport();
      else if (a === 'detected') recordDetected(S.detector);
      else if (a === 'capture') {
        const set = async (v) => { S.settings = await api('PUT', '/api/settings', { captureCalendar: v }); render(main); };
        menu(e.target.closest('button'), [
          { header: t('Record calendar meetings automatically') },
          { label: t('Capture all'), selected: S.settings.captureCalendar === 'all', run: () => set('all') },
          { label: t('Only the ones I switch on'), selected: S.settings.captureCalendar === 'selected', run: () => set('selected') },
          { label: t('Off — just remind me'), selected: S.settings.captureCalendar === 'off', run: () => set('off') },
        ], { align: 'end' });
      } else if (a === 'notes-for') { const ev = JSON.parse(e.target.closest('[data-ev]').dataset.ev); takeNotesFor(ev, { record: e.target.closest('[data-rec]') != null }); }
      else if (a === 'brief') { const ev = JSON.parse(e.target.closest('[data-ev]').dataset.ev); openBrief({ title: ev.title, start: ev.start, attendees: ev.attendees }); }
      else if (a === 'nm-start') startFromForm();
      else if (a === 'nm-upload') openImport();
    } catch (err) { fail(err); }
  };
  main.onchange = async (e) => {
    if (e.target.matches('[data-cap]')) {
      try {
        await api('PUT', `/api/calendar/prefs/${encodeURIComponent(e.target.dataset.cap)}`, { capture: e.target.checked });
        if (e.target.checked && S.settings.captureCalendar === 'off') { S.settings = await api('PUT', '/api/settings', { captureCalendar: 'selected' }); render(main); }
        else done(e.target.checked ? t('Will record when it starts') : t('Won’t record automatically'));
      } catch (err) { fail(err); }
    }
    if (e.target.matches('.todo .cbx')) {
      const row = e.target.closest('.todo');
      try { await api('PATCH', `/api/actions/${row.dataset.id}`, { done: e.target.checked }); row.classList.toggle('done', e.target.checked); window.dispatchEvent(new Event('wb:refresh')); } catch (err) { fail(err); }
    }
  };
}

function renderMode() {
  const body = $('#nm-body');
  if (!body) return;
  const tpl = `<select id="nm-tpl" aria-label="${t('Template')}">${S.templates.map((x) => `<option value="${x.id}" ${x.id === S.settings.defaultTemplate ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`;
  const space = `<select id="nm-space" aria-label="${t('Space')}"><option value="">${t('No space')}</option>${S.spaces.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>`;
  if (mode === 'upload') {
    body.innerHTML = `<button type="button" class="dropzone" data-act="nm-upload">${icon('upload')}<b>${t('Upload a recording, transcript or document')}</b><span class="small">${t('Audio/video is transcribed on this device. VTT, SRT, TXT, Markdown, JSON, DOCX, HTML and CSV are imported with speakers.')}</span></button>`;
    return;
  }
  body.innerHTML = `${mode === 'online' ? `<div class="inline-form"><input id="nm-url" type="url" placeholder="${t('Paste your meeting URL here (Meet, Zoom, Teams…) — optional')}"><button class="btn primary" data-act="nm-start">${icon('mic', 'sm')} ${t('Start capturing')}</button></div>` : `<div class="inline-form"><div class="small muted" style="align-self:center">${t('Records your microphone only — put the computer in the middle of the room.')}</div><button class="btn primary" data-act="nm-start">${icon('mic', 'sm')} ${t('Start capturing')}</button></div>`}
    <div class="formgrid">
      <div class="field"><label for="nm-title">${t('Name your meeting')} <span class="faint">(${t('optional')})</span></label><input id="nm-title" placeholder="${t('E.g. Team sync')}"></div>
      <div class="field"><label for="nm-tpl">${t('Notes template')}</label>${tpl}</div>
      <div class="field"><label for="nm-space">${t('Space')}</label>${space}</div>
    </div>`;
}

async function startFromForm() {
  const url = $('#nm-url')?.value.trim() || '';
  if (url && !/^https?:\/\//i.test(url)) return fail(new Error(t('The meeting link must start with https://')));
  const title = $('#nm-title').value.trim();
  const templateId = $('#nm-tpl').value, folderId = $('#nm-space').value || undefined;
  if (url) window.open(url, '_blank', 'noopener');
  const st = await startRecording(null, { title, templateId, folderId, platform: url ? platformFromUrl(url) || undefined : undefined, ...(mode === 'person' ? { system: false } : {}) });
  if (st && url) api('POST', `/api/notes/${st.noteId}/links`, { kind: 'calendar', url, title: t('Meeting link') }).catch(() => {});
}

function eventCard(e, prefs, now) {
  const live = now >= e.start - 5 * 60000 && now < e.end;
  const capture = S.settings.captureCalendar === 'all' || (S.settings.captureCalendar === 'selected' && prefs[e.id]);
  const ev = esc(JSON.stringify({ title: e.summary, uid: e.uid, start: e.start, attendees: (e.attendees || []).map((a) => ({ name: a.name, email: a.email })), url: e.url || '' }));
  const people = (e.attendees || []).map((a) => a.name || a.email).filter(Boolean);
  return `<div class="card today-item ${live ? 'now' : ''}" data-ev="${ev}">
    <div class="t ellipsis">${esc(e.summary || t('Untitled event'))}</div>
    ${S.settings.captureCalendar === 'all' ? `<span class="badge accent" title="${t('Will be recorded automatically')}">${icon('mic', 'sm')}</span>` : switchEl('', capture, t('Record automatically')).replace('id=""', `data-cap="${esc(e.id)}"`)}
    <div class="when">${icon('clock', 'sm')}${relDay(e.start) !== t('Today') ? relDay(e.start) + ' ' : ''}${fmtHour(e.start)} – ${fmtHour(e.end)}${people.length ? ` · ${esc(people.slice(0, 2).join(', '))}${people.length > 2 ? ` +${people.length - 2}` : ''}` : ''}</div>
    <div class="row" style="gap:4px"><button class="btn xs ghost" data-act="brief" title="${t('What you know before this meeting')}">${icon('sparkles', 'sm')} ${t('Prepare')}</button>${e.url ? `<a class="btn xs ghost" href="${esc(e.url)}" target="_blank" rel="noopener noreferrer" title="${t('Join')}">${icon('external', 'sm')}</a>` : ''}<button class="btn xs ${live ? 'primary' : 'soft'}" data-act="notes-for" ${live ? 'data-rec="1"' : ''}>${live ? t('Record') : t('Notes')}</button></div>
  </div>`;
}

const todoCard = (a) => `<div class="card todo ${a.done ? 'done' : ''}" data-id="${a.id}"><input type="checkbox" class="cbx" ${a.done ? 'checked' : ''} aria-label="${t('Done')}"><div class="txt"><div class="t small">${esc(a.text)}</div><div class="xsmall muted ellipsis">${a.owner ? esc(a.owner) + ' · ' : ''}${a.due ? esc(a.due) + ' · ' : ''}<a href="#/note/${a.noteId}">${esc(a.noteTitle || t('Untitled meeting'))}</a></div></div></div>`;
