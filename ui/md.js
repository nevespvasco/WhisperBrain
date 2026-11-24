// Small, safe Markdown renderer (headings, lists, task lists, tables, quotes, code, links, emphasis).
// All input is HTML-escaped first; only http(s)/mailto links are emitted.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(text) {
  let s = esc(text);
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  s = s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<strong>${a || b}</strong>`);
  s = s.replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>').replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

export function renderMarkdown(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const isTable = (l, n) => l.includes('|') && n && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(n);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = /^```/.exec(line))) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
    } else if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++;
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; }
    else if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
    } else if (isTable(line, lines[i + 1])) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      out.push(list());
    } else {
      const buf = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]) && !isTable(lines[i], lines[i + 1])) buf.push(lines[i++]);
      if (!buf.length) { buf.push(lines[i++]); }
      out.push(`<p>${inline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`);
    }
  }
  return out.join('\n');

  function list() {
    const indentOf = (l) => /^(\s*)/.exec(l)[1].length;
    const base = indentOf(lines[i]);
    const ordered = /^\s*\d+[.)]\s+/.test(lines[i]);
    const items = [];
    while (i < lines.length && lines[i].trim()) {
      const l = lines[i];
      const mm = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l);
      const ind = indentOf(l);
      if (mm && ind <= base + 1) { if (ind < base) break; items.push({ text: mm[3], sub: [] }); i++; }
      else if (ind > base && items.length) { items[items.length - 1].sub.push(l.slice(Math.min(ind, base + 2))); i++; }
      else break;
    }
    const tag = ordered ? 'ol' : 'ul';
    return `<${tag}>${items.map((it) => {
      const t = /^\[( |x|X)\]\s+(.*)$/.exec(it.text);
      const body = inline(t ? t[2] : it.text) + (it.sub.length ? renderMarkdown(it.sub.join('\n')) : '');
      return t ? `<li class="task"><input type="checkbox" disabled ${t[1] !== ' ' ? 'checked' : ''}>${body}</li>` : `<li>${body}</li>`;
    }).join('')}</${tag}>`;
  }
}

export { esc };
