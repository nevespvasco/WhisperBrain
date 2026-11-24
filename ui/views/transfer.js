// Import (files, pasted text, Notion, Obsidian, Linear) and export/share (files, clipboard, email, print,
// Notion, Obsidian, Linear, webhooks) dialogs.
import { S, $, $$, api, t, esc, icon, modal, toast, fail, done, go, download, postDownload, debounce, fmtDate } from '../lib.js';

const bump = () => window.dispatchEvent(new Event('wb:refresh'));
const ACCEPT = 'audio/*,video/*,.wav,.mp3,.m4a,.ogg,.opus,.flac,.webm,.mp4,.mov,.mkv,.vtt,.srt,.txt,.md,.markdown,.json,.docx,.html,.htm,.csv,.tsv';

async function integrations() { S.integrations = await api('GET', '/api/integrations'); return S.integrations; }

// ---------------- import ----------------
export async function openImport({ files = [], tab = 'files', space = '' } = {}) {
  const ints = await integrations().catch(() => ({}));
  const tabs = [['files', t('Files'), 'upload'], ['paste', t('Paste text'), 'file'], ['notion', 'Notion', 'doc'], ['obsidian', 'Obsidian', 'book'], ['linear', 'Linear', 'checksq']];
  return modal({
    title: t('Import meetings'), wide: true,
    body: `<div class="seg-ctl full" role="tablist">${tabs.map(([k, l, ic]) => `<button type="button" role="tab" data-itab="${k}" aria-selected="${k === tab}">${icon(ic, 'sm')}${esc(l)}</button>`).join('')}</div>
      <div class="formgrid" style="grid-template-columns:repeat(2,minmax(0,1fr))">
        <div class="field"><label for="imp-space">${t('Space')}</label><select id="imp-space"><option value="">${t('No space')}</option>${S.spaces.map((s) => `<option value="${s.id}" ${s.id === space ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="imp-tags">${t('Tags')}</label><input id="imp-tags" placeholder="${t('e.g. customer, imported')}" list="imp-taglist"><datalist id="imp-taglist">${S.tags.map((tg) => `<option value="${esc(tg.name)}">`).join('')}</datalist></div>
      </div>
      <div id="imp-body"></div>`,
    onMount: (d, close) => {
      const body = $('#imp-body', d);
      const opts = () => ({ space: $('#imp-space', d).value, tags: $('#imp-tags', d).value });
      const show = (k) => {
        $$('[data-itab]', d).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.itab === k)));
        if (k === 'files') filesTab(body, opts, close, files);
        else if (k === 'paste') pasteTab(body, opts, close);
        else pickerTab(k, body, opts, close, ints);
      };
      d.addEventListener('click', (e) => { const b = e.target.closest('[data-itab]'); if (b) show(b.dataset.itab); });
      show(tab);
    },
  });
}

function filesTab(body, opts, close, preset = []) {
  body.innerHTML = `<label class="dropzone" id="dz">${icon('upload')}<b>${t('Drop files here or click to choose')}</b>
      <span class="small">${t('Audio & video are transcribed on this device. Transcripts and documents: VTT, SRT, TXT, Markdown, JSON, DOCX, HTML, CSV.')}</span>
      <input type="file" multiple accept="${ACCEPT}" hidden></label>
    <div class="field"><label for="imp-me">${t('Your name in these transcripts (optional)')}</label><input id="imp-me" value="${esc(S.settings.userName || '')}" placeholder="${t('So your lines are labelled “Me”')}"></div>
    <div id="imp-list" class="stack tight"></div>`;
  const dz = $('#dz', body), input = $('input[type=file]', body), list = $('#imp-list', body);
  const run = async (files) => {
    const created = [];
    for (const f of files) {
      const row = document.createElement('div');
      row.className = 'card row';
      row.innerHTML = `${icon('file')}<div class="grow"><div class="strong ellipsis">${esc(f.name)}</div><div class="xsmall muted st">${t('Uploading…')}</div></div>`;
      list.append(row);
      try {
        const o = opts();
        const q = new URLSearchParams({ filename: f.name, space: o.space, tags: o.tags, me: $('#imp-me', body).value.trim() });
        const r = await fetch(`/api/import?${q}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || r.statusText);
        created.push(...j.notes);
        $('.st', row).innerHTML = j.notes.some((n) => n.status === 'processing') ? `${icon('waves', 'sm')} ${t('Transcribing on this device — you can keep working')}` : `${icon('ok', 'sm')} ${j.notes.length > 1 ? t('{n} meetings imported', { n: j.notes.length }) : t('Imported')} · <a href="#/note/${j.notes[0].id}">${t('Open')}</a>`;
      } catch (e) { $('.st', row).innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`; }
    }
    bump();
    if (created.length === 1 && files.length === 1) { close(); go(`#/note/${created[0].id}`); }
  };
  input.onchange = () => run([...input.files]);
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); run([...e.dataTransfer.files]); });
  if (preset.length) run(preset);
}

