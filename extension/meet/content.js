// Runs on the Google Meet page: reads it now and then and tells the background script what changed. Nothing is
// sent anywhere from here; the background script passes it to the WhisperBrain app on this computer.
(() => {
  const R = self.WbMeetReader;
  const differ = new R.Differ();
  let selectors = self.WB_MEET_SELECTORS;
  let timer = null;
  let lastTick = 0;
  let lastBeat = 0;

  const send = (signals) => { try { chrome.runtime.sendMessage({ signals }); } catch (e) { /* the extension was reloaded: this page's script is stale */ } };

  function tick() {
    timer = null;
    lastTick = Date.now();
    let st;
    try { st = R.readPage(document, selectors, location.href); } catch (e) { return; }
    const msgs = differ.diff(st);
    // while in a call, say so now and then: the app shows the extension as connected only while it hears from it
    if (st.inCall && Date.now() - lastBeat > 8000) {
      lastBeat = Date.now();
      if (!msgs.some((m) => m.type === 'meeting')) msgs.push({ type: 'meeting', inCall: true, code: st.code });
    }
    if (msgs.length) send(msgs);
  }
  // at most four readings a second, however much the page moves
  const soon = () => { if (timer) return; timer = setTimeout(tick, Math.max(0, 250 - (Date.now() - lastTick))); };

  chrome.storage.local.get('selectors', (v) => {
    if (v && v.selectors) { try { selectors = { ...selectors, ...JSON.parse(v.selectors) }; } catch (e) { /* a broken override is ignored */ } }
    new MutationObserver(soon).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    setInterval(soon, 1000);
    soon();
  });
  window.addEventListener('pagehide', () => send([{ type: 'meeting', inCall: false, code: '' }, { type: 'speaker', name: null }]));
})();
