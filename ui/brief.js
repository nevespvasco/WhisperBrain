// The brief before a meeting: who is coming, when you last met, what you owe them and they owe you, what was decided, and the notes
// that match the meeting. Built from what is already known with no AI in the middle, so every line has a place to open.
import { S, api, t, esc, icon, fail, modal, fmtDate, fmtClock } from './lib.js';

const day = (ms) => fmtDate(ms, { day: 'numeric', month: 'short' });
const open = (a) => `<a href="#/note/${a.source?.noteId || a.noteId}?tab=transcript${a.segmentId ? `&seg=${a.segmentId}` : ''}">${icon('quote', 'sm')}${a.startMs != null ? ` ${fmtClock(a.startMs)}` : ''}</a>`;
const line = (a) => `<li>${esc(a.text)}${a.owner?.name ? ` <span class="muted">· ${esc(a.owner.name)}</span>` : ''}${a.dueAt ? ` <span class="muted">· ${t('by')} ${day(a.dueAt)}${a.dueAt < Date.now() ? ` <b style="color:var(--danger)">${t('late')}</b>` : ''}</span>` : ''} ${open(a)}</li>`;

// event: { title, start, attendees: [{ name, email }] }
export async function openBrief(event) {
  try {
    const b = await api('POST', '/api/brief', { title: event.title || '', start: event.start || null, attendees: event.attendees || [] });
    const sec = (title, inner) => (inner ? `<section style="margin:0 0 14px"><h3 style="font-size:13px;margin:0 0 6px">${title}</h3>${inner}</section>` : '');
    const body = b.empty ? `<p class="muted">${t('Nothing known yet about this meeting or the people in it. After you meet, what is decided and promised will show up here next time.')}</p>`
      : `${sec(t('Who is coming'), b.people.length ? `<ul class="list">${b.people.map((p) => `<li><a href="#/person/${encodeURIComponent(p.key)}">${esc(p.name)}</a> <span class="muted">· ${p.meetings} ${p.meetings === 1 ? t('meeting') : t('meetings')}${p.last ? ` · ${t('last time')} <a href="#/note/${p.last.id}">${esc(p.last.title || t('Untitled meeting'))}</a>, ${day(p.last.at)}` : ''}</span></li>`).join('')}</ul>${b.unknown > 0 ? `<div class="xsmall muted">${b.unknown === 1 ? t('1 person is not known yet.') : t('{n} people are not known yet.', { n: b.unknown })}</div>` : ''}` : '')}
        ${sec(t('You owe them'), b.owe.length ? `<ul class="list">${b.owe.map(line).join('')}</ul>` : '')}
        ${sec(t('They owe you'), b.waiting.length ? `<ul class="list">${b.waiting.map(line).join('')}</ul>` : '')}
        ${sec(t('Decided so far'), b.decisions.length ? `<ul class="list">${b.decisions.map(line).join('')}</ul>` : '')}
        ${sec(t('Related notes'), b.related.length ? `<ul class="list">${b.related.map((r) => `<li><a href="${r.kind === 'item' ? `#/documents/${r.id}` : `#/note/${r.id}${r.segmentId ? `?tab=transcript&seg=${r.segmentId}` : ''}`}">${esc(r.title || t('Untitled'))}</a> <span class="muted">· ${esc(r.text.replace(/\s+/g, ' ').slice(0, 110))}…</span></li>`).join('')}</ul>` : '')}`;
    await modal({ title: `${t('Before')}: ${event.title || t('Meeting')}`, wide: true, body: `${b.empty || !S.state?.llmConfigured ? '' : `<div class="row" style="margin-bottom:10px"><button class="btn sm" data-narrate>${icon('sparkles', 'sm')} ${t('Write it as a short note')}</button></div><div id="brief-ai" class="small" style="margin-bottom:12px"></div>`}<div class="small">${body}</div><div class="xsmall muted">${t('Built from your own meetings and notes, with no AI in between. Every line opens its source.')}</div>`, foot: `<button class="btn" data-close>${t('Close')}</button>`,
      onMount: (d) => { d.querySelector('[data-narrate]')?.addEventListener('click', async (e) => {
        const box = d.querySelector('#brief-ai'); e.currentTarget.disabled = true; box.textContent = t('Writing…');
        try {
          const r = await api('POST', '/api/brief', { title: event.title || '', start: event.start || null, attendees: event.attendees || [], narrate: true });
          const n = r.narrative;
          box.innerHTML = n ? `<div class="ai" style="padding-left:10px"><span class="ai-mark">✦</span> ${esc(n.text).replace(/\[(\d+)\]/g, (m, k) => { const f = n.facts.find((x) => x.n === Number(k)); const ref = f?.ref; return ref ? `<a class="cite" href="${ref.kind === 'item' ? `#/documents/${ref.id}` : `#/note/${ref.id}${ref.segmentId ? `?tab=transcript&seg=${ref.segmentId}` : ''}`}" title="${esc(f.text)}">${k}</a>` : `<span class="cite" title="${esc(f?.text || '')}">${k}</span>`; })}</div><div class="xsmall muted">${t('Written by your AI from the facts below, each cited. Check the numbers against them.')}</div>` : `<span class="muted">${t('The AI could not write a note that cites its facts, so only the facts are shown.')}</span>`;
        } catch (err) { box.textContent = ''; fail(err); }
      }); } });
  } catch (e) { fail(e); }
}
