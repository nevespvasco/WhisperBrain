// How each meeting platform looks to the extension (Google Meet, Teams, Zoom's web client, Discord; src/meet/platforms.js lists the same pages). Meet changes its page now and then: when names stop arriving, this is the
// file to fix (or paste a fixed copy into the extension's options page, which wins over this one).
//
// NOT VERIFIED against a real call yet. Each entry is a list of CSS selectors tried in order; the first that finds
// something is used. `attr` reads an attribute instead of the text.
const MEET_SELECTORS = {
  verified: false,
  // one box per participant on the screen
  tile: ['[data-participant-id]', '[data-requested-participant-id]'],
  // where the name is, inside a tile
  name: [{ sel: '[data-self-name]', attr: 'data-self-name' }, { sel: '[data-participant-name]', attr: 'data-participant-name' }, { sel: 'span.notranslate' }],
  // inside a tile: present while that person is speaking
  speaking: ['[data-is-speaking="true"]', '[aria-label*="speaking" i]', '[aria-label*="a falar" i]'],
  // inside a tile: this tile is you
  self: ['[data-is-self="true"]'],
  // the open "People" panel: one row per person, the name is the row's label
  people: { list: '[role="list"][aria-label*="articipant" i], [role="list"][aria-label*="people" i], [role="list"][aria-label*="pessoas" i]', row: '[role="listitem"]', nameAttr: 'aria-label' },
  // live captions (the person turns them on in Meet): one block per speaker, with the name and the words
  captions: { container: '[aria-label*="aptions" i], [aria-label*="egendas" i], [jsname="dsyhDe"]', block: ':scope > div', name: '[data-speaker-name], img + div', text: 'div:last-child' },
  // a page that is a call (not the lobby or the home page)
  inCall: ['[data-participant-id]', '[aria-label*="Leave call" i]', '[aria-label*="Sair da chamada" i]', '[aria-label*="Leave meeting" i]'],
  // the meeting code, from the address
  code: '([a-z]{3}-[a-z]{4}-[a-z]{3})',
};

// ---- Microsoft Teams in the browser (teams.microsoft.com: work or school; teams.live.com: personal) ----
// NOT VERIFIED against a real call. The roster comes from the People panel (open it for the whole list; without it only the tiles on
// the screen are known, and the roster says so). Captions carry the speaker's name with each line. A selector that finds nothing gives
// "no names", never an error; corrected ones can be pasted in the extension's options without a rebuild.
const TEAMS_SELECTORS = {
  verified: false,
  code: '/meet/([0-9]{9,15})',
  panelRequired: true,
  tile: ['[data-tid="video-tile"]', '[data-tid="participant-tile"]', '[data-tid="calling-participant-tile"]'],
  name: [{ sel: '[data-tid="display-name"]' }, { sel: '[data-tid="participant-name"]' }, { sel: '[aria-label]', attr: 'aria-label' }],
  speaking: ['[data-tid="speaking-indicator"]', '[data-is-speaking="true"]', '[aria-label*="is speaking" i]'],
  self: ['[data-tid="self-view"]', '[data-is-self="true"]'],
  people: { list: '[data-tid="roster-list"], [role="tree"][aria-label*="articipant" i], [role="list"][aria-label*="articipant" i], [role="list"][aria-label*="people" i]', row: '[role="treeitem"], [role="listitem"]', nameAttr: 'aria-label' },
  captions: { container: '[data-tid="closed-caption-renderer-wrapper"], [data-tid="closed-captions-renderer"]', block: '[data-tid="closed-caption-message"]', name: '[data-tid="author"]', text: '[data-tid="closed-caption-text"]' },
  inCall: ['[data-tid="hangup-button"]', '#hangup-button', '[data-tid="calling-leave-button"]'],
};

// ---- Zoom's web client ("join from your browser", app.zoom.us/wc/...) ----
// NOT VERIFIED against a real call. Gallery and speaker view are both read from the tiles; the active speaker is the frame Zoom
// outlines. The participants panel gives the whole roster; with it closed the roster is only the tiles on the screen, and says so.
const ZOOM_SELECTORS = {
  verified: false,
  code: '/wc/(?:join/)?([0-9]{9,11})',
  panelRequired: true,
  tile: '.gallery-video-container__video-frame, .speaker-active-container__video-frame, .speaker-bar-container__video-frame',   // gallery and speaker view, one list
  name: [{ sel: '.video-avatar__avatar-name' }, { sel: '.gallery-video-container__name' }, { sel: '[class*="avatar-name" i]' }],
  speaking: ['[class*="active-speaker" i]', '.video-avatar__avatar--speaking'],   // not the big frame of speaker view: it keeps showing the last speaker in silence
  self: ['[class*="self-view" i]', '[data-is-self="true"]'],
  people: { list: '.participants-ul, [aria-label*="articipants list" i]', row: '.participants-item__item-layout, [role="listitem"]', nameSel: '.participants-item__display-name' },
  captions: { container: '#live-transcription-subtitle, .live-transcription-subtitle__box', block: ':scope > div', name: '.live-transcription-subtitle__author', text: '.live-transcription-subtitle__text' },
  inCall: ['[aria-label*="Leave" i][role="button"]', '.footer__leave-btn', '#wc-footer'],
};

// ---- Discord in the browser (discord.com/channels/...): the CALL VIEW only ----
// NOT VERIFIED against a real call. Nothing outside `root` is read: the sidebar lists people of other channels too. Names come from
// the tiles' text and labels (never from hover tooltips). Each person's Discord user id comes from their avatar's address
// (cdn.discordapp.com/avatars/<id>/...), the same id the local RPC and the bot give: it links the person to one account everywhere.
// While the Discord app is connected over RPC this page is not heard (see src/meet/hub.js).
const DISCORD_SELECTORS = {
  verified: false,
  code: '/channels/(?:[0-9@me]+)/([0-9]{5,25})',
  root: ['[class*="callContainer" i]', '[class*="voiceCallWrapper" i]'],
  tile: ['[class*="participantContainer" i]', '[class*="voiceUser" i]'],
  name: [{ sel: '[class*="participantName" i]' }, { sel: '[class*="username" i]' }, { sel: '[aria-label]', attr: 'aria-label' }],
  id: [{ sel: 'img[src*="/avatars/"]', attr: 'src', re: '/avatars/([0-9]{5,25})/' }],
  speaking: ['[class*="speaking" i]:not([class*="notspeaking" i])'],
  self: ['[class*="isSelf" i]', '[data-is-self="true"]'],
  inCall: ['[aria-label*="Disconnect" i]', '[aria-label*="Leave call" i]'],
};

// One entry per platform the extension serves: the pages it runs on (the same match patterns as the manifest and as the
// registry in src/meet/platforms.js), the hosts, and the selectors for them. The content script picks the entry of the page it is on.
self.WB_PLATFORMS = {
  meet: { matches: ['https://meet.google.com/*'], hosts: ['meet.google.com'], selectors: MEET_SELECTORS },
  teams: { matches: ['https://teams.microsoft.com/*', 'https://teams.live.com/*'], hosts: ['teams.microsoft.com', 'teams.live.com'], selectors: TEAMS_SELECTORS },
  zoom: { matches: ['https://*.zoom.us/wc/*'], hosts: ['zoom.us'], selectors: ZOOM_SELECTORS },
  discord: { matches: ['https://discord.com/channels/*'], hosts: ['discord.com'], selectors: DISCORD_SELECTORS },
};
self.WB_MEET_SELECTORS = MEET_SELECTORS;   // the name this file had before platforms
