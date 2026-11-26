# If the spike works: Discord as a WhisperBrain source

Status: **draft**. Only applies if the real-call test in `README.md` passes.

## Shape

A new capture source, `discord`, next to `mic` and `system`. It is a bot connection
(the code in `bot.js` + `track.js`) that turns every Discord user in the voice channel
into **its own channel** in the recording.

- Channel key: `discord:<userId>`. Each one is a `PushSource` (`src/audio/source.js`)
  fed 16 kHz mono s16le. `track.js` already produces exactly that format.
- Speaker id = Discord user id. Label = guild display name (`member.displayName`),
  refreshed on `GuildMemberUpdate`. Stored in `note_speakers` with `channel =
  discord:<userId>`, and linked to a remembered voice so the name carries over to
  calls on other apps.
- **No diarization and no online clustering on these channels.** Each channel is one
  person by construction. Skip `SpeakerTracker`, the after-Stop pyannote pass and
  `refine` for them. Overlap is solved too: two people talking at once are two
  channels, so the ASR hears both.
- Timeline: one `t0` per recording (bot `Ready`). Segments carry wall-clock offsets
  from the silence-filled position, so the transcript interleaves correctly. A user
  who joins late just starts with silence.

## What changes in the app (later, not in this spike)

1. `src/recording/manager.js` assumes two channels in about 18 places (`epoch`,
   `stretches`, `drafts`, the echo check, `{ mic, system }` literals). Make the
   channel set dynamic: create per-channel state on first audio.
2. ASR: `engine.feed(ch, pcm)` already takes a channel name. Check that the live
   worker keeps up with 4 to 6 parallel VAD+ASR streams. Most of the time only one
   or two are active, and silence-filled gaps should not go through the VAD: feed
   only real packets and pass the offset along.
3. Mic and system audio: in a Discord meeting the bot also receives *your* stream.
   Either drop `mic`/`system` for that note, or keep `mic` (better quality, no network)
   and ignore your own Discord user id. No echo check needed: Discord clients already
   cancel echo, and per-user streams carry no other voices.
4. Settings: bot token in the OS keychain (`safeStorage`), never in the DB or logs.
   Server + voice channel picker. Auto-join when the meeting-join detector sees
   Discord, or a "Record this channel" button.
5. Consent: the bot is visible in the channel. Show its name clearly
   ("WhisperBrain recorder") and let the user post a short notice when it joins.

## Limits

- Server voice channels only. Bots cannot join DMs or group DM calls.
- Each user has to create their own bot application and token (the README steps).
  Distributing one shared bot would mean hosting it, which breaks local-first.
- Voice receive is unofficial in Discord's API. Pin `@discordjs/voice` and
  `@snazzah/davey` and keep this spike as a smoke test for upgrades.