function pasteTab(body, opts, close) {
  body.innerHTML = `<div class="field"><label for="imp-title">${t('Title')}</label><input id="imp-title" placeholder="${t('Untitled meeting')}"></div>
    <div class="field"><label for="imp-text">${t('Transcript or notes')}</label><textarea id="imp-text" style="min-height:220px" placeholder="Ana: Let's start with the roadmap…&#10;Rui: Sure, the API is almost done…"></textarea>
    <div class="hint">${t('Lines like “Name: text” or “[00:01] Name: text” become a transcript with speakers; anything else is kept as notes.')}</div></div>
    <div class="row" style="justify-content:flex-end"><button class="btn primary" id="imp-go">${icon('upload', 'sm')} ${t('Import')}</button></div>`;
  $('#imp-go', body).onclick = async () => {
    try {
      const r = await api('POST', '/api/import/text', { text: $('#imp-text', body).value, title: $('#imp-title', body).value, space: opts().space });
      const tags = opts().tags.split(',').map((s) => s.trim()).filter(Boolean);
      if (tags.length) await api('PUT', `/api/notes/${r.notes[0].id}/tags`, { tags });
      bump(); close(); go(`#/note/${r.notes[0].id}`);
    } catch (e) { fail(e); }
  };
}

function pickerTab(kind, body, opts, close, ints) {
  const cfg = ints[kind];
  if (!cfg?.configured) {
    body.innerHTML = `<div class="banner">${icon('plug')}<div class="grow">${t('{name} is not connected yet.', { name: kind[0].toUpperCase() + kind.slice(1) })}</div><a class="btn sm primary" href="#/integrations">${t('Connect')}</a></div>`;
    $('a', body).onclick = () => close();
    return;
  }
  body.innerHTML = `<div class="search-in" style="max-width:none">${icon('search')}<input id="pk-q" placeholder="${kind === 'linear' ? t('Search issues or type ENG-123') : t('Search…')}"></div>
    <div class="picklist" id="pk-list"><div class="empty"><div class="skel" style="width:60%"></div></div></div>
    <div class="row between"><span class="small muted" id="pk-count"></span><button class="btn primary" id="pk-go" disabled>${icon('download', 'sm')} ${t('Import selected')}</button></div>`;
  const list = $('#pk-list', body);
  let items = [];
  const load = async (q = '') => {
    try {
      items = kind === 'notion' ? await api('GET', `/api/integrations/notion/search?q=${encodeURIComponent(q)}&kind=page`)
        : kind === 'obsidian' ? await api('GET', `/api/integrations/obsidian/notes?q=${encodeURIComponent(q)}`)
          : q ? await api('GET', `/api/integrations/linear/search?q=${encodeURIComponent(q)}`) : [];
      list.innerHTML = items.map((it, i) => {
        const title = kind === 'obsidian' ? it.title || it.relPath : kind === 'linear' ? `${it.identifier} ${it.title}` : it.title || t('Untitled');
        const sub = kind === 'obsidian' ? `${it.relPath} · ${fmtDate(it.mtime)}` : kind === 'linear' ? it.state || '' : it.lastEdited ? fmtDate(Date.parse(it.lastEdited)) : '';
        return `<label><input type="checkbox" class="cbx" data-i="${i}"><span class="grow"><span class="strong ellipsis" style="display:block">${esc(title)}</span><span class="xsmall muted ellipsis" style="display:block">${esc(sub)}</span></span></label>`;
      }).join('') || `<div class="empty"><p>${kind === 'linear' && !q ? t('Type to search Linear issues.') : t('Nothing found.')}</p></div>`;
      update();
    } catch (e) { list.innerHTML = `<div class="banner danger">${icon('alert')}<div class="grow">${esc(e.message)}</div></div>`; }
  };
  const update = () => { const n = $$('input:checked', list).length; $('#pk-count', body).textContent = n ? t('{n} selected', { n }) : ''; $('#pk-go', body).disabled = !n; };
  list.addEventListener('change', update);
  $('#pk-q', body).addEventListener('input', debounce((e) => load(e.target.value.trim()), 300));
  $('#pk-go', body).onclick = async () => {
    const sel = $$('input:checked', list).map((x) => items[Number(x.dataset.i)]);
    const btn = $('#pk-go', body); btn.disabled = true; btn.textContent = t('Importing…');
    try {
      const o = opts();
      const r = kind === 'notion' ? await api('POST', '/api/import/notion', { ids: sel.map((s) => s.id), space: o.space || undefined })
        : kind === 'obsidian' ? await api('POST', '/api/import/obsidian', { paths: sel.map((s) => s.relPath), space: o.space || undefined })
          : await api('POST', '/api/import/linear', { ids: sel.map((s) => s.identifier || s.id), space: o.space || undefined });
      const tags = o.tags.split(',').map((s) => s.trim()).filter(Boolean);
      if (tags.length) for (const n of r.notes) await api('PUT', `/api/notes/${n.id}/tags`, { tags });
      bump(); done(t('{n} imported', { n: r.notes.length })); close();
      if (r.notes.length === 1) go(`#/note/${r.notes[0].id}`); else go('#/meetings?source=' + kind);
    } catch (e) { fail(e); btn.disabled = false; btn.textContent = t('Import selected'); }
  };
  load('');
}

