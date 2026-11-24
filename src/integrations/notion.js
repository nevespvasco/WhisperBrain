'use strict';
// Notion REST client (internal-integration token) plus Markdown ⇄ Notion block conversion.

const MAX_TEXT = 2000; // chars per rich_text item
const MAX_RICH = 100; // rich_text items per block
const MAX_CHILDREN = 100; // children per request
const MAX_DEPTH = 1; // nesting levels we send in one request (deeper list items are flattened)

class NotionError extends Error {
  constructor(message, { status, code } = {}) { super(message); this.status = status; this.code = code; }
}

// Notion only accepts these code languages; anything else becomes 'plain text'.
const LANGS = new Set(['abap', 'arduino', 'bash', 'basic', 'c', 'clojure', 'coffeescript', 'c++', 'c#', 'css', 'dart', 'diff', 'docker', 'elixir', 'elm', 'erlang', 'flow', 'fortran', 'f#', 'gherkin', 'glsl', 'go', 'graphql', 'groovy', 'haskell', 'html', 'java', 'javascript', 'json', 'julia', 'kotlin', 'latex', 'less', 'lisp', 'livescript', 'lua', 'makefile', 'markdown', 'markup', 'matlab', 'mermaid', 'nix', 'objective-c', 'ocaml', 'pascal', 'perl', 'php', 'plain text', 'powershell', 'prolog', 'protobuf', 'python', 'r', 'reason', 'ruby', 'rust', 'sass', 'scala', 'scheme', 'scss', 'shell', 'sql', 'swift', 'typescript', 'vb.net', 'verilog', 'vhdl', 'visual basic', 'webassembly', 'xml', 'yaml', 'java/c/c++/c#']);
const LANG_ALIAS = { js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', rs: 'rust', sh: 'shell', zsh: 'shell', console: 'shell', yml: 'yaml', md: 'markdown', cpp: 'c++', cs: 'c#', csharp: 'c#', kt: 'kotlin', dockerfile: 'docker', ps1: 'powershell', golang: 'go', text: 'plain text', txt: 'plain text', '': 'plain text' };
const notionLang = (l) => { const k = String(l || '').toLowerCase(); const v = LANG_ALIAS[k] ?? k; return LANGS.has(v) ? v : 'plain text'; };

// ---------- Markdown → blocks ----------

const INLINE = [
  { re: /\\([\\`*_{}[\]()#+\-.!~|>])/y, fn: (m, ctx) => [{ text: m[1], ...ctx }] },
  { re: /`([^`]+)`/y, fn: (m, ctx) => [{ text: m[1], ...ctx, ann: { ...ctx.ann, code: true } }] },
  { re: /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/y, fn: (m, ctx) => inline(m[1], { ...ctx, link: m[2] }) },
  { re: /\*\*(?!\s)(.+?)(?<!\s)\*\*/y, fn: (m, ctx) => inline(m[1], { ...ctx, ann: { ...ctx.ann, bold: true } }) },
  { re: /__(?!\s)(.+?)(?<!\s)__(?![\p{L}\p{N}])/uy, word: true, fn: (m, ctx) => inline(m[1], { ...ctx, ann: { ...ctx.ann, bold: true } }) },
  { re: /~~(?!\s)(.+?)(?<!\s)~~/y, fn: (m, ctx) => inline(m[1], { ...ctx, ann: { ...ctx.ann, strikethrough: true } }) },
  { re: /\*(?![\s*])(.+?)(?<![\s*])\*/y, fn: (m, ctx) => inline(m[1], { ...ctx, ann: { ...ctx.ann, italic: true } }) },
  { re: /_(?![\s_])(.+?)(?<![\s_])_(?![\p{L}\p{N}])/uy, word: true, fn: (m, ctx) => inline(m[1], { ...ctx, ann: { ...ctx.ann, italic: true } }) },
  { re: /https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_~]/y, word: true, fn: (m, ctx) => [{ text: m[0], ...ctx, link: ctx.link || m[0] }] },
];

// Inline Markdown → segments [{ text, ann, link }].
function inline(text, ctx = { ann: {}, link: null }) {
  const out = [];
  let plain = '';
  const flush = () => { if (plain) out.push({ text: plain, ...ctx }); plain = ''; };
  for (let i = 0; i < text.length;) {
    let hit = null;
    for (const r of INLINE) {
      if (r.word && i > 0 && /[\p{L}\p{N}]/u.test(text[i - 1])) continue; // _x_ and bare URLs need a word boundary
      r.re.lastIndex = i;
      const m = r.re.exec(text);
      if (m) { hit = { m, r }; break; }
    }
    if (!hit) { plain += text[i++]; continue; }
    flush();
    out.push(...hit.r.fn(hit.m, ctx));
    i += hit.m[0].length;
  }
  flush();
  return out;
}

const sameStyle = (a, b) => a.link === b.link && JSON.stringify(a.ann) === JSON.stringify(b.ann);
function segmentsToRich(segs) {
  const merged = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && sameStyle(last, s)) last.text += s.text; else merged.push({ ...s });
  }
  const rich = [];
  for (const s of merged) {
    const chars = Array.from(s.text);
    for (let i = 0; i < chars.length; i += MAX_TEXT) {
      const item = { type: 'text', text: { content: chars.slice(i, i + MAX_TEXT).join('') } };
      if (s.link) item.text.link = { url: s.link };
      const ann = Object.fromEntries(Object.entries(s.ann || {}).filter(([, v]) => v));
      if (Object.keys(ann).length) item.annotations = ann;
      rich.push(item);
    }
  }
  return rich;
}
const richText = (text) => segmentsToRich(inline(String(text || '')));
const plainRich = (text) => segmentsToRich([{ text: String(text || ''), ann: {}, link: null }]);

// One logical block → one or more Notion blocks (rich_text is capped at 100 items per block).
function makeBlocks(type, rich, extra = {}) {
  const out = [];
  for (let i = 0; i < Math.max(1, rich.length); i += MAX_RICH) out.push({ object: 'block', type, [type]: { rich_text: rich.slice(i, i + MAX_RICH), ...extra } });
  return out;
}

const splitRow = (line) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

function markdownToBlocks(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  const stack = []; // open list items: { indent, block, depth }
  let para = [];
  const push = (bs) => { stack.length = 0; blocks.push(...bs); };
  const flushPara = () => { if (para.length) push(makeBlocks('paragraph', richText(para.join('\n')))); para = []; };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = line.match(/^\s*(```|~~~)\s*([^\s`]*)/))) {
      flushPara();
      const fence = m[1];
      const body = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence); i++) body.push(lines[i]);
      push(makeBlocks('code', plainRich(body.join('\n')), { language: notionLang(m[2]) }));
      continue;
    }
    if (!line.trim()) { flushPara(); stack.length = 0; continue; }
    if ((m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) { flushPara(); push(makeBlocks(`heading_${Math.min(3, m[1].length)}`, richText(m[2]))); continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); push([{ object: 'block', type: 'divider', divider: {} }]); continue; }
    if ((m = line.match(/^\s*!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)\s*$/))) {
      flushPara();
      push([{ object: 'block', type: 'image', image: { type: 'external', external: { url: m[2] }, ...(m[1] ? { caption: plainRich(m[1]) } : {}) } }]);
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushPara();
      const q = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) q.push(lines[i].replace(/^\s*>\s?/, ''));
      i--;
      push(makeBlocks('quote', richText(q.join('\n'))));
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara();
      const rows = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) rows.push(splitRow(lines[i]));
      i--;
      const width = Math.max(...rows.map((r) => r.length));
      if (rows.length <= MAX_CHILDREN) {
        const children = rows.map((r) => ({ object: 'block', type: 'table_row', table_row: { cells: Array.from({ length: width }, (_, k) => richText(r[k] || '')) } }));
        push([{ object: 'block', type: 'table', table: { table_width: width, has_column_header: true, has_row_header: false, children } }]);
      } else push(rows.flatMap((r) => makeBlocks('paragraph', richText(r.join(' | ')))));
      continue;
    }
    const li = line.match(/^(\s*)[-*+]\s+\[( |x|X)\]\s+(.*)$/) || line.match(/^(\s*)([-*+])\s+(.*)$/) || line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (li) {
      flushPara();
      const indent = li[1].replace(/\t/g, '    ').length;
      const kind = /^[ xX]$/.test(li[2]) ? 'to_do' : /^\d/.test(li[2]) ? 'numbered_list_item' : 'bulleted_list_item';
      const [block] = makeBlocks(kind, richText(li[3]), kind === 'to_do' ? { checked: li[2].toLowerCase() === 'x' } : {});
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      let parent = stack[stack.length - 1];
      while (parent && parent.depth >= MAX_DEPTH) parent = stack[stack.indexOf(parent) - 1]; // flatten beyond the nesting limit
      if (parent) (parent.block[parent.block.type].children ||= []).push(block);
      else blocks.push(block);
      stack.push({ indent, block, depth: parent ? parent.depth + 1 : 0 });
      continue;
    }
    if (stack.length && /^\s{2,}\S/.test(line)) { // continuation line of a list item
      const top = stack[stack.length - 1].block;
      const rt = top[top.type].rich_text;
      rt.push(...richText('\n' + line.trim()));
      continue;
    }
    stack.length = 0;
    para.push(line);
  }
  flushPara();
  return blocks;
}

