// Live translation one click away, where the recording is started and while it runs (the top bar, the recording bar), instead
// of in Settings. Choosing a language turns translation on, and live translation with it, with that language first; "Don't
// translate" turns live translation off and leaves the rest of Settings → Translation as it was.
import { S, $, t, esc, icon, api, menu, modal, fail, go } from './lib.js';

const COMMON = ['en', 'pt-PT', 'es', 'fr', 'de', 'it'];   // offered until the user has chosen languages of their own

const cfg = () => S.settings?.translation;
// the language lines are translated into right now, or null
export const liveLanguage = () => { const c = cfg(); return c?.enabled && c.live && c.targets?.length ? c.targets[0] : null; };

// The button: a globe and the language code while it is on ("PT-PT"), "Translate" while it is off. `attr` is how the host finds it.
export function translateChip(attr) {
  const lang = liveLanguage();
  const label = lang ? lang.toUpperCase() : t('Translate');
  const hint = lang ? t('Translating into {language}. Click to change.', { language: lang }) : t('Translate this meeting as it is recorded');
  return `<button class="btn sm ${lang ? 'soft' : 'ghost'}" ${attr} aria-label="${esc(hint)}" title="${esc(hint)}">${icon('globe', 'sm')}<span class="lbl-sm">${esc(label)}</span></button>`;
}

async function languages() {
  S.languages ||= await api('GET', '/api/languages').catch(() => []);
  return S.languages;
}

async function choose(code) {
  const targets = cfg()?.targets || [];
  const translation = code ? { enabled: true, live: true, targets: [code, ...targets.filter((c) => c !== code)].slice(0, 8) } : { live: false };
  try { S.settings = await api('PUT', '/api/settings', { translation }); } catch (e) { fail(e); }   // the server then says 'settings': the bars redraw
}

// "Another language…": a searchable list, A to Z by English name, grouped by initial. (A <select size=10> collapses to one row
// under the global select styling, so this is a real listbox of buttons.)
async function pickOther() {
  const taken = new Set(cfg()?.targets || []);
  const all = (await languages()).filter((l) => !taken.has(l.code)).slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  const fold = (x) => String(x).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const row = (l) => `<button type="button" class="tr-opt" role="option" data-code="${esc(l.code)}" aria-selected="false"><span class="ellipsis">${esc(l.name)}</span>${l.native !== l.name ? `<span class="tr-native ellipsis">${esc(l.native)}</span>` : ''}</button>`;
  const rows = (list) => {
    let letter = '', out = '';
    for (const l of list) {
      const ch = l.name[0].toUpperCase();
      if (ch !== letter) { letter = ch; out += `<div class="tr-letter" role="presentation">${esc(ch)}</div>`; }
      out += row(l);
    }
    return out || `<div class="tr-none">${esc(t('No language matches.'))}</div>`;
  };
  modal({
    title: t('Translate into…'),
    body: `<div class="tr-search tr-pick-search">${icon('search', 'sm')}<input type="search" id="tr-lang-q" placeholder="${esc(t('Search languages…'))}" autocomplete="off" aria-label="${esc(t('Search languages…'))}"></div><div class="tr-list" id="tr-list" role="listbox" aria-label="${esc(t('Translate into…'))}">${rows(all)}</div>`,
    foot: `<button class="btn" data-close>${t('Cancel')}</button><button class="btn primary" id="tr-other-go" disabled>${t('Translate')}</button>`,
    onMount: (d, close) => {
      const list = $('#tr-list', d), q = $('#tr-lang-q', d), go = $('#tr-other-go', d);
      let picked = null;
      const opts = () => [...list.querySelectorAll('.tr-opt')];
      const select = (code, scroll = true) => {
        picked = code;
        for (const o of opts()) { const on = o.dataset.code === code; o.classList.toggle('on', on); o.setAttribute('aria-selected', on ? 'true' : 'false'); if (on && scroll) o.scrollIntoView({ block: 'nearest' }); }
        go.disabled = !code;
      };
      const submit = () => { if (picked) { choose(picked); close(); } };
      const filter = () => {
        const n = fold(q.value.trim());
        list.innerHTML = rows(n ? all.filter((l) => fold(l.name).includes(n) || fold(l.native).includes(n) || fold(l.code).includes(n)) : all);
        select(opts()[0]?.dataset.code || null, false);   // typing selects the first match, so Enter just works
      };
      const step = (by) => { const o = opts(); if (o.length) select(o[Math.max(0, Math.min(o.length - 1, o.findIndex((x) => x.dataset.code === picked) + by))].dataset.code); };
      list.addEventListener('click', (e) => { const o = e.target.closest('.tr-opt'); if (o) select(o.dataset.code); });
      list.addEventListener('dblclick', (e) => { if (e.target.closest('.tr-opt')) submit(); });
      q.addEventListener('input', filter);
      d.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
        else if (e.key === 'Enter' && !e.target.closest('button')) { e.preventDefault(); submit(); }
      });
      go.onclick = submit;
      select(opts()[0]?.dataset.code || null, false);
      q.focus();
    },
  });
}

// A meeting that is already recorded: translate its transcript now and show it (the note view reads ?tr=). Translation is
// switched on if it was off; live translation is left as it was.
async function translateNote(noteId, code) {
  const c = cfg();
  if (!c?.enabled || !c.targets?.includes(code)) {
    // translation was off: turning it on for this meeting must not also start translating the next recording live
    const live = c?.enabled ? {} : { live: false };
    try { S.settings = await api('PUT', '/api/settings', { translation: { enabled: true, ...live, targets: [...(c?.targets || []).filter((x) => x !== code), code].slice(-8) } }); } catch (e) { fail(e); return; }
  }
  const h = `#/note/${noteId}?tab=transcript&tr=${encodeURIComponent(code)}`;
  if (location.hash === h) window.dispatchEvent(new HashChangeEvent('hashchange')); else go(h);
}

// noteId: the recorded meeting on screen, if any; it gets its own "Translate this meeting" section first.
export async function translateMenu(anchor, { noteId } = {}) {
  const all = await languages();
  const name = (c) => all.find((l) => l.code === c)?.name || c;
  const lang = liveLanguage();
  const noAi = !S.settings?.llm?.baseUrl;
  const mine = cfg()?.targets?.length ? cfg().targets : COMMON;
  menu(anchor, [
    ...(noteId ? [
      { header: t('Translate this meeting') },
      ...mine.map((c) => ({ label: name(c), icon: 'globe', disabled: noAi, run: () => translateNote(noteId, c) })),
      'sep',
    ] : []),
    { header: t('Translate while recording') },
    ...(noAi ? [{ label: t('Needs an AI server: set one up'), icon: 'sparkles', run: () => go('#/settings/ai') }, 'sep'] : []),
    { label: t('Don’t translate'), icon: 'x', selected: !lang, run: () => choose(null) },
    ...mine.map((c) => ({ label: name(c), icon: 'globe', selected: c === lang, disabled: noAi, run: () => choose(c) })),
    'sep',
    { label: t('Another language…'), icon: 'more', disabled: noAi, run: pickOther },
    { label: t('Translation settings'), icon: 'settings', run: () => go('#/settings/translation') },
  ]);
}
