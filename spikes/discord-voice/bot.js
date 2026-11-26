// Spike: can a bot still receive each speaker separately under Discord DAVE (E2EE)?
//   DISCORD_BOT_TOKEN=... node bot.js <guildId> <channelId> [--minutes N]
// Writes out/<run>/<userId>.wav per speaker, plus speakers.json and session.json.
import fs from 'node:fs';
import path from 'node:path';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import {
  joinVoiceChannel, entersState, VoiceConnectionStatus, EndBehaviorType, generateDependencyReport,
} from '@discordjs/voice';
import { UserTrack } from './track.js';

const versions = Object.fromEntries(['discord.js', '@discordjs/voice', '@snazzah/davey', 'opusscript'].map((p) => [
  p, JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'node_modules', p, 'package.json'))).version,
]));

const [guildId, channelId] = process.argv.slice(2).filter((a) => /^\d{15,25}$/.test(a));
const minutesArg = process.argv.indexOf('--minutes');
const minutes = minutesArg > 0 ? Number(process.argv[minutesArg + 1]) : 0;
const token = process.env.DISCORD_BOT_TOKEN;
if (!token || !guildId || !channelId) {
  console.error('usage: DISCORD_BOT_TOKEN=... node bot.js <guildId> <channelId> [--minutes N]');
  process.exit(2);
}

const runDir = path.join(import.meta.dirname, 'out', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(runDir, { recursive: true });
const debugLog = fs.createWriteStream(path.join(runDir, 'voice-debug.log'));
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const speakers = {};
const tracks = new Map();
const session = { versions, node: process.version, guildId, channelId, dave: {}, decryptFailures: 0 };
let t0 = 0;
let connection;

async function describe(guild, userId) {
  if (speakers[userId]) return speakers[userId];
  // Members in a voice channel arrive with the voice state, so the cache usually has
  // them; fall back to a single REST fetch (no privileged GuildMembers intent needed).
  const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
  const user = member?.user ?? (await client.users.fetch(userId).catch(() => null));
  speakers[userId] = {
    userId,
    username: user?.username ?? null,
    globalName: user?.globalName ?? null,
    displayName: member?.displayName ?? user?.globalName ?? user?.username ?? userId,
    bot: user?.bot ?? false,
  };
  log(`speaker ${userId} -> ${speakers[userId].displayName} (@${speakers[userId].username})`);
  return speakers[userId];
}

function subscribe(guild, userId) {
  if (connection.receiver.subscriptions.has(userId)) return;
  describe(guild, userId);
  let track = tracks.get(userId);
  if (!track) {
    track = new UserTrack(path.join(runDir, `${userId}.wav`), t0);
    tracks.set(userId, track);
  }
  track.stats.utterances++;
  const stream = connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 } });
  stream.on('data', (opus) => track.push(opus));
  stream.on('error', (e) => log(`stream error ${userId}: ${e.message}`));
}

async function finish(reason) {
  if (finish.done) return;
  finish.done = true;
  log(`stopping (${reason})`);
  const endMs = Date.now() - t0;
  for (const s of connection?.receiver.subscriptions.values() ?? []) s.destroy();
  session.endedAt = new Date().toISOString();
  session.tracks = {};
  for (const [id, t] of tracks) session.tracks[id] = { ...t.close(endMs), displayName: speakers[id]?.displayName };
  fs.writeFileSync(path.join(runDir, 'speakers.json'), JSON.stringify(speakers, null, 2));
  fs.writeFileSync(path.join(runDir, 'session.json'), JSON.stringify(session, null, 2));
  connection?.destroy();
  await client.destroy();
  debugLog.end();
  log(`wrote ${tracks.size} track(s) to ${runDir}`);
  console.table(Object.values(session.tracks).map(({ file, ...r }) => r));
  process.exit(0);
}

client.once(Events.ClientReady, async () => {
  log(`logged in as ${client.user.tag}`);
  debugLog.write(generateDependencyReport() + '\n');
  const guild = await client.guilds.fetch(guildId);
  const channel = await guild.channels.fetch(channelId);
  if (!channel?.isVoiceBased()) throw new Error(`${channelId} is not a voice channel`);

  connection = joinVoiceChannel({
    guildId, channelId, adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false, selfMute: true, daveEncryption: true, debug: true,
  });
  connection.on('debug', (m) => {
    debugLog.write(`${new Date().toISOString()} ${m}\n`);
    if (/Failed to decrypt/.test(m)) session.decryptFailures++;
    if (/DAVE|protocol version|transition|MLS|Session/i.test(m)) log(`[voice] ${m.slice(0, 160)}`);
  });
  connection.on('stateChange', (_, s) => log(`connection -> ${s.status}`));
  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  t0 = Date.now();
  session.startedAt = new Date(t0).toISOString();

  const net = connection.state.networking?.state;
  session.encryptionMode = net?.connectionData?.encryptionMode;
  // The DAVE session lives on the networking state once the voice WS is ready.
  const readDave = () => {
    const d = connection.state.networking?.state?.dave;
    session.dave = { present: Boolean(d), protocolVersion: d?.protocolVersion ?? 0, privacyCode: d?.voicePrivacyCode ?? null };
    return session.dave;
  };
  log(`joined #${channel.name}; transport=${session.encryptionMode}; dave=${JSON.stringify(readDave())}`);
  setInterval(readDave, 2000).unref();

  for (const id of channel.members.keys()) if (id !== client.user.id) describe(guild, id);
  connection.receiver.speaking.on('start', (userId) => {
    if (userId !== client.user.id) subscribe(guild, userId);
  });
  if (minutes > 0) setTimeout(() => finish(`${minutes} min elapsed`), minutes * 60_000);
  log('recording; press Ctrl+C to stop');
});

process.on('SIGINT', () => finish('SIGINT'));
process.on('SIGTERM', () => finish('SIGTERM'));
client.login(token);
