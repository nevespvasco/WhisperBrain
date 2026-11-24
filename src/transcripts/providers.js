'use strict';
// A meeting's own transcript from the platform that held it: Microsoft Graph (Teams), the Google Meet REST API, Zoom cloud
// recordings. Each gives back { text, filename } in WebVTT, which attachTranscript (src/meet/attach.js) matches to the recording.
//
// UNVERIFIED: the endpoints, scopes, response shapes and error codes below were written from the vendors' documentation without
// a real account to try them on. The tests use fake responses of the shapes assumed here. What each needs from the person, who
// registers the app: Graph `OnlineMeetings.Read` + `OnlineMeetingTranscript.Read.All` (delegated; a work or school account, and the
// organiser's policy must allow it); Meet `https://www.googleapis.com/auth/meetings.space.readonly`; Zoom `cloud_recording:read` and
// a cloud recording with a transcript.
const GRAPH = 'https://graph.microsoft.com/v1.0';
const MEET = 'https://meet.googleapis.com/v2';
const ZOOM = 'https://api.zoom.us/v2';

class TranscriptError extends Error { constructor(message, code) { super(message); this.code = code; } }

// -> { platform, code | id, url } | null, from a join link
function meetingRef(url) {
  const u = String(url || '');
  let m;
  if ((m = /^https:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i.exec(u))) return { platform: 'meet', code: m[1].toLowerCase(), url: u };
  if ((m = /^https:\/\/[\w.-]*zoom\.(?:us|com)\/(?:j|w)\/(\d{9,12})/i.exec(u))) return { platform: 'zoom', id: m[1], url: u };
  if (/^https:\/\/teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join|meet)\//i.test(u)) return { platform: 'teams', url: u };
  return null;
}

// Say what went wrong in words a person can act on
async function failure(res, what) {
  const body = await res.json().catch(() => ({}));
  const code = body?.error?.code || body?.error?.status || '';
  if (code === 'GraphAccessToTranscriptsDisabled') return new TranscriptError('The meeting organiser’s Teams policy does not allow transcripts to be read through the API.', 'disabled');
  if (code === 'SpeakerAttributionNotAllowed') return new TranscriptError('Teams will not say who spoke in this transcript (a policy hides the speakers’ names), so it cannot name anyone.', 'no-names');
  if (res.status === 401) return new TranscriptError('The sign-in is no longer valid: connect again.', 'auth');
  if (res.status === 403) return new TranscriptError(`Access to ${what} was refused (${code || 'forbidden'}). The account may not be allowed, or the permission was not granted.`, 'forbidden');
  if (res.status === 404) return new TranscriptError(`There is no transcript for this meeting (${what}). Was transcription switched on?`, 'not-found');
  return new TranscriptError(`${what} failed: HTTP ${res.status}${code ? ` (${code})` : ''}`, 'failed');
}
const getJson = async (client, url, what) => { const res = await client.request(url, { headers: { Accept: 'application/json' } }); if (!res.ok) throw await failure(res, what); return res.json(); };

const clock = (ms) => { const t = Math.max(0, Math.round(ms)); return `${String(Math.floor(t / 3600000)).padStart(2, '0')}:${String(Math.floor(t / 60000) % 60).padStart(2, '0')}:${String(Math.floor(t / 1000) % 60).padStart(2, '0')}.${String(t % 1000).padStart(3, '0')}`; };
const vttEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const graph = {
  id: 'teams', label: 'Microsoft Teams', platform: 'teams',
  async fetchTranscript({ client, ref }) {
    if (!ref?.url) throw new TranscriptError('This meeting has no Teams join link.', 'no-link');
    const found = await getJson(client, `${GRAPH}/me/onlineMeetings?$filter=${encodeURIComponent(`JoinWebUrl eq '${ref.url.replace(/'/g, "''")}'`)}`, 'finding the Teams meeting');
    const meeting = found.value?.[0];
    if (!meeting) throw new TranscriptError('Teams has no online meeting for this link (is it your meeting, or one you organised?).', 'not-found');
    const list = await getJson(client, `${GRAPH}/me/onlineMeetings/${meeting.id}/transcripts`, 'listing the transcripts');
    const latest = [...(list.value || [])].sort((a, b) => String(b.createdDateTime).localeCompare(String(a.createdDateTime)))[0];
    if (!latest) throw new TranscriptError('This Teams meeting has no transcript.', 'not-found');
    const res = await client.request(`${GRAPH}/me/onlineMeetings/${meeting.id}/transcripts/${latest.id}/content?$format=text/vtt`, { headers: { Accept: 'text/vtt' } });
    if (!res.ok) throw await failure(res, 'downloading the transcript');
    return { text: await res.text(), filename: 'teams-transcript.vtt' };
  },
};