// ---------- blocks → Markdown ----------

function wrap(text, mark) {
  const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : text;
}

function richTextToMarkdown(rich) {
  return (Array.isArray(rich) ? rich : []).map((r) => {
    let t = r.plain_text ?? r.text?.content ?? '';
    if (r.type === 'equation') return `$${r.equation?.expression ?? t}$`;
    const a = r.annotations || {};
    if (a.code) t = wrap(t, '`');
    if (a.bold) t = wrap(t, '**');
    if (a.italic) t = wrap(t, '_');
    if (a.strikethrough) t = wrap(t, '~~');
    const url = r.href || r.text?.link?.url;
    if (url && t.trim() && t !== url) t = `[${t}](${url})`; // bare URLs stay bare
    return t;
  }).join('');
}
const plainOf = (rich) => (Array.isArray(rich) ? rich : []).map((r) => r.plain_text ?? r.text?.content ?? '').join('');
const fileUrl = (f) => f?.file?.url || f?.external?.url || f?.url || '';
const indent = (text, pre = '  ') => text.split('\n').map((l) => (l ? pre + l : l)).join('\n');
const kidsOf = (b) => b.children || b[b.type]?.children || []; // API responses vs. blocks we built
const LIST_TYPES = new Set(['bulleted_list_item', 'numbered_list_item', 'to_do', 'toggle']);
const CONTAINERS = new Set(['column_list', 'column', 'synced_block', 'template']);

