// Reads a Google Meet page into "who is here, who is speaking, what the captions say" (no browser APIs: it takes a
// document, so it can be tested outside a browser), and turns what it read into messages for the app, only when
// something changed. The messages are the ones of src/meet/protocol.js.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.WbMeetReader = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const SELF_MARK = /\s*[([]\s*(?:you|tu|você|voce|vous|du|tú|yo|me|eu)\s*[)\]]\s*$/i;
  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const key = (s) => clean(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  // the elements of the first selector that finds any: [{ el, rule }]
  function each(root, sels) {
    for (const s of [].concat(sels || [])) {
      let list = [];
      try { list = [...root.querySelectorAll(typeof s === 'string' ? s : s.sel)]; } catch (e) { /* a selector this browser does not know */ }
      if (list.length) return list.map((el) => ({ el, rule: s }));
    }
    return [];
  }
  // is the element itself one of these, or does it hold one? (a tile may carry the mark, or hold the element that does)
  function has(el, sels) {
    for (const s of [].concat(sels || [])) {
      const q = typeof s === 'string' ? s : s.sel;
      try { if ((el.matches && el.matches(q)) || el.querySelector(q)) return true; } catch (e) { /* a selector this browser does not know */ }
    }
    return false;
  }
  function textOf(el, rule) {
    if (rule && rule.attr) return clean(el.getAttribute(rule.attr));
    return clean(el.textContent);
  }
  function nameIn(tile, sels) {
    for (const { el, rule } of each(tile, sels)) { const t = textOf(el, rule); if (t) return t; }
    return '';
  }
  function person(raw) {
    let name = clean(raw), self = false;
    if (SELF_MARK.test(name)) { name = name.replace(SELF_MARK, '').trim(); self = true; }
    return { name, self };
  }

  // doc: a Document. sel: the selectors (selectors.js). url: the address of the page.
  // -> { inCall, code, participants: [{ name, self, speaking }], speaking: [name], captions: [{ name, text }] }
  function readPage(doc, sel, url) {
    const m = new RegExp(sel.code || '([a-z]{3}-[a-z]{4}-[a-z]{3})', 'i').exec(url || '');
    const out = { inCall: false, code: m ? m[1].toLowerCase() : '', participants: [], speaking: [], captions: [] };
    const seen = new Set();
    for (const { el } of each(doc, sel.tile)) {
      const p = person(nameIn(el, sel.name));
      const self = p.self || has(el, sel.self);
      const speaking = has(el, sel.speaking);
      const k = key(p.name);
      if (!p.name || seen.has(k)) continue;
      seen.add(k);
      out.participants.push({ name: p.name, self, speaking });
    }
    // the people panel, when it is open, lists everybody, including those whose tile is not on the screen
    if (sel.people) {
      const found = each(doc, sel.people.list)[0];
      if (found) {
        for (const row of [...found.el.querySelectorAll(sel.people.row)]) {
          const p = person(sel.people.nameAttr ? row.getAttribute(sel.people.nameAttr) : row.textContent);
          const k = key(p.name);
          if (!p.name || seen.has(k)) continue;
          seen.add(k);
          out.participants.push({ name: p.name, self: p.self, speaking: false });
        }
      }
    }
    out.speaking = out.participants.filter((p) => p.speaking && !p.self).map((p) => p.name);
    out.inCall = out.participants.length > 0 || has(doc, sel.inCall);
    if (sel.captions) {
      const box = each(doc, sel.captions.container)[0];
      if (box) {
        let blocks = [];
        try { blocks = [...box.el.querySelectorAll(sel.captions.block)]; } catch (e) { /* unknown selector */ }
        for (const b of blocks) {
          const n = b.querySelector(sel.captions.name), t = b.querySelector(sel.captions.text);
          const name = clean(n && n.textContent), text = clean(t && t.textContent);
          if (name && text && text !== name) out.captions.push({ name: person(name).name, text });
        }
      }
    }
    return out;
  }

  // Turns successive readings into messages, only when something changed: the call, the people, who is speaking (one
  // name; two at once say nothing, so null), and each caption block as it grows or is gone.
  class Differ {
    constructor() { this.inCall = null; this.roster = ''; this.speaker = undefined; this.code = ''; this.captions = new Map(); }
    diff(st) {
      const out = [];
      if (st.inCall !== this.inCall || (st.inCall && st.code !== this.code)) { this.inCall = st.inCall; this.code = st.code; out.push({ type: 'meeting', inCall: st.inCall, code: st.code }); }
      if (!st.inCall) {
        this.roster = '';
        if (this.speaker) { this.speaker = null; out.push({ type: 'speaker', name: null }); }
        this.captions.clear();
        return out;
      }
      const rk = st.participants.map((p) => key(p.name) + (p.self ? '*' : '')).sort().join('|');
      if (rk !== this.roster && st.participants.length) { this.roster = rk; out.push({ type: 'roster', participants: st.participants.map((p) => ({ name: p.name, self: p.self })) }); }
      const who = st.speaking.length === 1 ? st.speaking[0] : null;
      if (who !== this.speaker && (this.speaker !== undefined || who)) { this.speaker = who; out.push({ type: 'speaker', name: who }); }
      const now = new Map();
      st.captions.forEach((c, i) => {
        const id = i + '|' + c.name;
        now.set(id, c.text);
        if (this.captions.get(id) !== c.text) out.push({ type: 'caption', name: c.name, text: c.text, final: false });
      });
      // a block that is gone has been said in full
      for (const [id, text] of this.captions) if (!now.has(id) && text) out.push({ type: 'caption', name: id.slice(id.indexOf('|') + 1), text, final: true });
      this.captions = now;
      return out;
    }
  }

  return { readPage, Differ, clean, key };
});
