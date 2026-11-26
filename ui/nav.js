// The "doors" navigation: four places, each with a short list of its own pages. A rail on the left shows the doors and the
// Record button; the panel next to it shows the open door's pages. Every page the router knows lives behind exactly one door,
// so nothing is hidden when the menu changes (test/navigation.test.js checks this against ui/app.js's ROUTES).
// Pure data plus lookups: no DOM, no imports, so the test can load it.

// Settings sections: [id, label, icon]. Listed under the Setup door and in the Settings page's own menu on small screens.
export const SETTINGS_SECTIONS = [['account', 'Account', 'user'], ['general', 'Appearance', 'sun'], ['meetings', 'Meetings & detection', 'video'], ['audio', 'Audio & transcription', 'mic'], ['ai', 'AI', 'sparkles'], ['translation', 'Translation', 'globe'], ['assistant', 'Assistant', 'wand'], ['templates', 'Templates', 'file'], ['dictation', 'Dictation', 'waves'], ['shortcuts', 'Shortcuts', 'bolt']];

// A link: href, label, icon, views (the route names it is "current" for), and optionally:
//   count: a key of the counts the sidebar passes in; query: params that must match (and, for a plain list, none at all);
//   section: the settings section it opens; title: a longer tooltip.
const L = (href, label, icon, views, extra = {}) => ({ href, label, icon, views, ...extra });

export const DOORS = [
  {
    id: 'today', label: 'Today', icon: 'home', href: '#/',
    hint: 'Start a meeting, see your calendar and what is left to do.',
    sections: [{ links: [
      L('#/', 'Home', 'home', ['home']),
      L('#/calendar', 'Calendar', 'calendar', ['calendar']),
      L('#/actions', 'Action items', 'list', ['actions'], { count: 'openActions' }),
    ] }],
  },
  {
    id: 'ask', label: 'Ask', icon: 'sparkles', href: '#/chat',
    hint: 'Ask questions about all your meetings. Every answer links to where it came from.',
    sections: [{ links: [L('#/chat', 'Ask AI', 'sparkles', ['chat'])], note: 'To ask about one meeting only, open it and use its Chat tab.' }],
  },
  {
    id: 'library', label: 'Library', icon: 'layers', href: '#/meetings',
    hint: 'Everything you recorded or imported, and what was learned from it.',
    sections: [
      { links: [L('#/meetings', 'All meetings', 'video', ['meetings', 'note'], { count: 'notes', query: {} })] },
      { label: 'Sources', links: [
        L('#/meetings?source=local', 'Recorded here', 'mic', ['meetings'], { count: 'recorded', query: { source: 'local' } }),
        L('#/meetings?source=imported', 'From outside', 'inbox', ['meetings'], { count: 'imported', query: { source: 'imported' } }),
        L('#/meetings?external=1', 'External meetings', 'globe', ['meetings'], { query: { external: '1' }, title: 'Meetings with people outside your organisation' }),
      ] },
      { special: 'spaces' },
      { special: 'tags' },
      { label: 'Knowledge', links: [
        L('#/people', 'People', 'users', ['people', 'person']),
        L('#/topics', 'Topics', 'network', ['topics', 'topic'], { count: 'topics' }),
        L('#/glossary', 'Glossary', 'book', ['glossary', 'term'], { count: 'glossary' }),
        L('#/briefings', 'Briefings', 'doc', ['briefings']),
      ] },
    ],
  },
  {
    id: 'setup', label: 'Setup', icon: 'settings', href: '#/integrations',
    hint: 'Connect your tools and choose how WhisperBrain works.',
    sections: [
      { links: [L('#/integrations', 'Integrations', 'plug', ['integrations']), L('#/activity', 'Activity', 'refresh', ['activity'])] },
      { label: 'Settings', links: SETTINGS_SECTIONS.map(([id, label, icon]) => L(`#/settings/${id}`, label, icon, ['settings'], { section: id })) },
    ],
  },
];

const OWNER = new Map(DOORS.flatMap((d) => d.sections.flatMap((s) => (s.links || []).flatMap((l) => l.views.map((v) => [v, d.id])))));
// Which door a page belongs to (spaces and tags open the meetings list, which is in the Library). Unknown pages: Today.
export const doorOf = (viewName) => OWNER.get(viewName) || 'today';
export const door = (id) => DOORS.find((d) => d.id === id) || DOORS[0];

// Is this link the page on screen? view: { name, parts, params } as the router sets it.
export function isCurrent(link, view) {
  if (!link.views.includes(view.name)) return false;
  if (link.section) return (view.parts?.[1] && SETTINGS_SECTIONS.some(([k]) => k === view.parts[1]) ? view.parts[1] : 'account') === link.section;
  if (link.query && view.name === 'meetings') {
    const params = view.params || new URLSearchParams();
    const want = Object.entries(link.query);
    return want.length ? want.every(([k, v]) => params.get(k) === v) : ![...params.keys()].length;
  }
  return true;
}
