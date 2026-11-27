// The "this tab's audio" button of the popup: shown for a tab of a platform the extension serves.
(function () {
  const $ = (id) => document.getElementById(id);
  const hostOk = (url) => { try { const h = new URL(url).hostname; return Object.values(self.WB_PLATFORMS).some((p) => p.hosts.some((x) => h === x || h.endsWith('.' + x))); } catch (e) { return false; } };
  function draw(st) {
    $('tabstate').textContent = st.on ? 'Sending this tab\'s audio to WhisperBrain.' : (st.detail || 'Not capturing.');
    $('tabgo').hidden = !!st.on; $('tabstop').hidden = !st.on;
  }
  chrome.runtime.sendMessage({ type: 'tab-audio-status' }, (st) => st && draw(st));
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const t = tabs && tabs[0];
    $('tabgo').disabled = !t || !hostOk(t.url || '');
    if ($('tabgo').disabled && !$('tabstop').hidden === false) $('tabstate').textContent = 'Open this popup on the tab of a call (Meet, Teams, Zoom or Discord).';
    $('tabgo').onclick = () => chrome.runtime.sendMessage({ type: 'tab-audio-start', tabId: t.id }, (st) => st && draw(st));
  });
  $('tabstop').onclick = () => chrome.runtime.sendMessage({ type: 'tab-audio-stop' }, (st) => st && draw(st));
})();
