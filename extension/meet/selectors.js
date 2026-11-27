// How each meeting platform looks to the extension (today only Google Meet; src/meet/platforms.js lists the same pages). Meet changes its page now and then: when names stop arriving, this is the
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

// One entry per platform the extension serves: the pages it runs on (the same match patterns as the manifest and as the
// registry in src/meet/platforms.js) and the selectors for them. The content script picks the entry of the page it is on.
self.WB_PLATFORMS = {
  meet: { matches: ['https://meet.google.com/*'], hosts: ['meet.google.com'], selectors: MEET_SELECTORS },
};
self.WB_MEET_SELECTORS = MEET_SELECTORS;   // the name this file had before platforms
