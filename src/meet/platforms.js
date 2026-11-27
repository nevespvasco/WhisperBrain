'use strict';
// Meeting platforms as data. A platform (Google Meet, later Teams, Zoom, Discord...) is one entry here; everything after the
// sources (signal hub, per-recording collector, name vote) knows nothing about any platform: sources speak the common protocol
// (protocol.js) and say which platform a message is about. Adding a platform means adding an entry and its selectors.
//
// An entry says:
//   id, name, short           'meet', 'Google Meet', 'Meet' (short: how a redacted title names it)
//   recognise.urls            page addresses (regex sources) of the platform's web client
//   recognise.windowTitle     the title of a window showing a call of it (regex source; the precise one)
//   recognise.watchTitle      the broad title filter given to the native helpers (defaults to windowTitle)
//   recognise.code            the meeting code in a title or address (one capture group)
//   apps.{linux,darwin,win32} the applications the native helpers read for it (regex source of the app names): browsers
//                             for a web client, the desktop app itself for Teams or Zoom
//   selectors                 the accessibility selectors file shipped in src/meet/selectors/ (null: no reader yet)
//   userFile                  the name, in the data folder, of the person's own selectors file that wins over the shipped one
//   extension.matches         the pages the browser extension runs on (match patterns, as in its manifest)
//   lagMs                     how long after a voice starts a source of that kind shows it, on this platform
//   accounts                  true: the ids its people carry are stable platform account ids (identities of a person, see src/graph/entities.js)
//   rpc                       true: the platform's own app is asked over a local connection instead (Discord)
//   verified                  (in the selectors file) whether the selectors were checked against a real call

const DEFAULT_PLATFORM = 'meet';
const MAX_ID = 24;

// "FakeCall " -> 'fakecall'; nothing usable -> the default platform
const platformId = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, MAX_ID) || DEFAULT_PLATFORM;

const MEET = {
  id: 'meet',
  name: 'Google Meet',
  short: 'Meet',
  recognise: {
    urls: ['^https://meet\\.google\\.com/'],
    windowTitle: '(?:^|\\s)Meet\\b|[a-z]{3}-[a-z]{4}-[a-z]{3}',
    watchTitle: 'meet|[a-z]{3}-[a-z]{4}-[a-z]{3}',
    code: '([a-z]{3}-[a-z]{4}-[a-z]{3})',
  },
  apps: {
    linux: 'chrom|brave|edge|vivaldi|opera|firefox',
    darwin: 'chrome|brave|edge|vivaldi|opera|chromium|thebrowser',   // Arc is com.thebrowser.Browser
    win32: 'chrome|msedge|brave|vivaldi|opera|chromium',
  },
  selectors: 'meet.json',
  userFile: 'meet-selectors.json',
  extension: { matches: ['https://meet.google.com/*'] },
  lagMs: { extension: 300, a11y: 500, vision: 1500, captions: 0 },
};

// Discord has no page or window to read: the Discord app is asked over its local RPC (src/discord/rpc.js), which says exactly which
// call the person is in, who is in it and who speaks. `rpc: true` marks a platform served that way.
const DISCORD = {
  id: 'discord',
  name: 'Discord',
  short: 'Discord',
  recognise: { urls: ['^https://(?:[\\w-]+\\.)?discord\\.com/channels/'] },
  apps: {},
  selectors: null,
  extension: { matches: ['https://discord.com/channels/*'] },   // the call view of the web client; steps aside while RPC is connected
  rpc: true,
  accounts: true,        // the ids it gives people are their account ids on Discord, the same ones the bot and the web page show (discord:<id>)
  lagMs: { rpc: 150, extension: 300 },   // rpc: NOT measured yet (needs a real call, see docs/discord-rpc.md); replace with the measurement
};

