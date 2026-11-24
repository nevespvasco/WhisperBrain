// Upcoming meetings from Google Calendar and iCal feeds, with per-meeting "record automatically" switches.
import { S, $, api, t, esc, icon, fail, done, dayStart, fmtHour, relDay, groupBy, switchEl, empty, avatarStack, menu } from '../lib.js';
import { takeNotesFor } from '../recording.js';

let offset = 0; // weeks from now

export async function render(main) {
  const from = dayStart() + offset * 7 * 86400000, to = from + 7 * 86400000;
  const [cal, prefs, past] = await Promise.all([
    api('GET', `/api/calendar/events?from=${from}&to=${to}&refresh=${offset === 0 ? '0' : '0'}`).catch((e) => ({ events: [], errors: [{ source: 'Calendar', error: e.message }] })),
    api('GET', '/api/calendar/prefs').catch(() => ({})),
    api('GET', '/api/meetings?limit=300').catch(() => []),
  ]);
  const byEvent = new Map(past.filter((n) => n.eventUid).map((n) => [`${n.eventUid}:${n.eventStart}`, n]));
  const connected = (S.settings.calendar?.sources?.length || 0) > 0 || !!S.settings.google?.refreshToken;
  const mode = S.settings.captureCalendar;
  const events = cal.events.filter((e) => !e.allDay);
  const allDay = cal.events.filter((e) => e.allDay);
  main.innerHTML = `<div class="page narrow">
    <div class="page-head"><div><h1>${t('Calendar')}</h1><div class="sub">${t('Meetings are recognised when they start; switch on the ones WhisperBrain should record by itself.')}</div></div>
      <div class="actions"><button class="btn icon" data-act="prev" aria-label="${t('Previous week')}">${icon('chevleft')}</button><button class="btn" data-act="today">${t('This week')}</button><button class="btn icon" data-act="next" aria-label="${t('Next week')}">${icon('chevright')}</button><button class="btn icon" data-act="refresh" title="${t('Refresh')}" aria-label="${t('Refresh')}">${icon('refresh')}</button></div></div>
    ${!connected ? `<div class="panel">${empty('calendar', t('No calendar connected'), t('Connect Google Calendar (or any iCal feed) to see your meetings, get reminded, and record them automatically.'), `<a class="btn primary" href="#/integrations">${icon('plug', 'sm')} ${t('Connect a calendar')}</a>`)}</div>` : `
    <div class="banner mb"><span>${icon('mic')}</span><div class="grow"><b>${t('Automatic recording')}</b><div class="small muted">${mode === 'all' ? t('Every meeting with a time is recorded when it starts.') : mode === 'selected' ? t('Only meetings you switch on are recorded.') : t('Off — you get a reminder and choose.')}</div></div><button class="btn sm" data-act="mode">${mode === 'all' ? t('Capture all') : mode === 'selected' ? t('Capture selected') : t('Capture off')} ${icon('chevdown', 'sm')}</button></div>
    ${cal.errors?.length ? `<div class="banner warn mb">${icon('alert')}<div class="grow small">${cal.errors.map((e) => `${esc(e.source)}: ${esc(e.error)}`).join('<br>')}</div><a class="btn sm" href="#/integrations">${t('Fix')}</a></div>` : ''}
    ${allDay.length ? `<div class="chips mb">${allDay.map((e) => `<span class="chip static">${icon('calendar', 'sm')}${esc(relDay(e.start))} · ${esc(e.summary)}</span>`).join('')}</div>` : ''}
    ${events.length ? groupBy(events, (e) => relDay(e.start)).map((g) => `<div class="datagroup"><h4>${esc(g.key)}</h4><div class="list">${g.items.map((e) => row(e, prefs, mode, byEvent)).join('')}</div></div>`).join('') : `<div class="panel">${empty('calendar', t('A quiet week'), t('No timed meetings in this range.'))}</div>`}`}
  </div>`;
  main.onclick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const a = b.dataset.act;
    try {
      if (a === 'prev') { offset--; render(main); }
      else if (a === 'next') { offset++; render(main); }
      else if (a === 'today') { offset = 0; render(main); }
      else if (a === 'refresh') { await api('GET', `/api/calendar/events?from=${from}&to=${to}&refresh=1`); render(main); }
      else if (a === 'mode') {
        const set = async (v) => { S.settings = await api('PUT', '/api/settings', { captureCalendar: v }); render(main); };
        menu(b, [{ label: t('Capture all'), selected: mode === 'all', run: () => set('all') }, { label: t('Only the ones I switch on'), selected: mode === 'selected', run: () => set('selected') }, { label: t('Off — just remind me'), selected: mode === 'off', run: () => set('off') }], { align: 'end' });
      } else if (a === 'notes') { const ev = JSON.parse(b.closest('[data-ev]').dataset.ev); takeNotesFor(ev, { record: b.dataset.rec === '1' }); }
    } catch (err) { fail(err); }
  };
  main.onchange = async (e) => {
    if (!e.target.matches('[data-cap]')) return;
    try {
      await api('PUT', `/api/calendar/prefs/${encodeURIComponent(e.target.dataset.cap)}`, { capture: e.target.checked });
      if (e.target.checked && mode === 'off') { S.settings = await api('PUT', '/api/settings', { captureCalendar: 'selected' }); render(main); }
      else done(e.target.checked ? t('Will record when it starts') : t('Won’t record automatically'));
    } catch (err) { fail(err); }
  };
}

function row(e, prefs, mode, byEvent) {
  const now = Date.now();
  const live = now >= e.start - 5 * 60000 && now < e.end;
  const pastEv = e.end < now;
  const note = byEvent.get(`${e.uid}:${e.start}`);
  const people = (e.attendees || []).map((a) => a.name || a.email).filter(Boolean);
  const ev = esc(JSON.stringify({ title: e.summary, uid: e.uid, start: e.start, attendees: (e.attendees || []).map((a) => ({ name: a.name, email: a.email })), url: e.url || '' }));
  return `<div class="li" data-ev="${ev}" style="${pastEv ? 'opacity:.65' : ''}">
    <div style="width:96px;flex:none" class="small"><b>${fmtHour(e.start)}</b><div class="xsmall muted">${fmtHour(e.end)}</div></div>
    <div class="main-t"><div class="t">${live ? '<span class="dot-rec" style="margin-right:8px"></span>' : ''}${esc(e.summary || t('Untitled event'))}</div><div class="s">${esc([e.source, e.location].filter(Boolean).join(' · '))}</div></div>
    <div class="side">${avatarStack(people, 3)}
      ${e.url ? `<a class="btn xs ghost" href="${esc(e.url)}" target="_blank" rel="noopener noreferrer" title="${t('Join')}">${icon('external', 'sm')}<span class="hide-sm">${t('Join')}</span></a>` : ''}
      ${note ? `<a class="btn xs soft" href="#/note/${note.id}">${icon('file', 'sm')} ${t('Notes')}</a>` : pastEv ? '' : `<button class="btn xs ${live ? 'primary' : ''}" data-act="notes" ${live ? 'data-rec="1"' : ''}>${live ? t('Record') : t('Prepare notes')}</button>`}
      ${pastEv ? '' : mode === 'all' ? `<span class="badge accent" title="${t('Will be recorded automatically')}">${icon('mic', 'sm')}</span>` : switchEl('', mode === 'selected' && prefs[e.id], t('Record automatically')).replace('id=""', `data-cap="${esc(e.id)}"`)}
    </div></div>`;
}
void $;
