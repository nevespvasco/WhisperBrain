import { S, $, $$, api, t, esc, icon, toast, fail, go, avatar, debounce, menu, menuIsOpen, promptDialog, confirmDialog, PLATFORMS, callLabel } from './lib.js';
import { setLang } from './i18n.js';
import { events, ApiError } from './api.js';
import { translateChip, translateMenu } from './translate-chip.js';
import { startRecording, stopRecording, renderRecbar, syncRec, handleCaptureRequest, takeNotesFor, recordDetected, recEvents, setRecConsent } from './recording.js';
import { copyNotice, setConsent } from './consent.js';
import { openPalette } from './palette.js';
import { openImport, openExport } from './views/transfer.js';
import * as home from './views/home.js';
import * as meetings from './views/meetings.js';
import * as note from './views/note.js';
import * as calendar from './views/calendar.js';
import * as actions from './views/actions.js';
import * as topics from './views/topics.js';
import * as glossary from './views/glossary.js';
import * as briefings from './views/briefings.js';
import * as people from './views/people.js';
import * as chat from './views/chat.js';
import * as integrations from './views/integrations.js';
import * as settings from './views/settings.js';
import * as activity from './views/activity.js';
import * as sources from './views/sources.js';
import * as access from './views/access.js';
import * as documents from './views/documents.js';
import * as inbox from './views/inbox.js';
import * as promises from './views/promises.js';
import * as review from './views/review.js';
import * as projects from './views/projects.js';
import * as rules from './views/rules.js';
import { openBrief } from './brief.js';
import { setupOnFirstRun } from './views/setup.js';
import { DOORS, door, doorOf, isCurrent } from './nav.js';

const appEl = $('#app'), sidebar = $('#sidebar'), main = $('#main'), topbar = $('#topbar');

// ---------- data ----------
export async function refreshCounts() {
  const [spaces, tags, st] = await Promise.all([api('GET', '/api/spaces'), api('GET', '/api/tags'), api('GET', '/api/state')]);
  S.spaces = spaces; S.tags = tags; S.state = st;
  renderSidebar();
}
window.addEventListener('wb:refresh', debounce(() => refreshCounts().catch(() => {}), 250));

export function applyTheme() {
  document.documentElement.dataset.theme = S.settings.theme;
  setLang(S.settings.language);
  appEl.classList.toggle('collapsed', !!S.settings.sidebarCollapsed);
  const sk = $('.skip'); if (sk) sk.textContent = t('Skip to content');
}

// ---------- drawer (phone/tablet sidebar) ----------
function setDrawer(open) {
  appEl.classList.toggle('drawer', open);
  $('[data-top="drawer"]')?.setAttribute('aria-expanded', String(open));
}

