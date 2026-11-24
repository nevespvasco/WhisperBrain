const $ = (id) => document.getElementById(id);
function show(st) {
  const el = $('status');
  el.textContent = st.detail;
  el.className = st.connected ? 'ok' : 'bad';
}
function refresh() { chrome.runtime.sendMessage({ type: 'status' }, (st) => { if (st) show(st); }); }
chrome.storage.local.get(['pairing', 'selectors'], (v) => { $('code').value = v.pairing || ''; $('sel').value = v.selectors || ''; refresh(); });
$('save').onclick = () => chrome.storage.local.set({ pairing: $('code').value.trim() }, () => chrome.runtime.sendMessage({ type: 'paired' }, (st) => { if (st) show(st); }));
$('saveSel').onclick = () => {
  try { JSON.parse($('sel').value || '{}'); } catch (e) { $('status').textContent = 'the selectors are not valid JSON: ' + e.message; $('status').className = 'bad'; return; }
  chrome.storage.local.set({ selectors: $('sel').value }, refresh);
};
$('clearSel').onclick = () => { $('sel').value = ''; chrome.storage.local.remove('selectors', refresh); };