function blockToMarkdown(b, n) {
  const v = b[b.type] || {};
  const rt = richTextToMarkdown(v.rich_text);
  switch (b.type) {
    case 'paragraph': return rt;
    case 'heading_1': return `# ${rt}`;
    case 'heading_2': return `## ${rt}`;
    case 'heading_3': return `### ${rt}`;
    case 'bulleted_list_item': case 'toggle': return `- ${rt}`;
    case 'numbered_list_item': return `${n}. ${rt}`;
    case 'to_do': return `- [${v.checked ? 'x' : ' '}] ${rt}`;
    case 'quote': return indent(rt, '> ').replace(/^$/gm, '>');
    case 'callout': return indent(`${v.icon?.emoji ? `${v.icon.emoji} ` : ''}${rt}`, '> ').replace(/^$/gm, '>');
    case 'code': { const lang = v.language && v.language !== 'plain text' ? v.language : ''; return `\`\`\`${lang}\n${plainOf(v.rich_text)}\n\`\`\``; }
    case 'divider': return '---';
    case 'equation': return `$$${v.expression || ''}$$`;
    case 'child_page': return `Subpage: ${v.title || 'Untitled'}`;
    case 'child_database': return `Database: ${v.title || 'Untitled'}`;
    case 'bookmark': case 'link_preview': case 'embed': { const url = v.url || ''; const cap = plainOf(v.caption); return url ? `[${cap || url}](${url})` : ''; }
    case 'image': { const url = fileUrl(v); return url ? `![${plainOf(v.caption)}](${url})` : ''; }
    case 'file': case 'pdf': case 'video': case 'audio': { const url = fileUrl(v); return url ? `[${plainOf(v.caption) || v.name || url.split('?')[0].split('/').pop()}](${url})` : ''; }
    case 'table': {
      const kids = kidsOf(b);
      const rows = kids.filter((r) => r.type === 'table_row').map((r) => `| ${(r.table_row.cells || []).map((c) => richTextToMarkdown(c).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`);
      if (!rows.length) return '';
      const width = (kids[0].table_row.cells || []).length || 1;
      rows.splice(1, 0, `| ${Array(width).fill('---').join(' | ')} |`);
      return rows.join('\n');
    }
    default: return null; // unsupported
  }
}

function blocksToMarkdown(blocks) {
  const parts = []; // { text, list }
  let num = 0;
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b || !b.type) continue;
    num = b.type === 'numbered_list_item' ? num + 1 : 0;
    if (CONTAINERS.has(b.type)) { const inner = blocksToMarkdown(kidsOf(b)); if (inner) parts.push({ text: inner, list: false }); continue; }
    let text = blockToMarkdown(b, num);
    if (text == null) continue;
    if (b.type !== 'table' && kidsOf(b).length) {
      const inner = blocksToMarkdown(kidsOf(b));
      if (inner) text = text ? `${text}\n${indent(inner)}` : inner;
    }
    if (!text.trim() && b.type === 'paragraph') continue;
    parts.push({ text, list: LIST_TYPES.has(b.type) && b.type });
  }
  return parts.map((p, i) => (i === 0 ? '' : p.list && parts[i - 1].list === p.list ? '\n' : '\n\n') + p.text).join('');
}

