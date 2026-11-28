// Shared UI state and building blocks: formatting, toasts, dialogs, popover menus, avatars, cards.
import { api, ApiError } from './api.js';
import { t, tHtml, getLang } from './i18n.js';
import { esc, safeUrl } from './md.js';
import { icon } from './icons.js';

export { api, ApiError, t, tHtml, esc, safeUrl, icon };
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const S = {
  settings: null, state: null, models: [], templates: [], spaces: [], tags: [], counts: {}, view: { name: 'home' },
  rec: { active: false }, level: { mic: 0, system: 0 }, liveText: '', liveDraft: '', drafts: {}, detector: null, streaming: null, integrations: null,
};

// ---------- formatting ----------
export const loc = () => (getLang() === 'pt' ? 'pt-PT' : undefined);
export const fmtDur = (ms) => { if (ms > 0 && ms < 60000) return `${Math.max(1, Math.round(ms / 1000))}s`; const m = Math.round((ms || 0) / 60000); if (m < 60) return `${m}m`; return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
export const fmtClock = (ms) => { const s = Math.floor((ms || 0) / 1000); const h = Math.floor(s / 3600); const p = (n) => String(n).padStart(2, '0'); return h ? `${h}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${Math.floor(s / 60)}:${p(s % 60)}`; };
export const fmtTimer = (ms) => { const s = Math.floor(ms / 1000); const p = (n) => String(n).padStart(2, '0'); const h = Math.floor(s / 3600); return h ? `${h}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${p(Math.floor(s / 60))}:${p(s % 60)}`; };
export const fmtDate = (ms, opts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) => new Date(ms).toLocaleDateString(loc(), opts);
export const fmtHour = (ms) => new Date(ms).toLocaleTimeString(loc(), { hour: '2-digit', minute: '2-digit' });
export const dayStart = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
export function relDay(ms) {
  const d0 = dayStart(), d = dayStart(new Date(ms));
  if (d === d0) return t('Today');
  if (d === d0 - 86400000) return t('Yesterday');
  if (d === d0 + 86400000) return t('Tomorrow');
  return fmtDate(ms, { weekday: 'short', day: 'numeric', month: 'short' });
}
export function dateGroup(ms) {
  const d0 = dayStart();
  if (ms >= d0) return t('Today');
  if (ms >= d0 - 86400000) return t('Yesterday');
  if (ms >= d0 - 7 * 86400000) return t('Last week');
  if (ms >= d0 - 30 * 86400000) return t('Last month');
  return new Date(ms).toLocaleDateString(loc(), { month: 'long', year: 'numeric' });
}
export function groupBy(items, keyFn) {
  const out = [];
  for (const it of items) { const k = keyFn(it); let g = out.find((x) => x.key === k); if (!g) { g = { key: k, items: [] }; out.push(g); } g.items.push(it); }
  return out;
}
export const debounce = (fn, ms) => { let id; return (...a) => { clearTimeout(id); id = setTimeout(() => fn(...a), ms); }; };
export const plural = (n, one, many) => `${n} ${n === 1 ? t(one) : t(many)}`;
export const safeSnippet = (html) => String(html || '').replace(/#{1,6}\s+|\*\*/g, '').replace(/&/g, '&amp;').replace(/<(?!\/?mark>)/g, '&lt;');

// ---------- colours ----------
const PALETTE = ['#7c5cff', '#ef6f6c', '#f59e0b', '#10b981', '#3b82f6', '#ec4899', '#14b8a6', '#8b5cf6', '#f97316', '#0ea5e9', '#84cc16', '#e11d48'];
export function hashColor(s) { let h = 0; for (const c of String(s || '?')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; }
// What a speaker or a line is called on screen. The server decides who is shown and numbered (src/speakers/display.js) and
// says how to write it ('name' | 'me' | 'speaker' | 'room' | 'room-hidden' | 'them', plus the number); the words come from t().
export function speakerText({ name = '', kind = 'them', n = null } = {}) {
  if (name) return name;
  switch (kind) {
    case 'me': return S.settings?.userName || t('Me');
    case 'speaker': return t('Speaker {n}', { n });
    case 'room': return t('Room speaker {n}', { n });
    case 'room-hidden': return t('Someone in the room');
    default: return t('Them');
  }
}
// ...of a line (a transcript segment, or the transcript.segment event) and of an entry of a note's speaker list
export const lineText = (s) => speakerText({ name: s.speakerName || (s.labelKind === 'name' ? s.label : ''), kind: s.labelKind || (s.speaker === 'me' ? 'me' : 'them'), n: s.displayNo });
export const speakerEntryText = (x) => speakerText({ name: x.name || x.voiceName, kind: x.labelKind || (x.channel === 'mic' ? 'me' : 'them'), n: x.displayNo });
export function speakerColor(id, label) { if (!id || !/^[ms]\d+$/.test(id)) return hashColor(label || id); const n = id[0] === 'm' ? Number(id.slice(1)) - 1 : 2 + Number(id.slice(1)); return PALETTE[((n % PALETTE.length) + PALETTE.length) % PALETTE.length]; }
export function initials(name) { const w = String(name || '?').trim().split(/\s+/).filter(Boolean); return ((w[0]?.[0] || '?') + (w.length > 1 ? w[w.length - 1][0] : w[0]?.[1] || '')).toUpperCase(); }
const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
export const inkOn = (hex) => (/^#[0-9a-f]{6}$/i.test(hex) && 1.05 / (lum(hex) + .05) < (lum(hex) + .05) / 0.06 ? '#1c1a29' : '#fff');
export const avatar = (name, { cls = '', color } = {}) => { const bg = color || hashColor(name); return `<span class="av ${cls}" style="background:${bg};color:${inkOn(bg)}" title="${esc(name)}">${esc(initials(name))}</span>`; };
export function avatarStack(names, max = 4) {
  if (!names?.length) return '';
  const shown = names.slice(0, max);
  return `<span class="avstack">${shown.map((n) => avatar(n, { cls: 'sm' })).join('')}${names.length > max ? `<span class="more">+${names.length - max}</span>` : ''}</span>`;
}

// ---------- sources ----------
export const SOURCES = {
  recorded: { icon: 'mic', label: 'Recorded' }, manual: { icon: 'edit', label: 'Notes only' }, audio: { icon: 'waves', label: 'Audio file' },
  file: { icon: 'file', label: 'Imported file' }, notion: { icon: 'doc', label: 'Notion' }, obsidian: { icon: 'book', label: 'Obsidian' },
  linear: { icon: 'checksq', label: 'Linear' }, calendar: { icon: 'calendar', label: 'Calendar' },
};
export const PLATFORMS = { zoom: 'Zoom', meet: 'Google Meet', teams: 'Microsoft Teams', slack: 'Slack', discord: 'Discord', webex: 'Webex', whereby: 'Whereby', jitsi: 'Jitsi', facetime: 'FaceTime', browser: 'Browser' };
// "Zoom + Discord": every call that is live, not only the first (a detector status/event: { platforms, platform, apps })
export const callLabel = (d) => {
  const names = (d?.platforms?.length ? d.platforms : [d?.platform]).filter(Boolean).map((p) => PLATFORMS[p] || null);
  const known = names.filter(Boolean);
  return (known.length ? known : (d?.apps || []).slice(0, 2)).join(' + ');
};
export const srcIcon = (src) => `<span class="srcicon" title="${esc(t(SOURCES[src]?.label || src))}">${icon(SOURCES[src]?.icon || 'file')}</span>`;

// ---------- toasts ----------
// sticky: no close button and no timeout; it goes away only when one of its actions is used
export function toast(message, { error = false, ok = false, actions = [], timeout = 6000, iconName, sticky = false } = {}) {
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}${ok ? ' ok' : ''}${sticky ? ' sticky' : ''}`;
  el.setAttribute('role', error ? 'alert' : 'status');
  el.innerHTML = `<div class="msg"><span class="ti">${icon(iconName || (error ? 'alert' : ok ? 'ok' : 'info'))}</span><div class="grow">${esc(message)}</div>${sticky ? '' : `<button class="btn ghost icon xs" aria-label="${t('Dismiss')}">${icon('x', 'sm')}</button>`}</div>`;
  if (!sticky) el.querySelector('.msg button').onclick = () => el.remove();
  if (actions.length) {
    const row = document.createElement('div'); row.className = 'row';
    for (const a of actions) { const b = document.createElement('button'); b.className = `btn sm${a.primary ? ' primary' : ''}`; b.textContent = a.label; b.onclick = sticky ? () => stickyAction(el, a) : () => { el.remove(); a.run(); }; row.append(b); }
    el.append(row);
  }
  $('#toasts').append(el);
  // Too many on screen: the oldest ordinary one goes. A sticky toast is never evicted (it is there to be answered).
  while ($('#toasts').children.length > 4) { const old = $('#toasts').querySelector('.toast:not(.sticky)'); if (!old) break; old.remove(); }
  if (timeout && !sticky) setTimeout(() => el.remove(), timeout);
  return el;
}
// A sticky toast stays until its action has worked: if it fails the toast is still there to try again. An action with
// keep: true (e.g. copying text) leaves it in place after it worked.
async function stickyAction(el, a) {
  const buttons = el.querySelectorAll('.row button');
  buttons.forEach((b) => { b.disabled = true; });
  try { await a.run(); if (a.keep) buttons.forEach((b) => { b.disabled = false; }); else el.remove(); } catch (e) { buttons.forEach((b) => { b.disabled = false; }); fail(e); }
}
export const fail = (e) => { console.error(e?.stack || (e?.name ? `${e.name}: ${e.message}` : e));   // a DOMException otherwise logs as "[object DOMException]"
  return toast(e?.message ? e.message : String(e), { error: true, timeout: 9000 }); };
export const done = (msg = t('Done')) => toast(msg, { ok: true, timeout: 3000 });

// ---------- dialogs ----------
// modal({ title, body, foot, wide, onMount }) → Promise resolving with the value passed to close(v).
export function modal({ title = '', body = '', foot = '', wide = false, cls = '', onMount } = {}) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = `${wide ? 'wide' : ''} ${cls}`;
    d.innerHTML = `<div class="dlg">${title !== null ? `<div class="dlg-head"><h2>${esc(title)}</h2><button class="btn ghost icon sm" data-close aria-label="${t('Close')}">${icon('x')}</button></div>` : ''}<div class="dlg-body">${body}</div>${foot ? `<div class="dlg-foot">${foot}</div>` : ''}</div>`;
    document.body.append(d);
    let value;
    const close = (v) => { value = v; d.close(); };
    d.addEventListener('close', () => { d.remove(); resolve(value); });
    d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) close(undefined); });
    d.showModal();
    onMount?.(d, close);
  });
}

export function confirmDialog(message, { ok = t('Delete'), danger = true, title = t('Are you sure?') } = {}) {
  return modal({
    title, body: `<p style="margin:0">${esc(message)}</p>`,
    foot: `<button class="btn" data-close>${t('Cancel')}</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(ok)}</button>`,
    onMount: (d, close) => { const b = $('[data-ok]', d); b.onclick = () => close(true); b.focus(); },
  }).then((v) => v === true);
}

export function promptDialog(title, value = '', { ok = t('Save'), placeholder = '', hint = '', extra = '', multiline = false } = {}) {
  return modal({
    title,
    body: `<form class="stack" id="pf">${multiline ? `<textarea id="pf-in" placeholder="${esc(placeholder)}">${esc(value)}</textarea>` : `<input id="pf-in" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off">`}${hint ? `<div class="hint">${esc(hint)}</div>` : ''}${extra}</form>`,
    foot: `<button class="btn" data-close>${t('Cancel')}</button><button class="btn primary" data-ok>${esc(ok)}</button>`,
    onMount: (d, close) => {
      const input = $('#pf-in', d);
      const submit = () => close({ value: input.value.trim(), dialog: d, data: Object.fromEntries([...d.querySelectorAll('[name]')].map((x) => [x.name, x.type === 'checkbox' ? x.checked : x.value])) });
      $('[data-ok]', d).onclick = submit;
      $('#pf', d).onsubmit = (e) => { e.preventDefault(); submit(); };
      input.focus(); input.select?.();
      d.addEventListener('click', (e) => { const s = e.target.closest('[data-suggest]'); if (s) { input.value = s.dataset.suggest; input.focus(); } });
    },
  }).then((r) => (r && !extra ? r.value : r));
}

// ---------- popover menu ----------
let openMenu = null, openAnchor = null;
// Where a popover goes: a showModal() dialog sits in the top layer and makes the rest of the page inert, so a list opened from
// a field inside it must live inside it too or it can be seen but not clicked. position: fixed still places it on the viewport.
const layerOf = (anchor) => anchor?.closest?.('dialog[open]') || document.body;
// A popover removed from under us (its dialog closed, a page redraw) settles its promise: watch its layer and, for a dialog, the body
function settleWhenGone(m, host, finish) {
  const obs = new MutationObserver(() => { if (!m.isConnected) { obs.disconnect(); finish(undefined); } });
  obs.observe(host, { childList: true });
  if (host !== document.body) obs.observe(document.body, { childList: true });
}
export function closeMenu() { openMenu?.remove(); openAnchor?.removeAttribute('aria-expanded'); openMenu = null; openAnchor = null; }
export const menuIsOpen = () => !!openMenu;
// items: [{ label, icon, run, danger, disabled, selected, href } | 'sep' | { header }]
export function menu(anchor, items, { align = 'start' } = {}) {
  if (toggledOff?.anchor === anchor && Date.now() - toggledOff.at < 600) { toggledOff = null; return null; }
  closeMenu();
  const m = document.createElement('div');
  m.className = 'menu';
  m.setAttribute('role', 'menu');
  m.innerHTML = items.map((it, i) => {
    if (it === 'sep') return '<div class="sep"></div>';
    if (it.header) return `<div class="mh">${esc(it.header)}</div>`;
    const cls = `${it.danger ? 'danger' : ''} ${it.selected ? 'sel' : ''}`;
    if (it.href) return `<a role="menuitem" class="${cls}" href="${esc(it.href)}" ${it.download ? 'download' : ''} ${it.external ? 'target="_blank" rel="noopener noreferrer"' : ''} data-i="${i}">${it.icon ? icon(it.icon) : ''}<span class="grow ellipsis">${esc(it.label)}</span></a>`;
    return `<button role="menuitem" class="${cls}" data-i="${i}" ${it.disabled ? 'disabled' : ''}>${it.icon ? icon(it.icon) : ''}<span class="grow ellipsis">${esc(it.label)}</span>${it.hint ? `<span class="xsmall faint">${esc(it.hint)}</span>` : ''}</button>`;
  }).join('');
  layerOf(anchor).append(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let left = align === 'end' ? r.right - mw : r.left;
  left = Math.max(8, Math.min(left, innerWidth - mw - 8));
  // below the button if it fits, else above; a menu taller than either side scrolls on the roomier one
  const below = innerHeight - 8 - (r.bottom + 6), above = r.top - 6 - 8;
  let top = r.bottom + 6;
  if (mh > below) {
    if (mh <= above) top = r.top - 6 - mh;
    else { const room = Math.max(below, above); m.style.maxHeight = `${room}px`; m.style.overflowY = 'auto'; top = below >= above ? r.bottom + 6 : 8; }
  }
  m.style.left = `${left}px`; m.style.top = `${top}px`;
  m.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-i]');
    if (!el) return;
    const it = items[Number(el.dataset.i)];
    if (!it.href) e.preventDefault();
    closeMenu();
    try { await it.run?.(); } catch (err) { fail(err); }
  });
  m.addEventListener('keydown', (e) => {
    const btns = [...m.querySelectorAll('button:not(:disabled), a')];
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length]?.focus(); }
    else if (e.key === 'Escape') { closeMenu(); anchor.focus(); }
  });
  openMenu = m; openAnchor = anchor; anchor.setAttribute('aria-expanded', 'true');
  setTimeout(() => m.querySelector('button:not(:disabled), a')?.focus(), 0);
  return m;
}
// Pressing the button that opened the menu closes it (the press closes it here; the click that follows must not reopen it).
let toggledOff = null;
document.addEventListener('mousedown', (e) => {
  if (!openMenu || openMenu.contains(e.target)) return;
  toggledOff = openAnchor?.contains(e.target) ? { anchor: openAnchor, at: Date.now() } : null;
  closeMenu();
});
window.addEventListener('resize', closeMenu);
document.addEventListener('scroll', (e) => { if (!openMenu?.contains(e.target)) closeMenu(); }, true);

// A list to pick one value from: people, languages, any <select>. A search box appears once the list is long (20 people
// on a call), the current value is ticked, and with `custom` whatever is typed can be used as is.
// items: [{ value, label, hint, avatar, header }]. Resolves with the chosen value, or undefined when dismissed.
export function pickFrom(anchor, items, { current, placeholder, custom, search = items.length > 8, width } = {}) {
  closeMenu();
  return new Promise((resolve) => {
    const m = document.createElement('div');
    m.className = 'menu picker';
    m.setAttribute('role', 'dialog');
    const r = anchor.getBoundingClientRect();
    m.style.minWidth = `${Math.max(width || 0, r.width, 220)}px`;
    m.innerHTML = `${search || custom ? `<div class="pk-search">${icon('search', 'sm')}<input type="search" autocomplete="off" placeholder="${esc(placeholder || t('Search…'))}" aria-label="${esc(placeholder || t('Search…'))}"></div>` : ''}<div class="pk-list" role="listbox"></div>`;
    const list = m.querySelector('.pk-list'), input = m.querySelector('input');
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; if (openMenu === m) { closeMenu(); anchor.focus?.(); } else m.remove(); resolve(v); };
    const draw = () => {
      const q = (input?.value || '').trim().toLowerCase();
      const shown = items.filter((it) => it.header ? !q : !q || `${it.label} ${it.hint || ''}`.toLowerCase().includes(q));
      const exact = items.some((it) => !it.header && String(it.value).toLowerCase() === q);
      list.innerHTML = shown.map((it) => it.header ? `<div class="mh">${esc(it.header)}</div>` : `<button type="button" role="option" class="${String(it.value) === String(current ?? '') ? 'sel' : ''}" aria-selected="${String(it.value) === String(current ?? '')}" data-v="${esc(it.value)}" ${it.disabled ? 'disabled' : ''}>${it.avatar ? avatar(it.avatar, { cls: 'xs' }) : ''}<span class="grow ellipsis">${esc(it.label)}</span>${it.hint ? `<span class="xsmall faint">${esc(it.hint)}</span>` : ''}</button>`).join('')
        + (custom && q && !exact ? `<button type="button" role="option" class="pk-custom" data-v="${esc(input.value.trim())}">${icon('plus', 'sm')}<span class="grow ellipsis">${esc(custom.replace('{name}', input.value.trim()))}</span></button>` : '')
        || `<div class="pk-none xsmall faint">${t('No matches')}</div>`;
    };
    draw();
    const host = layerOf(anchor);
    host.append(m);
    const place = () => {
      const mw = m.offsetWidth, mh = m.offsetHeight;
      const left = Math.max(8, Math.min(r.left, innerWidth - mw - 8));
      let top = r.bottom + 6;
      if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 6);
      m.style.left = `${left}px`; m.style.top = `${top}px`;
    };
    place();
    const opts = () => [...list.querySelectorAll('button:not(:disabled)')];
    input?.addEventListener('input', () => { draw(); opts()[0]?.classList.add('kb'); });
    m.addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b) finish(b.dataset.v); });
    m.addEventListener('keydown', (e) => {
      const bs = opts(), i = bs.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); bs[(i + 1) % bs.length]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (i <= 0 && input) input.focus(); else bs[(i - 1 + bs.length) % bs.length]?.focus(); }
      else if (e.key === 'Enter' && e.target === input) { e.preventDefault(); const b = list.querySelector('.kb') || bs[0]; if (b) finish(b.dataset.v); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(undefined); }
      else if (e.key === 'Tab') finish(undefined);
    });
    openMenu = m; openAnchor = anchor; anchor.setAttribute('aria-expanded', 'true');
    settleWhenGone(m, host, finish);
    setTimeout(() => (input || list.querySelector('.sel') || opts()[0])?.focus(), 0);
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  });
}

// A calendar to pick one day from, drawn in the app's own style (the system one ignores the theme). Resolves to 'YYYY-MM-DD',
// '' when the date is cleared, or undefined when it is dismissed. min: first day that can be picked.
export function pickDate(anchor, { current = '', min = '', clearable = true } = {}) {
  closeMenu();
  return new Promise((resolve) => {
    const iso = (d) => new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
    const today = iso(new Date());
    const parse = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? new Date(`${v}T12:00:00`) : null);
    const start = parse(current) || parse(min > today ? min : today) || new Date();
    let y = start.getFullYear(), mo = start.getMonth();
    const m = document.createElement('div');
    m.className = 'menu datepick';
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-label', t('Due date'));
    const monthName = (d) => d.toLocaleDateString(loc(), { month: 'long', year: 'numeric' });
    // Monday first, in the user's language
    const wk = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(loc(), { weekday: 'narrow' }));
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; if (openMenu === m) { closeMenu(); anchor.focus?.(); } else m.remove(); resolve(v); };
    const draw = (focusDay) => {
      const first = new Date(y, mo, 1), lead = (first.getDay() + 6) % 7, days = new Date(y, mo + 1, 0).getDate();
      const cells = [];
      for (let i = 0; i < lead; i++) cells.push('<span></span>');
      for (let d = 1; d <= days; d++) {
        const v = iso(new Date(y, mo, d, 12));
        const off = min && v < min;
        cells.push(`<button type="button" class="dp-day${v === today ? ' today' : ''}${v === current ? ' sel' : ''}" data-v="${v}" ${off ? 'disabled' : ''} aria-label="${esc(new Date(y, mo, d).toLocaleDateString(loc(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))}" ${v === current ? 'aria-pressed="true"' : ''}>${d}</button>`);
      }
      const prevOff = min && iso(new Date(y, mo, 0, 12)) < min;
      m.innerHTML = `<div class="dp-head"><button type="button" class="btn ghost icon sm" data-nav="-1" ${prevOff ? 'disabled' : ''} aria-label="${t('Previous month')}">${icon('chevleft', 'sm')}</button><div class="dp-title" aria-live="polite">${esc(monthName(first))}</div><button type="button" class="btn ghost icon sm" data-nav="1" aria-label="${t('Next month')}">${icon('chevright', 'sm')}</button></div>
        <div class="dp-grid dp-wk" aria-hidden="true">${wk.map((w) => `<span>${esc(w)}</span>`).join('')}</div>
        <div class="dp-grid">${cells.join('')}</div>
        <div class="dp-foot"><button type="button" class="btn ghost xs" data-v="${today}" ${min && today < min ? 'disabled' : ''}>${t('Today')}</button>${clearable && current ? `<button type="button" class="btn ghost xs" data-v="">${t('Clear')}</button>` : ''}</div>`;
      if (focusDay) (m.querySelector('.dp-day.sel:not(:disabled)') || m.querySelector('.dp-day.today:not(:disabled)') || m.querySelector('.dp-day:not(:disabled)'))?.focus();
    };
    draw();
    const host = layerOf(anchor);
    host.append(m);
    const r = anchor.getBoundingClientRect();
    const place = () => {
      const mw = m.offsetWidth, mh = m.offsetHeight;
      const left = Math.max(8, Math.min(r.left, innerWidth - mw - 8));
      let top = r.bottom + 6;
      if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 6);
      m.style.left = `${left}px`; m.style.top = `${top}px`;
    };
    place();
    m.addEventListener('click', (e) => {
      const nav = e.target.closest('[data-nav]');
      if (nav) { mo += Number(nav.dataset.nav); if (mo < 0) { mo = 11; y--; } else if (mo > 11) { mo = 0; y++; } draw(); place(); m.querySelector(`[data-nav="${nav.dataset.nav}"]:not(:disabled)`)?.focus(); return; }
      const b = e.target.closest('[data-v]');
      if (b && !b.disabled) finish(b.dataset.v);
    });
    m.addEventListener('keydown', (e) => {
      const day = document.activeElement?.closest?.('.dp-day');
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
      if (day && step) {
        e.preventDefault();
        const d = new Date(`${day.dataset.v}T12:00:00`); d.setDate(d.getDate() + step);
        if (min && iso(d) < min) return;
        y = d.getFullYear(); mo = d.getMonth(); draw(); place();
        m.querySelector(`[data-v="${iso(d)}"]`)?.focus();
      } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(undefined); }
      else if (e.key === 'Tab' && !m.contains(document.activeElement)) finish(undefined);
    });
    openMenu = m; openAnchor = anchor; anchor.setAttribute('aria-expanded', 'true');
    settleWhenGone(m, host, finish);
    setTimeout(() => draw(true), 0);
  });
}

// Every date field opens that calendar instead of the system one, same value and same change event
async function openDate(inp, anchor = inp) {
  if (inp.dataset.open) return;
  inp.dataset.open = '1';
  const v = await pickDate(anchor, { current: inp.value, min: inp.min, clearable: !inp.required });
  delete inp.dataset.open;
  if (v === undefined || v === inp.value) return;
  inp.value = v;
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
}
const ownDate = (el) => el?.tagName === 'INPUT' && el.type === 'date' && !el.disabled && !el.readOnly && !el.closest('[data-native]');
// stopPropagation: the menu's own outside-press handler below would otherwise close the calendar on the press that opened it
document.addEventListener('mousedown', (e) => { if (e.button === 0 && ownDate(e.target) && e.target.offsetParent) { e.preventDefault(); e.stopPropagation(); e.target.focus(); if (openAnchor === e.target) closeMenu(); else openDate(e.target); } }, true);
document.addEventListener('keydown', (e) => { if (ownDate(e.target) && (e.key === ' ' || e.key === 'Enter' || (e.altKey && e.key === 'ArrowDown'))) { e.preventDefault(); openDate(e.target); } }, true);
export { openDate };

// Every <select> opens the app's own list instead of the system one (which ignores the theme): same value, same
// change event, so the code that reads them is untouched. data-native keeps the system list where it matters.
const selectItems = (sel) => {
  const out = [];
  for (const el of sel.children) {
    if (el.tagName === 'OPTGROUP') { out.push({ header: el.label }); for (const o of el.children) out.push({ value: o.value, label: o.textContent, disabled: o.disabled }); }
    else if (el.tagName === 'OPTION' && !el.hidden) out.push({ value: el.value, label: el.textContent, disabled: el.disabled });
  }
  return out;
};
async function openSelect(sel) {
  if (sel.dataset.open) return;
  sel.dataset.open = '1';
  const v = await pickFrom(sel, selectItems(sel), { current: sel.value, search: sel.options.length > 10 });
  delete sel.dataset.open;
  if (v === undefined || v === sel.value) return;
  sel.value = v;
  sel.dispatchEvent(new Event('input', { bubbles: true }));
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}
const ownSelect = (el) => el?.tagName === 'SELECT' && !el.multiple && !el.disabled && el.size <= 1 && !el.closest('[data-native]');
document.addEventListener('mousedown', (e) => { if (e.button === 0 && ownSelect(e.target)) { e.preventDefault(); e.stopPropagation(); e.target.focus(); if (openAnchor === e.target) closeMenu(); else openSelect(e.target); } }, true);
document.addEventListener('keydown', (e) => { if (ownSelect(e.target) && (e.key === ' ' || e.key === 'Enter' || (e.altKey && e.key === 'ArrowDown'))) { e.preventDefault(); openSelect(e.target); } }, true);
// A click on a field's label opens its list, as it would a native select
document.addEventListener('click', (e) => {
  const lb = e.target.closest?.('label[for]');
  const sel = lb && document.getElementById(lb.htmlFor);
  if (!ownSelect(sel)) return;
  e.preventDefault(); sel.focus();
  if (openAnchor !== sel) openSelect(sel);
}, true);

// ---------- small components ----------
export const empty = (ic, title, text = '', action = '') => `<div class="empty">${icon(ic)}<h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}${action}</div>`;
export const tagChip = (tg) => `<a class="tagchip" href="#/meetings?tag=${tg.id}"><span class="dot" style="background:${tg.color}"></span>${esc(tg.name)}</a>`;
export const switchEl = (id, on, label = '') => `<label class="switch" title="${esc(label)}"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} aria-label="${esc(label)}"><i></i></label>`;
export const field = (id, label, input, hint) => `<div class="field"><label for="${id}">${esc(label)}</label>${input}${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
export const seg = (name, options, value) => `<div class="seg-ctl" role="tablist" data-seg="${name}">${options.map(([v, label, ic]) => `<button type="button" role="tab" data-v="${esc(v)}" aria-selected="${v === value}">${ic ? icon(ic, 'sm') : ''}${esc(label)}</button>`).join('')}</div>`;

export function meetingCard(n) {
  const people = n.people || [];
  const tags = (n.tags || []).slice(0, 2);
  return `<a class="card hover mcard" href="#/note/${n.id}">
    <div class="top"><h3 class="clamp2">${esc(n.title || t('Untitled meeting'))}</h3>${n.external ? `<span class="badge info" title="${t('Attendees from outside your organisation')}">${t('External')}</span>` : ''}${srcIcon(n.source)}</div>
    <div class="meta"><span>${icon('calendar', 'sm')}${fmtDate(n.createdAt, { weekday: 'short', day: 'numeric', month: 'short' })}</span>${n.durationMs ? `<span>${icon('clock', 'sm')}${fmtDur(n.durationMs)}</span>` : ''}${n.platform ? `<span>${icon('video', 'sm')}${esc(PLATFORMS[n.platform] || n.platform)}</span>` : ''}${n.actions?.open ? `<span>${icon('checksq', 'sm')}${n.actions.open}</span>` : ''}</div>
    <div class="excerpt clamp3">${esc(n.excerpt || '') || `<span class="faint">${n.status === 'processing' ? t('Transcribing…') : n.status === 'recording' ? t('Recording…') : t('No summary yet')}</span>`}</div>
    <div class="foot"><div class="row wrap" style="gap:6px">${tags.map((tg) => `<span class="tagchip"><span class="dot" style="background:${tg.color}"></span>${esc(tg.name)}</span>`).join('')}${!tags.length && n.topics?.[0] ? `<span class="tagchip">${icon('hash', 'sm')}${esc(n.topics[0].name)}</span>` : ''}</div>${avatarStack(people, 3)}</div>
  </a>`;
}

export function meetingRow(n, { snippet } = {}) {
  return `<a class="li" href="#/note/${n.id}">${srcIcon(n.source)}
    <div class="main-t"><div class="t">${esc(n.title || t('Untitled meeting'))}</div><div class="s">${snippet ? safeSnippet(snippet) : esc(n.excerpt || fmtDate(n.createdAt))}</div></div>
    <div class="side"><span class="row hide-sm" style="gap:4px">${(n.tags || []).slice(0, 2).map((tg) => `<span class="tagchip"><span class="dot" style="background:${tg.color}"></span>${esc(tg.name)}</span>`).join('')}</span>${n.external ? `<span class="badge info hide-sm">${t('External')}</span>` : ''}<span class="hide-sm">${avatarStack(n.people || [], 3)}</span><span>${n.durationMs ? fmtDur(n.durationMs) + ' · ' : ''}${fmtHour(n.createdAt)}</span></div></a>`;
}

// Download helper: fetch a URL (cookie-authenticated) and save the response as a file.
export async function download(url, fallbackName = 'export') {
  const r = await fetch(url, typeof url === 'string' ? undefined : url);
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new ApiError(j.error || r.statusText, r.status, j.code); }
  const blob = await r.blob();
  const cd = r.headers.get('content-disposition') || '';
  const name = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(cd)?.[1] || /filename="([^"]+)"/.exec(cd)?.[1] || fallbackName);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  return name;
}
export async function postDownload(path, body, fallbackName) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new ApiError(j.error || r.statusText, r.status, j.code); }
  const blob = await r.blob();
  const cd = r.headers.get('content-disposition') || '';
  const name = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(cd)?.[1] || fallbackName);
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  return name;
}

export const go = (h) => { if (location.hash === h) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = h; };