// ---------- routing ----------
const ROUTES = {
  '': home, meetings, note, calendar, actions, topics, topic: topics, glossary, term: glossary, briefings, people, person: people, chat, integrations, settings, activity, sources, access, documents, inbox, promises, review, projects, project: projects, rules,
};
// Each page gets a signal that aborts when the next one starts, and alive(): a slow page that comes back after the user has
// moved on must not draw over the new one (views check alive() after their awaits; route() drops what a stale one throws).
// Listeners and timers a page adds to document/window go with { signal: S.route.signal }.
let routeSeq = 0, routeAc = null, shownSeq = 0;
async function route() {
  routeAc?.abort();
  const ac = routeAc = new AbortController(), seq = ++routeSeq;
  const alive = () => seq === routeSeq;
  S.route = { signal: ac.signal, alive };
  const hash = location.hash.replace(/^#\/?/, '');
  const [path, qs] = hash.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(qs || '');
  let name = parts[0] || '';
  if (name === 'space' && parts[1]) { params.set('space', parts[1]); name = 'meetings'; }
  if (name === 'search') { openPalette(params.get('q') || ''); name = ''; }
  const view = ROUTES[name] || home;
  S.view = { name: name || 'home', parts, params };
  if (!keepDrawer) setDrawer(false);   // a door tapped in the drawer opens its list there; a page link closes the drawer
  keepDrawer = false;
  renderSidebar();
  main.scrollTop = 0; main.classList.remove('fit');
  // Every page starts with none of the previous page's handlers: views set main.onclick & co., and one left behind would answer
  // the next page's buttons (a Briefings "delete" handler once fired on Action items).
  for (const k of ['onclick', 'onchange', 'oninput', 'onsubmit', 'onkeydown', 'ondblclick']) main[k] = null;
  const slow = setTimeout(() => { appEl.classList.add('loading'); main.setAttribute('aria-busy', 'true'); }, 220);
  try { await view.render(main, { parts, params, name, signal: ac.signal, alive }); } catch (e) {
    if (!alive() || e?.name === 'AbortError') return;
    if (e instanceof ApiError && e.status === 404) { toast(t('That item no longer exists.'), { error: true }); go('#/'); return; }
    fail(e);
    main.innerHTML = `<div class="page"><div class="banner danger mt" role="alert">${icon('alert')}<div class="grow">${esc(e.message)}</div><a class="btn sm" href="#/">${t('Home')}</a></div></div>`;
  } finally {
    clearTimeout(slow);
    if (alive()) { appEl.classList.remove('loading'); main.removeAttribute('aria-busy'); shownSeq = seq; if (main.firstElementChild) main.firstElementChild.dataset.route = seq; }
    // A page that does not check alive() came back late and replaced the newer page that was already drawn: draw that one again
    else if (shownSeq > seq && main.firstElementChild?.dataset.route !== String(shownSeq)) route();
  }
}
window.addEventListener('hashchange', route);
let keepDrawer = false;

// ---------- sidebar ----------
function navlink(href, ic, label, { count, current = '', title } = {}) {
  return `<a class="navlink" href="${href}" ${current} title="${esc(title || label)}">${ic}<span class="lbl">${esc(label)}</span>${count ? `<span class="count">${count}</span>` : ''}</a>`;
}
// Spaces and tags can grow without end: each is a folding group that shows the first few (plus the one open now) and
// lists the rest in its own short scroll on demand, so Sources and the account stay within reach.
const SIDE_FIRST = 5;
const sideAll = new Set();
const sideClosed = (k) => { try { return localStorage.getItem(`wb.side.${k}`) === '0'; } catch { return false; } };
function sideGroup(key, label, addAct, addLabel, items, emptyText) {
  const closed = sideClosed(key), all = sideAll.has(key);
  const shown = all ? items : items.filter((it, i) => i < SIDE_FIRST || it.on);
  return `<div class="side-group${closed ? ' closed' : ''}" data-group="${key}">
    <div class="side-label"><button type="button" class="side-toggle" data-act="side-toggle" aria-expanded="${!closed}">${icon('chevdown', 'sm')}<span>${esc(label)}</span>${items.length ? `<span class="n">${items.length}</span>` : ''}</button><button class="btn ghost icon xs" data-act="${addAct}" title="${esc(addLabel)}" aria-label="${esc(addLabel)}">${icon('plus', 'sm')}</button></div>
    ${closed ? '' : `<nav class="nav${all ? ' side-list' : ''}">${shown.map((it) => it.html).join('') || `<div class="xsmall faint side-more" style="padding:2px 10px">${esc(emptyText)}</div>`}</nav>
    ${items.length > SIDE_FIRST ? `<button type="button" class="side-more-btn side-more" data-act="side-all">${all ? t('Show less') : t('Show all {n}', { n: items.length })}</button>` : ''}`}</div>`;
}
// The sidebar is a rail of four doors (ui/nav.js) with the Record button, and next to it the open door's own pages.
// "Compact sidebar" keeps only the rail.
export function renderSidebar() {
  const st = S.state?.stats || {};
  const src = S.state?.sources || {};
  const p = S.view.params || new URLSearchParams();
  const inMeetings = S.view.name === 'meetings';
  const imported = Object.entries(src).filter(([k]) => !['recorded', 'manual'].includes(k)).reduce((a, [, v]) => a + v, 0);
  const counts = { notes: st.notes, openActions: st.openActions, topics: st.topics, glossary: st.glossary, recorded: (src.recorded || 0) + (src.manual || 0), imported, documents: st.documents, inbox: st.inbox };
  const name = S.settings?.userName || t('Local account');
  const open = door(doorOf(S.view.name));
  const link = (l) => navlink(l.href, icon(l.icon), t(l.label), { count: l.count ? counts[l.count] : 0, current: isCurrent(l, S.view) ? 'aria-current="page"' : '', title: l.title ? t(l.title) : undefined });
  const spaces = () => sideGroup('spaces', t('Spaces'), 'new-space', t('New space'), S.spaces.map((f) => ({ on: inMeetings && p.get('space') === f.id, html: navlink(`#/meetings?space=${f.id}`, icon('folder'), f.name, { count: f.notes, current: inMeetings && p.get('space') === f.id ? 'aria-current="page"' : '' }) })), t('Group meetings into spaces'));
  const tags = () => sideGroup('tags', t('Tags'), 'new-tag', t('New tag'), S.tags.map((tg) => ({ on: inMeetings && p.get('tag') === tg.id, html: `<a class="navlink" href="#/meetings?tag=${tg.id}" ${inMeetings && p.get('tag') === tg.id ? 'aria-current="page"' : ''} title="${esc(tg.name)}" data-tag="${tg.id}"><span class="tagdot" style="background:${tg.color}"></span><span class="lbl">${esc(tg.name)}</span><span class="count">${tg.notes || ''}</span></a>` })), t('No tags yet'));
  const section = (s) => (s.special === 'spaces' ? spaces() : s.special === 'tags' ? tags()
    : `${s.label ? `<div class="side-label">${t(s.label)}</div>` : ''}<nav class="nav">${s.links.map(link).join('')}</nav>${s.note ? `<p class="door-note">${t(s.note)}</p>` : ''}`);
  const rec = S.rec?.active;
  const collapsed = !!S.settings?.sidebarCollapsed;
  sidebar.innerHTML = `
    <nav class="rail" aria-label="${t('Main sections')}">
      <a class="rail-logo logo" href="#/" title="WhisperBrain" aria-label="WhisperBrain">${icon('logo')}</a>
      ${DOORS.map((d) => `<a class="door" href="${d.href}" ${d.id === open.id ? 'aria-current="page"' : ''} title="${esc(t(d.hint))}">${icon(d.icon)}<span>${esc(t(d.label))}</span></a>`).join('')}
      <span class="rail-spacer"></span>
      <button class="door rec-door${rec ? ' live' : ''}" data-act="${rec ? 'rec-open' : 'record'}" title="${esc(rec ? t('Go to the meeting being recorded') : t('Start recording a meeting'))}"><span class="rec-bubble">${rec ? '<span class="dot-rec"></span>' : icon('mic')}</span><span>${rec ? t('Recording') : t('Record')}</span></button>
      <button class="door rail-small" data-act="collapse" aria-pressed="${!collapsed}" title="${esc(collapsed ? t('Show the side panel') : t('Hide the side panel'))}" aria-label="${esc(collapsed ? t('Show the side panel') : t('Hide the side panel'))}">${icon('sidebar')}</button>
      <button class="rail-user" data-act="account-menu" aria-haspopup="menu" title="${esc(name)}" aria-label="${esc(name)}">${avatar(name)}</button>
    </nav>
    <div class="door-panel">
      <div class="door-head"><h2>${esc(t(open.label))}</h2><p>${esc(t(open.hint))}</p></div>
      <div class="side-scroll">${open.sections.map(section).join('')}</div>
      <div class="side-foot">
        <button class="usercard" data-act="account-menu" aria-haspopup="menu" title="${esc(name)}">${avatar(name, { cls: 'lg' })}<span class="who"><b>${esc(name)}</b><span>${esc(S.settings?.userEmail || S.settings?.google?.email || t('Everything stays on this device'))}</span></span><span class="chev">${icon('chevdown', 'sm')}</span></button>
      </div>
    </div>`;
}
let menuWasOpen = false;
sidebar.addEventListener('mousedown', (e) => { menuWasOpen = menuIsOpen() && !!e.target.closest('[data-act="account-menu"]'); }, true);
sidebar.addEventListener('click', async (e) => {
  const doorLink = e.target.closest('a.door');
  if (doorLink && appEl.classList.contains('drawer') && doorLink.getAttribute('href') !== (location.hash || '#/')) keepDrawer = true;
  const a = e.target.closest('[data-act]')?.dataset.act;
  if (!a) return;
  e.preventDefault();
  try {
    if (a === 'account-menu') {
      if (menuWasOpen) { menuWasOpen = false; return; }
      const el = e.target.closest('[data-act]');
      const m = menu(el, [
        { label: t('Integrations'), icon: 'plug', href: '#/integrations' },
        { label: t('Settings'), icon: 'settings', href: '#/settings' },
        ...(S.lock?.enabled ? ['sep', { label: t('Lock now'), icon: 'lock', run: async () => { await api('POST', '/api/lock/lock'); showLock(); } }] : []),
      ]);
      if (m) m.style.minWidth = `${el.offsetWidth}px`;
    }
    else if (a === 'side-toggle') { const k = e.target.closest('[data-group]').dataset.group; try { localStorage.setItem(`wb.side.${k}`, sideClosed(k) ? '1' : '0'); } catch { /* remembered for this view only */ } renderSidebar(); }
    else if (a === 'side-all') { const k = e.target.closest('[data-group]').dataset.group; if (!sideAll.delete(k)) sideAll.add(k); renderSidebar(); if (sideAll.has(k)) sidebar.querySelector(`[data-group="${k}"] .side-list`)?.scrollIntoView({ block: 'nearest' }); }
    else if (a === 'record') startRecording(null);
    else if (a === 'rec-open') go(`#/note/${S.rec.noteId}`);
    else if (a === 'collapse') { S.settings = await api('PUT', '/api/settings', { sidebarCollapsed: !S.settings.sidebarCollapsed }); applyTheme(); }
    else if (a === 'new-space') { const name = await promptDialog(t('New space'), '', { placeholder: t('e.g. Customers, Hiring, Product') }); if (name) { const sp = await api('POST', '/api/spaces', { name }); await refreshCounts(); go(`#/meetings?space=${sp.id}`); } }
    else if (a === 'new-tag') { const name = await promptDialog(t('New tag'), '', { placeholder: t('e.g. Important') }); if (name) { await api('POST', '/api/tags', { name }); await refreshCounts(); } }
  } catch (err) { fail(err); }
});
sidebar.addEventListener('contextmenu', (e) => {
  const tg = e.target.closest('[data-tag]');
  if (!tg) return;
  e.preventDefault();
  const tag = S.tags.find((x) => x.id === tg.dataset.tag);
  menu(tg, [
    { label: t('Rename'), icon: 'edit', run: async () => { const n = await promptDialog(t('Rename tag'), tag.name); if (n) { await api('PATCH', `/api/tags/${tag.id}`, { name: n }); refreshCounts(); } } },
    { label: t('Change colour'), icon: 'tag', run: async () => { const cols = ['#7c5cff', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#ec4899', '#14b8a6', '#64748b']; const i = (cols.indexOf(tag.color) + 1) % cols.length; await api('PATCH', `/api/tags/${tag.id}`, { color: cols[i] }); refreshCounts(); } },
    'sep',
    { label: t('Delete tag'), icon: 'trash', danger: true, run: async () => { if (await confirmDialog(t('Delete the tag “{name}”? Meetings keep everything else.', { name: tag.name }))) { await api('DELETE', `/api/tags/${tag.id}`); refreshCounts(); } } },
  ]);
});

// ---------- topbar ----------
export function renderTopbar() {
  const rec = S.rec.active;
  const det = S.detector?.active && !rec;
  topbar.innerHTML = `
    <button class="btn ghost icon menu-btn" data-top="drawer" aria-label="${t('Menu')}" aria-controls="sidebar" aria-expanded="${appEl.classList.contains('drawer')}">${icon('menu')}</button>
    <button class="searchpill" data-top="search">${icon('search')}<span>${t('Search meetings, topics, people, quotes…')}</span><kbd>${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'} K</kbd></button>
    <span class="spacer"></span>
    ${S.dictation === 'listening' ? `<button class="live-ind" data-top="dictation" title="${t('Dictation is listening. Click to stop.')}"><span class="dot-rec"></span><span class="t">${t('Dictating')}</span></button>` : ''}
    ${rec ? `<button class="live-ind" data-top="live"><span class="dot-rec"></span><span class="t">${t('Recording')}</span></button>` : det ? `<button class="live-ind detected" data-top="detected" aria-label="${esc(`${callLabel(S.detector) || t('Meeting')} · ${t('live')} — ${t('Take notes')}`)}">${icon('video', 'sm')}<span class="t">${esc(callLabel(S.detector) || t('Meeting'))} · ${t('live')}</span></button>` : ''}
    <button class="btn" data-top="import" title="${t('Import')}" aria-label="${t('Import')}">${icon('upload')}<span class="lbl-sm">${t('Import')}</span></button>
    ${rec ? '' : translateChip('data-top="translate"')}
    ${rec ? '' : `<button class="btn primary" data-top="record">${icon('mic')}<span class="lbl-sm">${t('Record')}</span></button>`}`;
  renderSidebar();   // the rail's Record button follows the recording too
}
topbar.addEventListener('click', async (e) => {
  const a = e.target.closest('[data-top]')?.dataset.top;
  if (!a) return;
  if (a === 'drawer') setDrawer(!appEl.classList.contains('drawer'));
  else if (a === 'search') openPalette();
  else if (a === 'import') openImport();
  else if (a === 'dictation') api('POST', '/api/dictation/toggle').catch(fail);
  else if (a === 'translate') {
    const noteId = /^#\/note\/([\w-]+)/.exec(location.hash)?.[1];
    translateMenu(e.target.closest('[data-top]'), { noteId: noteId && !(S.rec.active && S.rec.noteId === noteId) ? noteId : undefined });
  }
  else if (a === 'record') startRecording(null);
  else if (a === 'live') go(`#/note/${S.rec.noteId}`);
  else if (a === 'detected') recordDetected(S.detector);
});
$('.scrim').addEventListener('click', () => setDrawer(false));

// skip link: first stop for keyboard users (a button, so it never touches the hash router)
const skip = document.createElement('button');
skip.className = 'skip'; skip.type = 'button'; skip.textContent = t('Skip to content');
skip.addEventListener('click', () => main.focus());
document.body.prepend(skip);
main.addEventListener('scroll', () => topbar.classList.toggle('scrolled', main.scrollTop > 4), { passive: true });

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && appEl.classList.contains('drawer')) { setDrawer(false); $('[data-top="drawer"]')?.focus(); return; }
  const tab = e.target.closest?.('[role="tab"]');
  if (tab && !e.metaKey && !e.ctrlKey && !e.altKey && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
    const tabs = [...tab.closest('[role="tablist"]')?.querySelectorAll('[role="tab"]') || []];
    if (tabs.length > 1) {
      e.preventDefault();
      const i = tabs.indexOf(tab);
      tabs[e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length].focus();
      return;
    }
  }
  const mod = e.metaKey || e.ctrlKey;
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  else if (mod && e.key === '/') { e.preventDefault(); openPalette(); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 'r') { e.preventDefault(); S.rec.active ? stopRecording().catch(fail) : startRecording(null); }
  else if (mod && e.key.toLowerCase() === 'i' && !typing) { e.preventDefault(); openImport(); }
  else if (!typing && !mod && e.key === '/') { e.preventDefault(); openPalette(); }
  else if (!typing && !mod && e.key === 'g') { awaitingGo = true; setTimeout(() => { awaitingGo = false; }, 900); }
  else if (!typing && awaitingGo) {
    const to = { h: '#/', m: '#/meetings', c: '#/calendar', a: '#/actions', t: '#/topics', l: '#/glossary', p: '#/people', s: '#/settings' }[e.key];
    awaitingGo = false;
    if (to) go(to);
  }
});
let awaitingGo = false;

// ---------- live events ----------
function connectEvents() {
  const bump = () => window.dispatchEvent(new Event('wb:refresh'));
  const viewEvent = (type, data) => window.dispatchEvent(new CustomEvent('wb:event', { detail: { type, data } }));
  events({
    '*': (type, data) => viewEvent(type, data),
    open: async () => { try { syncRec(await api('GET', '/api/recording')); S.detector = await api('GET', '/api/detector'); S.dictation = (await api('GET', '/api/dictation').catch(() => null))?.state; renderTopbar(); } catch { /* server restarting */ } },
    ...recEvents({ renderTopbar }),
    'note.created': bump, 'note.deleted': (d) => { bump(); if (S.view.name === 'note' && S.view.parts[1] === d.id) go('#/'); },
    'knowledge.changed': bump, 'note.insights': bump, 'sources.changed': bump, 'people.changed': bump, 'assertions.changed': bump, 'reminders.changed': bump,
    'reminder.due': (d) => toast(d.text || t('{n} more things are waiting in your Inbox', { n: d.more }), { iconName: 'bell', timeout: 0, actions: [{ label: t('Open Inbox'), primary: true, run: () => go('#/inbox') }, { label: t('Later'), run: () => {} }] }),
    'account.changed': async () => { S.settings = await api('GET', '/api/settings'); applyTheme(); await refreshCounts(); go('#/'); },
    'capture.request': (d) => handleCaptureRequest(d),
    // dictation types into other apps: while it listens the top bar says so, so a forgotten microphone is never invisible
    'dictation.state': (d) => { if (S.dictation !== d.state) { S.dictation = d.state; renderTopbar(); } },
    'note.summarize-failed': (d) => fail(d.message),
    'note.insights-failed': (d) => toast(t('Could not extract topics: {m}', { m: d.message }), { error: true }),
    'meeting.detected': (d) => {
      S.detector = { active: true, apps: d.apps, platform: d.platform, platforms: d.platforms, title: d.title, event: d.event }; renderTopbar();
      S.detectToast?.remove(); S.detectToast = null;
      if (S.rec.active) return;
      const title = d.event?.summary || d.title;
      S.detectToast = toast(`${t('Meeting detected in {apps}', { apps: d.apps.join(', ') })}${title ? ` — ${title}` : ''}`, { iconName: 'video', timeout: 0, actions: [
        { label: t('Take notes'), primary: true, run: () => recordDetected(d) },
        { label: t('Not now'), run: () => {} }] });
    },
    // a second call joined or one left while the meeting goes on (Zoom and Discord at once)
    'meeting.apps-changed': (d) => {
      const joined = (d.platforms || []).filter((p) => !(S.detector?.platforms || []).includes(p));
      S.detector = { ...S.detector, active: true, apps: d.apps, platform: d.platform, platforms: d.platforms }; renderTopbar();
      if (S.rec.active && joined.length) toast(t('{call} is live too: capturing everything the call apps play.', { call: joined.map((p) => PLATFORMS[p] || p).join(' + ') }), { iconName: 'video' });
    },
    'meeting.ended': () => { S.detector = { active: false }; S.detectToast?.remove(); S.detectToast = null; renderTopbar(); if (S.rec.active) toast(t('The call ended. Stop recording?'), { timeout: 20000, actions: [{ label: t('Stop'), primary: true, run: () => stopRecording().catch(fail) }, { label: t('Keep recording'), run: () => {} }] }); },
    // A recording that started by itself stays announced until the person has dealt with the others: told them, or
    // stopped it. The toast has no close button on purpose, and it belongs to its recording: it goes when that one stops.
    'meeting.autostarted': (d) => {
      S.autoToast?.remove();
      const mine = () => S.rec.active && S.rec.noteId === d.noteId;
      S.autoToast = toast(t('Recording started automatically. Do the others on the call know?'), { ok: true, sticky: true, actions: [
        { label: t('Copy notice for the chat'), primary: true, keep: true, run: async () => { await copyNotice(); toast(t('Notice copied: paste it into the meeting chat, then choose “I told them”.'), { ok: true }); } },
        { label: t('I told them'), run: async () => { await setConsent(d.noteId, 'announced'); if (mine()) setRecConsent('announced', d.noteId); } },
        { label: t('Stop recording'), run: async () => { if (mine()) await stopRecording(); } },
      ] });
      bump(); if (d.noteId) go(`#/note/${d.noteId}`);
    },
    'meeting.autostart-failed': (d) => fail(d.message),
    'meeting.starting': (d) => { if (!S.rec.active && S.settings.captureCalendar === 'off') S.startingToast = toast(t('“{title}” is starting', { title: d.event.summary }), { iconName: 'calendar', timeout: 0, actions: [{ label: t('Take notes'), primary: true, run: () => takeNotesFor({ title: d.event.summary, uid: d.event.uid, start: d.event.start, attendees: d.event.attendees, url: d.event.url }, { record: true }) }, { label: t('Prepare'), keep: false, run: () => openBrief({ title: d.event.summary, start: d.event.start, attendees: d.event.attendees }) }, { label: t('Dismiss'), run: () => {} }] }); },
    'model.installed': async () => { S.state = await api('GET', '/api/state'); S.models = await api('GET', '/api/models'); },
    'model.error': (d) => fail(d.message),
    'import.done': (d) => { bump(); toast(t('Imported and transcribed ({n} lines)', { n: d.segments }), { ok: true, actions: [{ label: t('Open'), run: () => go(`#/note/${d.noteId}`) }] }); },
    'import.failed': (d) => { bump(); fail(d.message); },
    'export.done': (d) => toast(t('Sent to {targets}', { targets: d.targets.join(', ') }), { ok: true }),
    'export.failed': (d) => toast(`${d.target}: ${d.message}`, { error: true }),
    'google.connected': async (d) => { S.settings = await api('GET', '/api/settings'); toast(t('Google Calendar connected ({email})', { email: d.email || '' }), { ok: true }); viewEvent('google.connected', d); },
    'google.error': (d) => fail(d.message),
    'dictation.error': (d) => fail(d.message),
    'dictation.result': (d) => { if (d.text) toast(`🎙 ${d.text}`, { timeout: 4000 }); },
    settings: async () => { S.settings = await api('GET', '/api/settings'); applyTheme(); renderSidebar(); renderTopbar(); renderRecbar(); },
  });
}

// ---------- drag & drop import anywhere ----------
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  dragDepth = 0; document.body.classList.remove('dragging');
  if (!e.dataTransfer?.files?.length || e.target.closest('.dropzone')) return;
  e.preventDefault();
  openImport({ files: [...e.dataTransfer.files] });
});