// Title of a page (its title-type property) or database (top-level title).
function titleOf(obj) {
  if (!obj) return '';
  if (Array.isArray(obj.title)) return plainOf(obj.title);
  const prop = Object.values(obj.properties || {}).find((p) => p?.type === 'title');
  return plainOf(prop?.title);
}

// ---------- client ----------

class NotionClient {
  constructor({ token, fetchImpl = globalThis.fetch, baseUrl = 'https://api.notion.com/v1', version = '2022-06-28' } = {}) {
    Object.assign(this, { token, baseUrl: String(baseUrl).replace(/\/+$/, ''), version });
    this.fetch = fetchImpl;
  }

  headers() {
    return { Authorization: `Bearer ${this.token}`, 'Notion-Version': this.version, 'Content-Type': 'application/json' };
  }

  async request(method, path, body, { retries = 2 } = {}) {
    if (!this.token) throw new NotionError('No Notion token is configured. Add an integration token in Settings → Integrations.', { code: 'not-configured' });
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}${path}`, { method, headers: this.headers(), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    } catch (e) {
      throw new NotionError(`Cannot reach Notion (${e.cause?.code || e.message}).`, { code: 'unreachable' });
    }
    if (res.status === 429 && retries > 0) { // rate limited: honour Retry-After (capped)
      const wait = Math.min(5, Number(res.headers.get('retry-after')) || 1) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      return this.request(method, path, body, { retries: retries - 1 });
    }
    let json = null;
    try { json = await res.json(); } catch { /* empty or not json */ }
    if (!res.ok) throw new NotionError(json?.message || `Notion request failed (${res.status})`, { status: res.status, code: json?.code || 'http' });
    return json;
  }

  async me() {
    const u = await this.request('GET', '/users/me');
    return { ok: true, name: u?.name || u?.bot?.owner?.user?.name || '', workspace: u?.bot?.workspace_name || '' };
  }

  async search(query, { kind } = {}) {
    const body = { query: String(query || ''), page_size: 25 };
    if (kind) body.filter = { property: 'object', value: kind };
    const res = await this.request('POST', '/search', body);
    return (res?.results || []).map((r) => ({ id: r.id, kind: r.object, title: titleOf(r), url: r.url, lastEdited: r.last_edited_time }));
  }

  async createPage({ parentId, parentKind = 'page', title, markdown, icon } = {}) {
    if (!parentId) throw new NotionError('Pick a Notion page or database to export into.', { code: 'no-parent' });
    const name = plainRich(String(title || '').trim() || 'Untitled');
    let parent, properties;
    if (parentKind === 'database') {
      const db = await this.request('GET', `/databases/${parentId}`);
      const key = Object.keys(db?.properties || {}).find((k) => db.properties[k]?.type === 'title') || 'Name';
      parent = { database_id: parentId };
      properties = { [key]: { title: name } };
    } else {
      parent = { page_id: parentId };
      properties = { title: { title: name } };
    }
    const children = markdownToBlocks(markdown);
    const body = { parent, properties, children: children.slice(0, MAX_CHILDREN) };
    if (icon) body.icon = /^https?:\/\//.test(icon) ? { type: 'external', external: { url: icon } } : { type: 'emoji', emoji: icon };
    const page = await this.request('POST', '/pages', body);
    await this.appendBlocks(page.id, children.slice(MAX_CHILDREN));
    return { id: page.id, url: page.url };
  }

  async appendBlocks(blockId, blocks) {
    for (let i = 0; i < blocks.length; i += MAX_CHILDREN) await this.request('PATCH', `/blocks/${blockId}/children`, { children: blocks.slice(i, i + MAX_CHILDREN) });
    return { appended: blocks.length };
  }

  appendMarkdown(pageId, markdown) { return this.appendBlocks(pageId, markdownToBlocks(markdown)); }

  // All children of a block (follows pagination), recursing into nested blocks but not into sub-pages.
  async children(blockId, depth = 0) {
    const out = [];
    let cursor;
    do {
      const q = `?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await this.request('GET', `/blocks/${blockId}/children${q}`);
      out.push(...(res?.results || []));
      cursor = res?.has_more ? res.next_cursor : null;
    } while (cursor);
    if (depth < 8) {
      for (const b of out) if (b.has_children && b.type !== 'child_page' && b.type !== 'child_database') b.children = await this.children(b.id, depth + 1);
    }
    return out;
  }

  async pageToMarkdown(pageId) {
    const page = await this.request('GET', `/pages/${pageId}`);
    const blocks = await this.children(pageId);
    return { id: page.id, title: titleOf(page), url: page.url, createdTime: page.created_time, lastEditedTime: page.last_edited_time, markdown: blocksToMarkdown(blocks) };
  }
}

module.exports = { NotionClient, NotionError, markdownToBlocks, richTextToMarkdown, blocksToMarkdown, titleOf, notionLang, MAX_TEXT };