// The meeting platforms of the browser extension (extension/meet): the page's DOM is read there (selectors live in the extension, see
// extension/meet/selectors.js, and are checked against these pages by test/meet-platforms.test.js). NOT checked against a real call yet.
const TEAMS = {
  id: 'teams',
  name: 'Microsoft Teams',
  short: 'Teams',
  recognise: { urls: ['^https://teams\\.(?:microsoft|live)\\.com/'] },   // work or school, and personal
  apps: {},
  selectors: null,
  extension: { matches: ['https://teams.microsoft.com/*', 'https://teams.live.com/*'] },
  lagMs: { extension: 300, a11y: 500, vision: 1500, captions: 0 },   // the extension's is a guess: it has not been measured on a real call
};

const ZOOM = {
  id: 'zoom',
  name: 'Zoom',
  short: 'Zoom',
  recognise: { urls: ['^https://(?:[\\w-]+\\.)?zoom\\.us/wc/'], code: '/wc/(?:join/)?([0-9]{9,11})' },   // the web client ("join from your browser")
  apps: {},
  selectors: null,
  extension: { matches: ['https://*.zoom.us/wc/*'] },
  lagMs: { extension: 300, a11y: 500, vision: 1500, captions: 0 },
};

const unique = (xs) => [...new Set(xs)];

class PlatformRegistry {
  constructor(entries = []) {
    this.byId = new Map();
    for (const e of entries) {
      if (!e || !/^[a-z0-9-]{1,24}$/.test(e.id || '')) throw new Error(`platform: bad id "${e?.id}"`);
      if (this.byId.has(e.id)) throw new Error(`platform: "${e.id}" is registered twice`);
      this.byId.set(e.id, {
        userFile: `${e.id}-selectors.json`, apps: {}, lagMs: {}, extension: null, selectors: null, ...e,
        recognise: { urls: [], windowTitle: null, watchTitle: null, code: null, ...(e.recognise || {}) },
      });
    }
  }

  list() { return [...this.byId.values()]; }
  has(id) { return this.byId.has(id); }
  get(id) { return this.byId.get(id) || null; }
  // The platform's name for people; an id nobody registered is shown as it is.
  name(id) { return this.get(id)?.name || String(id || ''); }

  fromUrl(url) {
    const u = String(url || '');
    return this.list().find((p) => p.recognise.urls.some((re) => new RegExp(re, 'i').test(u))) || null;
  }

  fromWindow(title) {
    const t = String(title || '');
    return this.list().find((p) => p.recognise.windowTitle && new RegExp(p.recognise.windowTitle, 'iu').test(t)) || null;
  }

  // The meeting code the platform puts in a title or address, '' when there is none.
  codeIn(id, text) {
    const re = this.get(id)?.recognise.code;
    return (re && new RegExp(re, 'iu').exec(String(text || ''))?.[1]?.toLowerCase()) || '';
  }

  // What the native helpers of `os` ('linux' | 'darwin' | 'win32') are told to watch: { apps, title }, both regex sources,
  // the union over the platforms (the reader then tells the windows apart by title, see classify above).
  // only: a list of platform ids to restrict it to (the tree dump watches one platform).
  watch(os, only = null) {
    const list = only ? this.list().filter((p) => only.includes(p.id)) : this.list();
    const apps = unique(list.flatMap((p) => String(p.apps[os] || '').split('|').filter(Boolean)));
    const titles = unique(list.map((p) => p.recognise.watchTitle || p.recognise.windowTitle).filter(Boolean));
    return { apps: apps.join('|'), title: titles.join('|') };
  }

  // Platforms that have an accessibility reader on this system: those that name apps for it and ship selectors.
  readable(os) { return this.list().filter((p) => p.selectors && p.apps[os]); }

  lag(id, kind) { return this.get(id)?.lagMs?.[kind] ?? null; }
}

const PLATFORMS = new PlatformRegistry([MEET, TEAMS, ZOOM, DISCORD]);

module.exports = { PlatformRegistry, PLATFORMS, DEFAULT_PLATFORM, platformId };
