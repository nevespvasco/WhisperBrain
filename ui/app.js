import { S, $, $$, api, t, esc, icon, toast, fail, go, avatar, debounce, menu, menuIsOpen, promptDialog, confirmDialog, PLATFORMS } from './lib.js';
import { setLang } from './i18n.js';
import { events, ApiError } from './api.js';
import { startRecording, stopRecording, renderRecbar, syncRec, handleCaptureRequest, takeNotesFor, recEvents, setRecConsent } from './recording.js';
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
import * as people from './views/people.js';
import * as chat from './views/chat.js';
import * as integrations from './views/integrations.js';
import * as settings from './views/settings.js';

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
  '': home, meetings, note, calendar, actions, topics, topic: topics, glossary, term: glossary, people, person: people, chat, integrations, settings,
};
async function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [path, qs] = hash.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(qs || '');
  let name = parts[0] || '';
  if (name === 'space' && parts[1]) { params.set('space', parts[1]); name = 'meetings'; }
  if (name === 'search') { openPalette(params.get('q') || ''); name = ''; }
  const view = ROUTES[name] || home;
  S.view = { name: name || 'home', parts, params };
  setDrawer(false);
  renderSidebar();
  main.scrollTop = 0;
  const slow = setTimeout(() => { appEl.classList.add('loading'); main.setAttribute('aria-busy', 'true'); }, 220);
  try { await view.render(main, { parts, params, name }); } catch (e) {
    if (e instanceof ApiError && e.status === 404) { toast(t('That item no longer exists.'), { error: true }); go('#/'); return; }
    fail(e);
    main.innerHTML = `<div class="page"><div class="banner danger mt" role="alert">${icon('alert')}<div class="grow">${esc(e.message)}</div><a class="btn sm" href="#/">${t('Home')}</a></div></div>`;
  } finally {
    clearTimeout(slow);
    appEl.classList.remove('loading'); main.removeAttribute('aria-busy');
  }
}
window.addEventListener('hashchange', route);

