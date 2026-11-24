'use strict';
// Which applications count as "a meeting app" when they hold the microphone.
const MEETING_APPS = [
  { id: 'zoom', name: 'Zoom', match: /\bzoom(\.us|\.exe)?\b|zoom\s*meetings?/i },
  { id: 'teams', name: 'Microsoft Teams', match: /\bteams\b|ms-teams|msteams/i },
  { id: 'meet', name: 'Google Meet', match: /google meet|meet\.google/i },
  { id: 'slack', name: 'Slack', match: /\bslack\b/i },
  { id: 'discord', name: 'Discord', match: /\bdiscord\b/i },
  { id: 'webex', name: 'Webex', match: /\bwebex\b|cisco/i },
  { id: 'skype', name: 'Skype', match: /\bskype/i },
  { id: 'facetime', name: 'FaceTime', match: /\bfacetime\b/i },
  { id: 'whatsapp', name: 'WhatsApp', match: /\bwhatsapp\b/i },
  { id: 'telegram', name: 'Telegram', match: /\btelegram\b/i },
  { id: 'signal', name: 'Signal', match: /\bsignal(-desktop)?\b/i },
  { id: 'gotomeeting', name: 'GoTo', match: /gotomeeting|goto\b/i },
  { id: 'jitsi', name: 'Jitsi', match: /jitsi/i },
];

// Browsers can host any web meeting; they only count when a tab title looks like one.
const BROWSERS = /\b(chrome|chromium|brave|firefox|edge|msedge|vivaldi|opera|safari|arc)\b/i;
const MEETING_TITLE = /(meet\.google\.com|meet\s*[-–]|zoom|teams|webex|whereby|jitsi|huddle|call)/i;

// Apps that record or capture rather than converse (our own capture, other recorders). Never a "meeting".
const IGNORE = /(whisperbrain|pw-record|pw-cat|arecord|parec|obs|audacity|ffmpeg|pipewire|wireplumber|pulseaudio|speech-dispatcher|sd_dummy|screencast|xdg-desktop-portal|gnome-shell|krunner|dictation)/i;

function classify(app) {
  const hay = [app.name, app.binary, app.title].filter(Boolean).join(' ');
  if (IGNORE.test(hay)) return null;
  for (const m of MEETING_APPS) if (m.match.test(hay)) return { id: m.id, name: m.name };
  if (BROWSERS.test(hay)) return { id: 'browser', name: app.name || 'Browser', weak: !MEETING_TITLE.test(app.title || '') };
  return { id: 'other', name: app.name || app.binary || 'Unknown app', weak: true };
}

const NAMES = Object.fromEntries(MEETING_APPS.map((m) => [m.id, m.name]));
NAMES.whereby = 'Whereby';
const app = (id) => ({ id, name: NAMES[id] });

// Browsers append " - Google Chrome", " — Mozilla Firefox", " - Profile 1 - Microsoft Edge"... strip that tail.
const BROWSER_TAIL = /\s+[-–—]\s+(Google Chrome|Chromium|Mozilla Firefox|Firefox|Brave|Microsoft\u200b?\s?Edge|Vivaldi|Opera|Safari|Arc)\s*$/i;
const EXTRA_TAIL = /(\s+and \d+ more pages?)?(\s+[-–—]\s+[^-–—]{1,40})?$/i; // Edge: "and 2 more pages - Personal"
const TEAMS_NAV = /^(chat|activity|calendar|teams|calls|files|apps|assignments|onedrive|help|settings|search|community|planner|microsoft teams)$/i;
const TEAMS_CALL = /\b(meeting|call|webinar|town hall|live event|meet now|compact view)\b/i;

// A window title that shows the user is *in* a call (not a landing/home page) -> { id, name } | null.
function classifyWindowTitle(raw) {
  const t = String(raw || '').replace(/^\(\d+\)\s*/, '').trim();
  if (!BROWSER_TAIL.test(t)) return classifyClean(t);
  const bare = t.replace(BROWSER_TAIL, '').trim();
  return classifyClean(bare) || classifyClean(bare.replace(EXTRA_TAIL, '').trim());
}

function classifyClean(t) {
  if (!t) return null;
  // Google Meet room tab: "Meet - abc-defg-hij" / "Meet – Weekly sync" (the landing page is just "Google Meet")
  if (/^Meet\s*[-–—:]\s*\S/i.test(t) || /meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}\b/i.test(t)) return app('meet');
  // Zoom meeting/webinar window ("Zoom Workplace", "Zoom Cloud Meetings" and "Zoom" are the home window)
  if (/\bZoom (Meeting|Webinar)\b/i.test(t)) return app('zoom');
  // Teams: "<subject> | Microsoft Teams" where the first segment is not a navigation section
  const teams = /^(.*?)\s*[|–—-]\s*Microsoft Teams(?: \(work or school\)| classic)?$/i.exec(t);
  if (teams) {
    const first = teams[1].split(/\s*\|\s*/)[0];
    if (first && !TEAMS_NAV.test(first) && TEAMS_CALL.test(teams[1])) return app('teams');
  }
  if (/\bhuddle\b/i.test(t) && /\bslack\b/i.test(t)) return app('slack');
  // Jitsi room: "<room> | Jitsi Meet" (the bare "Jitsi Meet" is the landing page)
  if (/\S\s*[|–—-]\s*Jitsi Meet$/i.test(t)) return app('jitsi');
  if (/\bwhereby\b/i.test(t) && /\S\s*[|–—-]\s*whereby\b|\bwhereby\b\s*[|–—-]\s*\S/i.test(t) && !/video (meetings|conferencing|calls)|sign in|log in|pricing|dashboard/i.test(t)) return app('whereby');
  // Webex meeting window: "<x> meeting - Webex", "Ana's Personal Room | Webex", "Webex Meeting" (not "Webex"/"Webex Meetings" home)
  if (/\bwebex\b/i.test(t) && /\b(meeting|personal room|webinar)\b/i.test(t)) return app('webex');
  return null;
}

// Meeting platform behind a join link.
function platformFromUrl(url) {
  const u = String(url || '').toLowerCase();
  if (!u) return null;
  if (u.includes('meet.google.com')) return 'meet';
  if (/zoom\.us|zoomgov\.com/.test(u)) return 'zoom';
  if (/teams\.(microsoft|live)\.com/.test(u)) return 'teams';
  if (u.includes('webex.com')) return 'webex';
  if (u.includes('whereby.com')) return 'whereby';
  if (/meet\.jit\.si|jitsi/.test(u)) return 'jitsi';
  if (u.includes('slack.com/huddle')) return 'slack';
  return null;
}

module.exports = { MEETING_APPS, BROWSERS, classify, classifyWindowTitle, platformFromUrl, appName: (id) => NAMES[id] || null };
