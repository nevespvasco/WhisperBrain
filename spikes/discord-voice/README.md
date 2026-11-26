# Discord per-user voice spike (throwaway)

Question: now that Discord's DAVE end-to-end encryption is mandatory, can a bot in a
server voice channel still receive **each person's audio separately**? If yes,
WhisperBrain can skip diarization for Discord calls and keep overlapping speech.

Not part of the app. Nothing here is imported by `src/`.

| file | what it does |
| --- | --- |
| `bot.js` | joins a voice channel, writes one 16 kHz mono WAV per user id into `out/<run>/` |
| `track.js` | Opus to PCM per user, silence-filled so every file shares one wall clock |
| `analyze.js` | talk time, overlap matrix, waveform correlation, timeline, writes `mix.wav` |
| `selftest.js` | offline check of `track.js` + `analyze.js` with synthetic Opus (no Discord) |

Pinned versions: `discord.js` 14.28.1, `@discordjs/voice` 0.19.2, `@snazzah/davey`
0.1.12 (the DAVE/MLS implementation `@discordjs/voice` uses), `opusscript` 0.0.8.
Node 22.12 or newer (tested on 26).

## 1. Create the bot (you do this, once)

1. Open <https://discord.com/developers/applications> and click **New Application**.
   Name it something obvious like `WhisperBrain recorder`.
2. **Bot** tab:
   - **Reset Token**, then copy it. It is shown once. Treat it like a password: never
     paste it into chat, an issue or a file in this repo (the repo is public).
   - Turn **Public Bot** off, so only you can add it to servers.
   - Leave all three **Privileged Gateway Intents** off. The spike only uses
     `Guilds` and `GuildVoiceStates`, which need no switch.
3. **OAuth2 → URL Generator**:
   - Scopes: `bot`.
   - Bot permissions: **View Channels** and **Connect**. Nothing else (the bot joins
     muted and never speaks).
   - Open the generated URL, pick the server, **Authorize**. You need *Manage Server*
     on that server.
4. In the Discord app: **User Settings → Advanced → Developer Mode** on. Then right-click
   the server → **Copy Server ID**, and right-click the voice channel → **Copy Channel ID**.

## 2. Run it

```bash
cd spikes/discord-voice && npm install
```

Read the token without it landing in shell history:

```bash
read -rs DISCORD_BOT_TOKEN && export DISCORD_BOT_TOKEN
```

```bash
node bot.js <serverId> <voiceChannelId>
```

Add `--minutes 5` to stop on its own; otherwise press Ctrl+C. Then:

```bash
node analyze.js
```

Tell everyone in the call that a recording bot is joining before you start.

## 3. Test script for the call (2+ people, about 2 minutes)

1. One at a time, each person says their name and counts to five. (attribution)
2. Two people talk at the same time for about ten seconds, each reading different
   text. (overlap)
3. Everyone talks at once for about five seconds. (worst case)
4. Ctrl+C, then `node analyze.js`.

## What "it works" looks like

- `session.json` → `dave.protocolVersion` is 1 or higher (E2EE was on) and
  `decryptFailures` is 0 or a handful during joins.
- One `<userId>.wav` per person, each named correctly in `speakers.json`.
- Each file plays back only that person's voice (`decodeErrors` 0, no static).
- `analyze.js`: the overlap matrix shows seconds where two people are both active,
  the timeline marks them with `!` in **both** rows, and off-diagonal waveform
  correlation stays near 0 (near 1 would mean the files are the same mixed audio).

Why it should work: a bot that joins the call is a member of the call's MLS group,
so it gets the media keys like any other participant. DAVE hides audio from Discord's
servers, not from people (or bots) in the call. Discord still sends one RTP stream per
speaker (one SSRC each), and `@discordjs/voice` decrypts each with the sender's key
(`DAVESession.decrypt(userId, …)`).

Caveat: Discord does not officially support bots *receiving* voice. It works today
through `@discordjs/voice`, and could break if Discord changes the voice protocol.

## Output

`out/` is gitignored: it holds real people's voices. Delete runs when done.