// ---------------- export / share ----------------
const FORMATS = [
  ['md', 'Markdown', 'doc', '.md'], ['pdf', 'PDF', 'printer', '.pdf'], ['html', 'Web page', 'globe', '.html'], ['txt', 'Plain text', 'file', '.txt'],
  ['obsidian', 'Obsidian Markdown', 'book', '.md + YAML'], ['json', 'JSON', 'layers', '.json'], ['srt', 'Subtitles', 'waves', '.srt'], ['vtt', 'WebVTT', 'waves', '.vtt'],
];

// ids: one note id (single) or many; with none, everything.
export async function openExport(ids = null) {
  const ints = await integrations().catch(() => ({}));
  const single = Array.isArray(ids) && ids.length === 1 ? ids[0] : typeof ids === 'string' ? ids : null;
  const many = single ? null : (Array.isArray(ids) ? ids : []);
  const dests = [
    ['download', t('Download'), 'download', t('Save a file')],
    ...(single ? [['copy', t('Copy'), 'copy', t('Clipboard (rich text + Markdown)')], ['email', t('Email'), 'mail', t('Opens your mail app')], ['print', t('Print'), 'printer', t('Or save as PDF')]] : []),
    ['notion', 'Notion', 'doc', ints.notion?.configured ? (ints.notion.parentTitle ? t('Into “{p}”', { p: ints.notion.parentTitle }) : t('Pick a page in Integrations')) : t('Not connected')],
    ['obsidian', 'Obsidian', 'book', ints.obsidian?.configured ? t('Into your vault') : t('Not connected')],
    ...(single ? [['linear', 'Linear', 'checksq', ints.linear?.configured ? t('Issue or action items') : t('Not connected')]] : []),
    ...((ints.webhooks || []).map((w) => [`hook:${w.id}`, w.name, 'webhook', t('Webhook')])),
  ];
  const title = single ? t('Export & share') : many.length ? t('Export {n} meetings', { n: many.length }) : t('Export all meetings');
  return modal({
    title, wide: true,
    body: `<div class="field"><span class="lbl">${t('Where to')}</span><div class="opt-grid">${dests.map(([k, l, ic, s]) => `<button type="button" class="opt ${k === 'download' ? 'on' : ''}" data-dest="${esc(k)}" ${(['notion', 'obsidian', 'linear'].includes(k) && !ints[k]?.configured) ? 'data-off="1"' : ''}>${icon(ic)}<b>${esc(l)}</b><span>${esc(s)}</span></button>`).join('')}</div></div>
      <div class="field" id="fmt-field"><span class="lbl">${t('Format')}</span><div class="opt-grid">${FORMATS.filter(([k]) => single || k !== 'pdf').map(([k, l, ic, s]) => `<button type="button" class="opt ${k === 'md' ? 'on' : ''}" data-fmt="${k}" ${k === 'pdf' && !S.state?.pdf ? 'title="' + t('Uses the print dialog in the browser') + '"' : ''}>${icon(ic)}<b>${esc(l)}</b><span>${esc(s)}</span></button>`).join('')}</div></div>
      <div id="linear-opts" hidden class="stack"><div class="seg-ctl" role="tablist"><button type="button" role="tab" data-lmode="issue" aria-selected="true">${t('One issue with the summary')}</button><button type="button" role="tab" data-lmode="actions" aria-selected="false">${t('An issue per open action item')}</button></div></div>
      <label class="check"><input type="checkbox" id="exp-tr" checked> ${t('Include the transcript')}</label>`,
    foot: `<button class="btn" data-close>${t('Cancel')}</button><button class="btn primary" id="exp-go">${icon('share', 'sm')} ${t('Export')}</button>`,
    onMount: (d, close) => {
      let dest = 'download', fmt = 'md', lmode = 'issue';
      d.addEventListener('click', (e) => {
        const o = e.target.closest('[data-dest]');
        if (o) {
          if (o.dataset.off) { close(); go('#/integrations'); return; }
          dest = o.dataset.dest; $$('[data-dest]', d).forEach((x) => x.classList.toggle('on', x === o));
          $('#fmt-field', d).hidden = !['download'].includes(dest);
          $('#linear-opts', d).hidden = dest !== 'linear';
        }
        const f = e.target.closest('[data-fmt]');
        if (f) { fmt = f.dataset.fmt; $$('[data-fmt]', d).forEach((x) => x.classList.toggle('on', x === f)); }
        const lm = e.target.closest('[data-lmode]');
        if (lm) { lmode = lm.dataset.lmode; $$('[data-lmode]', d).forEach((x) => x.setAttribute('aria-selected', String(x === lm))); }
      });
      $('#exp-go', d).onclick = async () => {
        const tr = $('#exp-tr', d).checked;
        const btn = $('#exp-go', d); btn.disabled = true;
        try {
          if (single) await exportOne(single, { dest, fmt, tr, lmode });
          else await exportMany(many, { dest, fmt, tr });
          close();
        } catch (e) { fail(e); btn.disabled = false; }
      };
    },
  });
}