const meet = {
  id: 'meet', label: 'Google Meet', platform: 'meet',
  async fetchTranscript({ client, ref }) {
    if (!ref?.code) throw new TranscriptError('This meeting has no Google Meet link.', 'no-link');
    const recs = await getJson(client, `${MEET}/conferenceRecords?filter=${encodeURIComponent(`space.meeting_code="${ref.code}"`)}`, 'finding the Meet conference');
    const rec = [...(recs.conferenceRecords || [])].sort((a, b) => String(b.startTime).localeCompare(String(a.startTime)))[0];
    if (!rec) throw new TranscriptError('Meet has no record of this meeting.', 'not-found');
    const ts = await getJson(client, `${MEET}/${rec.name}/transcripts`, 'listing the transcripts');
    const transcript = (ts.transcripts || []).find((t) => t.state === 'ENDED') || ts.transcripts?.[0];
    if (!transcript) throw new TranscriptError('This Meet conference has no transcript.', 'not-found');
    const entries = [];
    for (let token = ''; ;) {
      const page = await getJson(client, `${MEET}/${transcript.name}/entries?pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, 'reading the transcript');
      entries.push(...(page.transcriptEntries || []));
      if (!(token = page.nextPageToken)) break;
    }
    const names = new Map();
    const nameOf = async (participant) => {
      if (!names.has(participant)) {
        const p = await getJson(client, `${MEET}/${participant}`, 'reading a participant').catch(() => ({}));
        names.set(participant, p.signedinUser?.displayName || p.anonymousUser?.displayName || p.phoneUser?.displayName || '');
      }
      return names.get(participant);
    };
    const origin = Date.parse(rec.startTime) || Date.parse(entries[0]?.startTime) || 0;
    const cues = [];
    for (const e of entries) {
      const who = await nameOf(e.participant);
      cues.push(`${clock(Date.parse(e.startTime) - origin)} --> ${clock(Date.parse(e.endTime) - origin)}\n${who ? `<v ${vttEsc(who)}>${vttEsc(e.text)}</v>` : vttEsc(e.text)}`);
    }
    return { text: `WEBVTT\n\n${cues.join('\n\n')}\n`, filename: 'meet-transcript.vtt' };
  },
};

const zoom = {
  id: 'zoom', label: 'Zoom', platform: 'zoom',
  async fetchTranscript({ client, ref }) {
    if (!ref?.id) throw new TranscriptError('This meeting has no Zoom meeting number.', 'no-link');
    const rec = await getJson(client, `${ZOOM}/meetings/${ref.id}/recordings`, 'finding the cloud recording');
    const file = (rec.recording_files || []).find((f) => f.file_type === 'TRANSCRIPT' || f.recording_type === 'audio_transcript');
    if (!file?.download_url) throw new TranscriptError('This Zoom meeting has no cloud transcript (it needs a cloud recording with audio transcript switched on).', 'not-found');
    const res = await client.request(file.download_url, { headers: { Accept: 'text/vtt' } });
    if (!res.ok) throw await failure(res, 'downloading the transcript');
    return { text: await res.text(), filename: 'zoom-transcript.vtt' };
  },
};

const PROVIDERS = { teams: graph, meet, zoom };

module.exports = { graph, meet, zoom, PROVIDERS, meetingRef, TranscriptError };