// ---------- sidebar ----------
const cur = (names, extra = () => true) => (names.includes(S.view.name) && extra() ? 'aria-current="page"' : '');
function navlink(href, ic, label, { count, current = '', title } = {}) {
  return `<a class="navlink" href="${href}" ${current} title="${esc(title || label)}">${ic}<span class="lbl">${esc(label)}</span>${count ? `<span class="count">${count}</span>` : ''}</a>`;
}
export function renderSidebar() {
  const st = S.state?.stats || {};
  const src = S.state?.sources || {};
  const p = S.view.params || new URLSearchParams();
  const inMeetings = S.view.name === 'meetings';
  const imported = Object.entries(src).filter(([k]) => !['recorded', 'manual'].includes(k)).reduce((a, [, v]) => a + v, 0);
  const name = S.settings?.userName || t('Local account');
  sidebar.innerHTML = `
    <div class="brand"><span class="logo">${icon('logo')}</span><span class="name">WhisperBrain</span>
      <button class="btn ghost icon sm collapse-btn" data-act="collapse" title="${t('Collapse sidebar')}" aria-label="${t('Collapse sidebar')}">${icon('sidebar')}</button></div>
    <div class="side-scroll">
      <nav class="nav" aria-label="${t('Workspace')}">
        ${navlink('#/', icon('home'), t('Home'), { current: cur(['home']) })}
        ${navlink('#/meetings', icon('video'), t('Meetings'), { count: st.notes, current: inMeetings && ![...p.keys()].length ? 'aria-current="page"' : '' })}
        ${navlink('#/calendar', icon('calendar'), t('Calendar'), { current: cur(['calendar']) })}
        ${navlink('#/actions', icon('list'), t('Action items'), { count: st.openActions, current: cur(['actions']) })}
        ${navlink('#/chat', icon('sparkles'), t('Ask AI'), { current: cur(['chat']) })}
      </nav>
      <div class="side-label">${t('Knowledge')}</div>
      <nav class="nav">
        ${navlink('#/topics', icon('network'), t('Topics'), { count: st.topics, current: cur(['topics', 'topic']) })}
        ${navlink('#/glossary', icon('book'), t('Glossary'), { count: st.glossary, current: cur(['glossary', 'term']) })}
        ${navlink('#/people', icon('users'), t('People'), { current: cur(['people', 'person']) })}
      </nav>
      <div class="side-label">${t('Spaces')}<button class="btn ghost icon xs" data-act="new-space" title="${t('New space')}" aria-label="${t('New space')}">${icon('plus', 'sm')}</button></div>
      <nav class="nav">${S.spaces.map((f) => navlink(`#/meetings?space=${f.id}`, icon('folder'), f.name, { count: f.notes, current: inMeetings && p.get('space') === f.id ? 'aria-current="page"' : '' })).join('') || `<div class="xsmall faint side-more" style="padding:2px 10px">${t('Group meetings into spaces')}</div>`}</nav>
      <div class="side-label">${t('Tags')}<button class="btn ghost icon xs" data-act="new-tag" title="${t('New tag')}" aria-label="${t('New tag')}">${icon('plus', 'sm')}</button></div>
      <nav class="nav">${S.tags.map((tg) => `<a class="navlink" href="#/meetings?tag=${tg.id}" ${inMeetings && p.get('tag') === tg.id ? 'aria-current="page"' : ''} title="${esc(tg.name)}" data-tag="${tg.id}"><span class="tagdot" style="background:${tg.color}"></span><span class="lbl">${esc(tg.name)}</span><span class="count">${tg.notes || ''}</span></a>`).join('') || `<div class="xsmall faint side-more" style="padding:2px 10px">${t('No tags yet')}</div>`}</nav>
      <div class="side-label">${t('Sources')}</div>
      <nav class="nav">
        ${navlink('#/meetings?source=local', icon('mic'), t('Recorded here'), { count: (src.recorded || 0) + (src.manual || 0), current: inMeetings && p.get('source') === 'local' ? 'aria-current="page"' : '' })}
        ${navlink('#/meetings?source=imported', icon('inbox'), t('From outside'), { count: imported, current: inMeetings && p.get('source') === 'imported' ? 'aria-current="page"' : '' })}
        ${navlink('#/meetings?external=1', icon('globe'), t('External meetings'), { current: inMeetings && p.get('external') === '1' ? 'aria-current="page"' : '', title: t('Meetings with people outside your organisation') })}
      </nav>
    </div>
    <div class="side-foot">
      <button class="usercard" data-act="account-menu" aria-haspopup="menu" title="${esc(name)}">${avatar(name, { cls: 'lg' })}<span class="who"><b>${esc(name)}</b><span>${esc(S.settings?.userEmail || S.settings?.google?.email || t('Everything stays on this device'))}</span></span><span class="chev">${icon('chevdown', 'sm')}</span></button>
    </div>`;
}
let menuWasOpen = false;
sidebar.addEventListener('mousedown', (e) => { menuWasOpen = menuIsOpen() && !!e.target.closest('[data-act="account-menu"]'); }, true);
sidebar.addEventListener('click', async (e) => {
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
      ]);
      m.style.minWidth = `${el.offsetWidth}px`;
    }
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
    ${rec ? `<button class="live-ind" data-top="live"><span class="dot-rec"></span><span class="t">${t('Recording')}</span></button>` : det ? `<button class="live-ind detected" data-top="detected" aria-label="${esc(`${PLATFORMS[S.detector.platform] || S.detector.apps?.[0] || t('Meeting')} · ${t('live')} — ${t('Take notes')}`)}">${icon('video', 'sm')}<span class="t">${esc(PLATFORMS[S.detector.platform] || S.detector.apps?.[0] || t('Meeting'))} · ${t('live')}</span></button>` : ''}
    <button class="btn" data-top="import" title="${t('Import')}" aria-label="${t('Import')}">${icon('upload')}<span class="lbl-sm">${t('Import')}</span></button>
    ${rec ? '' : `<button class="btn primary" data-top="record">${icon('mic')}<span class="lbl-sm">${t('Record')}</span></button>`}`;
}
topbar.addEventListener('click', async (e) => {
  const a = e.target.closest('[data-top]')?.dataset.top;
  if (!a) return;
  if (a === 'drawer') setDrawer(!appEl.classList.contains('drawer'));
  else if (a === 'search') openPalette();
  else if (a === 'import') openImport();
  else if (a === 'record') startRecording(null);
  else if (a === 'live') go(`#/note/${S.rec.noteId}`);
  else if (a === 'detected') takeNotesFor(S.detector.event ? { title: S.detector.event.summary, uid: S.detector.event.uid, start: S.detector.event.start, attendees: S.detector.event.attendees, platform: S.detector.platform } : { platform: S.detector.platform, title: S.detector.title || '' }, { record: true });
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
    open: async () => { try { syncRec(await api('GET', '/api/recording')); S.detector = await api('GET', '/api/detector'); renderTopbar(); } catch { /* server restarting */ } },
    ...recEvents({ renderTopbar }),
    'note.created': bump, 'note.deleted': (d) => { bump(); if (S.view.name === 'note' && S.view.parts[1] === d.id) go('#/'); },
    'knowledge.changed': bump, 'note.insights': bump,
    'account.changed': async () => { S.settings = await api('GET', '/api/settings'); applyTheme(); await refreshCounts(); go('#/'); },
    'capture.request': (d) => handleCaptureRequest(d),
    'note.summarize-failed': (d) => fail(d.message),
    'note.insights-failed': (d) => toast(t('Could not extract topics: {m}', { m: d.message }), { error: true }),
    'meeting.detected': (d) => {
      S.detector = { active: true, apps: d.apps, platform: d.platform, title: d.title, event: d.event }; renderTopbar();
      if (S.rec.active) return;
      const title = d.event?.summary || d.title;
      toast(`${t('Meeting detected in {apps}', { apps: d.apps.join(', ') })}${title ? ` — ${title}` : ''}`, { iconName: 'video', timeout: 0, actions: [
        { label: t('Take notes'), primary: true, run: () => takeNotesFor(d.event ? { title: d.event.summary, uid: d.event.uid, start: d.event.start, attendees: d.event.attendees, platform: d.platform, url: d.event.url } : { platform: d.platform, title: '' }, { record: true }) },
        { label: t('Not now'), run: () => {} }] });
    },
    'meeting.ended': () => { S.detector = { active: false }; renderTopbar(); if (S.rec.active) toast(t('The call ended. Stop recording?'), { timeout: 20000, actions: [{ label: t('Stop'), primary: true, run: () => stopRecording().catch(fail) }, { label: t('Keep recording'), run: () => {} }] }); },
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
    'meeting.starting': (d) => { if (!S.rec.active && S.settings.captureCalendar === 'off') toast(t('“{title}” is starting', { title: d.event.summary }), { iconName: 'calendar', timeout: 0, actions: [{ label: t('Take notes'), primary: true, run: () => takeNotesFor({ title: d.event.summary, uid: d.event.uid, start: d.event.start, attendees: d.event.attendees, url: d.event.url }, { record: true }) }, { label: t('Dismiss'), run: () => {} }] }); },
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
    settings: async () => { S.settings = await api('GET', '/api/settings'); applyTheme(); renderSidebar(); },
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

// ---------- boot ----------
async function boot() {
  try {
    [S.settings, S.state, S.templates, S.models] = await Promise.all([api('GET', '/api/settings'), api('GET', '/api/state'), api('GET', '/api/templates'), api('GET', '/api/models')]);
    S.detector = S.state.detector;
    applyTheme();
    await refreshCounts();
    syncRec(S.state.recording);
    renderTopbar();
    connectEvents();
    route();
  } catch (e) {
    main.innerHTML = `<div class="page"><div class="banner warn mt">${icon('alert')}<div class="grow">${esc(e.message)} — ${e instanceof ApiError && e.status === 401 ? 'open the app from its launcher or the printed login URL.' : 'is the server running?'}</div></div></div>`;
  }
}
Object.assign(window, { wb: { openImport, openExport, openPalette, go, startRec: () => startRecording(null) } });
boot();