async function exportOne(id, { dest, fmt, tr, lmode }) {
  const q = `transcript=${tr ? 1 : 0}`;
  if (dest === 'download') {
    if (fmt === 'pdf' && !S.state?.pdf) return printNote(id, tr);
    const name = await download(`/api/notes/${id}/export?format=${fmt}&${q}`);
    return done(t('Saved {name}', { name }));
  }
  if (dest === 'copy') {
    const [md, html] = await Promise.all([api('GET', `/api/notes/${id}/export?format=md&inline=1&${q}`), api('GET', `/api/notes/${id}/export?format=html&inline=1&${q}`)]);
    try { await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([md.text], { type: 'text/plain' }), 'text/html': new Blob([html.text.replace(/^[\s\S]*<body>|<\/body>[\s\S]*$/g, '')], { type: 'text/html' }) })]); }
    catch { await navigator.clipboard.writeText(md.text); }
    return done(t('Copied — paste into any app'));
  }
  if (dest === 'email') {
    const r = await api('GET', `/api/notes/${id}/export?format=txt&inline=1&transcript=0`);
    const n = await api('GET', `/api/notes/${id}`);
    const emails = (n.attendees || []).map((a) => a.email).filter(Boolean).join(',');
    location.href = `mailto:${encodeURIComponent(emails)}?subject=${encodeURIComponent(n.title || t('Meeting notes'))}&body=${encodeURIComponent(r.text.slice(0, 15000))}`;
    return null;
  }
  if (dest === 'print') return printNote(id, tr);
  if (dest.startsWith('hook:')) { await api('POST', `/api/notes/${id}/send`, { target: 'webhook', webhookId: dest.slice(5), transcript: tr }); return done(t('Sent')); }
  const r = await api('POST', `/api/notes/${id}/send`, { target: dest, transcript: tr, mode: lmode });
  bump();
  if (dest === 'linear' && r.issues?.length > 1) return toast(t('{n} Linear issues created', { n: r.issues.length }), { ok: true });
  return toast(t('Exported to {dest}', { dest: dest[0].toUpperCase() + dest.slice(1) }), { ok: true, actions: r.url ? [{ label: t('Open'), run: () => window.open(r.url, '_blank') }] : [] });
}

async function printNote(id, tr) {
  const r = await api('GET', `/api/notes/${id}/export?format=html&inline=1&transcript=${tr ? 1 : 0}`);
  const blob = new Blob([r.text], { type: 'text/html' });
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
  frame.src = URL.createObjectURL(blob);
  document.body.append(frame);
  frame.onload = () => { try { frame.contentWindow.print(); } catch { window.open(frame.src, '_blank'); } setTimeout(() => { URL.revokeObjectURL(frame.src); frame.remove(); }, 60000); };
}

async function exportMany(ids, { dest, fmt, tr }) {
  if (dest === 'download') { const name = await postDownload('/api/export', { ids, format: fmt, transcript: tr }, 'whisperbrain.zip'); return done(t('Saved {name}', { name })); }
  const all = ids.length ? ids : (await api('GET', '/api/meetings?limit=5000')).map((n) => n.id);
  const body = dest.startsWith('hook:') ? { target: 'webhook', webhookId: dest.slice(5) } : { target: dest };
  const r = await api('POST', '/api/send', { ids: all, ...body, transcript: tr });
  const ok = r.results.filter((x) => x.ok).length;
  bump();
  toast(t('{ok} of {n} exported', { ok, n: r.results.length }), { ok: ok === r.results.length, error: ok < r.results.length });
}
