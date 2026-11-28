'use strict';
// HTML → readable text, in one linear pass. Mail bodies (IMAP, mbox, .eml, Gmail, Outlook) and imported .html files are
// untrusted: the old per-module regexes (`<(style|script|head)[\s\S]*?<\/\1>`, `<[^>]+>`, `[ \t]+\n`) backtrack to the end of
// the input at every candidate, so a 0.5 MB email of unclosed "<style" or of "<<<<" froze the main process for seconds.
// Here every character is looked at a bounded number of times: tags are found with indexOf, a dropped block (script, style,
// head, …) jumps straight to its closing tag, and an unclosed one drops the rest, the way a browser treats it.

const MAIL_MAX = 256 * 1024;                     // characters of HTML read from one mail body; the rest is cut before stripping
const DROP = new Set(['script', 'style', 'head', 'noscript', 'template', 'svg', 'iframe']);

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', lrm: '', rlm: '', zwj: '', zwnj: '', shy: '',
  ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•', middot: '·',
  copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', deg: '°', times: '×', szlig: 'ß', aelig: 'æ', oslash: 'ø', Oslash: 'Ø' };
for (const [acc, mark] of Object.entries({ acute: '́', grave: '̀', circ: '̂', tilde: '̃', uml: '̈', cedil: '̧', ring: '̊' })) {
  for (const l of 'aeiouyncAEIOUYNC') { const ch = (l + mark).normalize('NFC'); if (ch.length === 1) ENT[l + acc] = ch; }
}
const fromCp = (n) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');
// one pass, so "&amp;lt;" stays "&lt;" (the old chained replaces decoded it twice); unknown names are left as written
const decodeEntities = (s) => String(s).replace(/&(#x[\da-f]{1,8}|#\d{1,8}|[a-z]{1,10}\d?);/gi, (m, e) =>
  e[0] === '#' ? fromCp(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? ENT[e.toLowerCase()] ?? m);

// Cut at `max` characters; a tag cut in half at the end is dropped rather than shown as text.
function cap(html, max) {
  const s = String(html ?? '');
  if (!(max < s.length)) return s;
  const cut = s.slice(0, max), lt = cut.lastIndexOf('<');
  return lt > cut.lastIndexOf('>') ? cut.slice(0, lt) : cut;
}

const closeRes = new Map();
const closeRe = (name) => { let re = closeRes.get(name); if (!re) closeRes.set(name, re = new RegExp(`</${name}(?![\\w:-])`, 'gi')); return re; };
const NAME = /^(\/?)\s*([a-z][\w:-]*)/i, BODY = /<body(?![\w:-])/gi;

// Walk the tags of `html` in order. Text between tags goes through onText, each tag through onTag(name, closing, raw) (name in
// lower case, '' for "<!doctype>", "<?xml>" …); comments and DROP blocks become one ' '. Returns the concatenated output.
// Like the old `<[^>]+>`, a tag runs from "<" to the next ">" (attribute values are not parsed), "<>" is text, and a "<" with
// no ">" after it is text up to the end.
function walk(html, { onText = (t) => t, onTag = () => ' ', drop = DROP } = {}) {
  const s = String(html ?? ''), n = s.length, out = [];
  let i = 0;
  const text = (a, b) => { if (b > a) out.push(onText(s.slice(a, b))); };
  // first match of `re` at or after `from`, remembered: the next search from a later point that is still before the match (or
  // after a miss) gives the same answer, so "<head><head>…" never rescans the input once per tag
  const seen = new Map();
  const find = (re, from) => {
    const c = seen.get(re);
    if (c && c.from <= from && (c.at < 0 || c.at >= from)) return c.at;
    re.lastIndex = from; const at = re.exec(s)?.index ?? -1;
    seen.set(re, { from, at }); return at;
  };
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt < 0) break;
    if (s.startsWith('<!--', lt)) {                 // a comment, including Outlook's <!--[if mso]> … <![endif]-->
      text(i, lt); out.push(' ');
      const end = s.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    const gt = s.indexOf('>', lt + 1);
    if (gt < 0) break;                               // no ">" anywhere after: the rest is text, and there are no more tags
    if (gt === lt + 1) { text(i, gt + 1); i = gt + 1; continue; }   // "<>"
    text(i, lt);
    const raw = s.slice(lt, gt + 1), m = NAME.exec(raw.slice(1, 80));
    const name = m ? m[2].toLowerCase() : '', closing = !!m?.[1];
    i = gt + 1;
    if (!closing && drop.has(name) && raw[raw.length - 2] !== '/') {
      // the block ends at its first closing tag; <head> also ends where <body> starts (its "</head>" is optional)
      let end = find(closeRe(name), i);
      if (name === 'head') { const b = find(BODY, i); if (b >= 0 && (end < 0 || b < end)) end = b; else if (end < 0) end = -2; }
      out.push(' ');
      if (end === -2) continue;                      // an unclosed <head> with no <body>: keep its text rather than lose the mail
      if (end < 0) { i = n; break; }                 // unclosed script/style/…: drop the rest
      const close = s.startsWith('</', end) ? s.indexOf('>', end) : end - 1;
      i = close < 0 ? n : close + 1;
      continue;
    }
    out.push(onTag(name, closing, raw));
  }
  text(i, n);
  return out.join('');
}

// Remove [ \t] at the start and end of every line, without the `[ \t]+\n` regex (quadratic on a long run of spaces). Like
// that regex, the start of the first line and the end of the last are left alone unless `edges` is set.
function trimLines(s, { start = true, end = true, edges = false } = {}) {
  const lines = String(s).split('\n'), last = lines.length - 1;
  return lines.map((l, k) => {
    let a = 0, b = l.length;
    if (start && (k > 0 || edges)) while (a < b && (l[a] === ' ' || l[a] === '\t')) a++;
    if (end && (k < last || edges)) while (b > a && (l[b - 1] === ' ' || l[b - 1] === '\t')) b--;
    return a || b < l.length ? l.slice(a, b) : l;
  }).join('\n');
}

const MAIL_BREAK = /^(?:p|div|li|tr|h[1-6]|blockquote)$/;
// A mail body's text: breaks at <br> and at the end of paragraphs, rows and list items; every other tag is a space.
function mailHtmlToText(html, { max = MAIL_MAX } = {}) {
  const s = walk(cap(html, max), {
    onText: decodeEntities,
    onTag: (name, closing) => (name === 'br' || (closing && MAIL_BREAK.test(name)) ? '\n' : ' '),
  });
  return trimLines(s).replace(/[ \t]{2,}/g, ' ');
}

// The <title> of a page, found without a backtracking regex
function titleOf(html) {
  const s = String(html ?? ''), at = s.search(/<title(?![\w:-])/i);  // a literal prefix: one scan
  if (at < 0) return '';
  const gt = s.indexOf('>', at); if (gt < 0) return '';
  const re = closeRe('title'); re.lastIndex = gt + 1;
  const end = re.exec(s)?.index ?? -1;
  return end < 0 ? '' : s.slice(gt + 1, end);
}

// Tags out, entities decoded (for short fragments: a VTT cue, a title)
const stripTags = (s) => walk(s, { onText: decodeEntities, onTag: () => '', drop: new Set() });

module.exports = { walk, cap, trimLines, decodeEntities, mailHtmlToText, titleOf, stripTags, MAIL_MAX, DROP };