// ---------- the app lock ----------
// While locked the app answers only this screen. (It keeps recording if a recording was already running.)
function showLock() {
  if ($('#lockscreen')) return;
  const el = document.createElement('div');
  el.id = 'lockscreen';
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', t('Locked'));
  el.innerHTML = `<form class="lock-card"><span class="logo">${icon('logo')}</span><h1>WhisperBrain</h1><p class="muted">${t('Locked. Enter your passphrase.')}</p>
    <input type="password" id="lock-pass" autocomplete="current-password" aria-label="${t('Passphrase')}" autofocus><div class="small lock-err" id="lock-err" role="alert"></div>
    <button class="btn primary" type="submit">${icon('lock', 'sm')} ${t('Unlock')}</button></form>`;
  document.body.append(el);
  const input = el.querySelector('#lock-pass'); input.focus();
  el.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/lock/unlock', { passphrase: input.value }); location.reload(); } catch (err) { el.querySelector('#lock-err').textContent = err.message; input.select(); }
  });
}
window.addEventListener('wb:locked', showLock);

// ---------- boot ----------
async function boot() {
  try {
    [S.settings, S.state, S.templates, S.models] = await Promise.all([api('GET', '/api/settings'), api('GET', '/api/state'), api('GET', '/api/templates'), api('GET', '/api/models')]);
    S.detector = S.state.detector;
    S.lock = await api('GET', '/api/lock').catch(() => null);
    applyTheme();
    await refreshCounts();
    syncRec(S.state.recording);
    renderTopbar();
    connectEvents();
    // Settings › Appearance › Start page: open on the meetings list instead of Home (only when the app opens on Home)
    if (S.settings.startPage === 'meetings' && /^#?\/?$/.test(location.hash)) history.replaceState(null, '', '#/meetings');   // no hashchange: route() below reads it
    route();
    setupOnFirstRun();   // the first launch only, and only if something needs attention
  } catch (e) {
    if (e instanceof ApiError && e.status === 423) { showLock(); return; }
    main.innerHTML = `<div class="page"><div class="banner warn mt">${icon('alert')}<div class="grow">${esc(e.message)} — ${e instanceof ApiError && e.status === 401 ? 'open the app from its launcher or the printed login URL.' : 'is the server running?'}</div></div></div>`;
  }
}
Object.assign(window, { wb: { openImport, openExport, openPalette, go, startRec: () => startRecording(null) } });
boot();
