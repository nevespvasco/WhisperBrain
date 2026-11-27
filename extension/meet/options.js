const $ = (id) => document.getElementById(id);
const NAMES = { meet: 'Google Meet', teams: 'Microsoft Teams', zoom: 'Zoom (web client)', discord: 'Discord (in the browser)' };
const keyOf = (id) => (id === 'meet' ? 'selectors' : 'selectors-' + id);   // the old key is Google Meet's
const ids = Object.keys(self.WB_PLATFORMS);
function show(st) {
  const el = $('status');
  el.textContent = st.detail;
  el.className = st.connected ? 'ok' : 'bad';
}
function refresh() { chrome.runtime.sendMessage({ type: 'status' }, (st) => { if (st) show(st); }); }

// which platforms are read
function drawPlatforms(off) {
  $('plats').innerHTML = '';
  for (const id of ids) {
    const l = document.createElement('label'); l.className = 'plat';
    const c = document.createElement('input'); c.type = 'checkbox'; c.checked = !off.includes(id); c.dataset.id = id;
    c.onchange = () => {
      const boxes = [...document.querySelectorAll('#plats input')];
      chrome.storage.local.set({ platformsOff: boxes.filter((b) => !b.checked).map((b) => b.dataset.id) });
    };
    l.append(c, document.createTextNode(NAMES[id] || id));
    $('plats').append(l);
  }
}
for (const id of ids) { const o = document.createElement('option'); o.value = id; o.textContent = NAMES[id] || id; $('platSel').append(o); }
function loadSel() { const k = keyOf($('platSel').value); chrome.storage.local.get(k, (v) => { $('sel').value = v[k] || ''; }); }
$('platSel').onchange = loadSel;

chrome.storage.local.get(['pairing', 'platformsOff'], (v) => { $('code').value = v.pairing || ''; drawPlatforms(v.platformsOff || []); loadSel(); refresh(); });
$('save').onclick = () => chrome.storage.local.set({ pairing: $('code').value.trim() }, () => chrome.runtime.sendMessage({ type: 'paired' }, (st) => { if (st) show(st); }));
$('saveSel').onclick = () => {
  try { JSON.parse($('sel').value || '{}'); } catch (e) { $('status').textContent = 'the selectors are not valid JSON: ' + e.message; $('status').className = 'bad'; return; }
  chrome.storage.local.set({ [keyOf($('platSel').value)]: $('sel').value }, refresh);
};
$('clearSel').onclick = () => { $('sel').value = ''; chrome.storage.local.remove(keyOf($('platSel').value), refresh); };
