export class ApiError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

export async function api(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) { init.body = body; init.headers['Content-Type'] = 'application/octet-stream'; }
    else { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (res.status === 423) window.dispatchEvent(new Event('wb:locked'));   // the app lock closed: the lock screen takes over
  if (!res.ok) throw new ApiError(data?.error || res.statusText, res.status, data?.code);
  return data;
}

// POST that answers with Server-Sent Events (LLM streaming). Calls handlers per event; resolves with the `done` payload.
export async function stream(path, body, { onDelta, onStage, signal } = {}) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new ApiError(d.error || res.statusText, res.status, d.code); }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let result = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.+)$/m.exec(block)?.[1];
      const dataLine = /^data: (.+)$/m.exec(block)?.[1];
      if (!ev || !dataLine) continue;
      const data = JSON.parse(dataLine);
      if (ev === 'delta') onDelta?.(data.text);
      else if (ev === 'stage') onStage?.(data);
      else if (ev === 'error') throw new ApiError(data.message, 500, data.code);
      else if (ev === 'done') result = data;
    }
  }
  return result;
}

// Live events from the server. Reconnects automatically (EventSource does) and re-announces on reconnect.
export function events(handlers) {
  const es = new EventSource('/api/events');
  const types = ['settings', 'note.created', 'note.updated', 'note.deleted', 'note.summarizing', 'note.summarize-failed', 'recording.started', 'recording.paused', 'recording.resumed', 'recording.mic-muted', 'recording.finalizing', 'recording.stopped', 'recording.level', 'recording.warning', 'recording.overlap', 'recording.speaker-test', 'capture.request', 'transcript.segment', 'transcript.partial', 'transcript.removed', 'speakers.updated', 'translation.started', 'translation.segment', 'translation.progress', 'translation.done', 'translation.failed', 'meeting.detected', 'meeting.apps-changed', 'meeting.ended', 'meeting.autostarted', 'meeting.starting', 'model.progress', 'model.installed', 'model.removed', 'model.error', 'dictation.state', 'dictation.result', 'dictation.error', 'assistant.state', 'assistant.question', 'assistant.sentence', 'assistant.flag', 'assistant.done', 'assistant.error', 'assistant.repeat', 'assistant.summary', 'assistant.term', 'briefings.changed', 'job.changed', 'job.error', 'sources.changed', 'sources.syncing', 'sources.progress', 'people.changed', 'google.connected', 'outlook.connected', 'outlook.error', 'transcript-source.connected', 'transcript-source.error', 'items.purged', 'actions.changed', 'google.error'];
  // Also every event the caller has a handler for: this list had drifted from app.js, so google.connected, import.done, reminder.due… never arrived.
  const names = new Set([...types, ...Object.keys(handlers).filter((k) => k !== '*' && k !== 'open')]);
  for (const t of names) es.addEventListener(t, (e) => { try { handlers[t]?.(JSON.parse(e.data)); handlers['*']?.(t, JSON.parse(e.data)); } catch (err) { console.error(err); } });
  es.addEventListener('open', () => handlers.open?.());
  // the app locked (idle, or from another window): the lock screen takes over at once; the server closes this stream
  es.addEventListener('lock.changed', (e) => { try { if (JSON.parse(e.data).locked) window.dispatchEvent(new Event('wb:locked')); } catch { /* not JSON */ } });
  return es;
}
