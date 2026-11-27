# Discord without a bot (local RPC)

An alternative to the Discord bot. The Discord **desktop app** runs a local RPC server, reachable only from this computer over a socket (`discord-ipc-0..9`; Linux/macOS under `XDG_RUNTIME_DIR`, `TMPDIR`, `TMP`, `TEMP` or `/tmp`, also where a Flatpak or snap puts it; Windows a named pipe `\\?\pipe\discord-ipc-N`). An application the person authorises can ask it for three things:

- **which voice call the person is in** (`GET_SELECTED_VOICE_CHANNEL`, and the `VOICE_CHANNEL_SELECT` event when it changes). Only that call: people in other channels never count;
- **who is in that call**, with the name the call shows (server nickname first) and their Discord user id (`VOICE_STATE_*` events);
- **when each person starts and stops speaking** (`SPEAKING_START` / `SPEAKING_STOP`, with the user id).

Nobody joins the call and the other people see nothing. It does not depend on how the window looks. Code: `src/discord/rpc.js` (connection), `src/discord/rpc-source.js` (the source on the signal hub, platform `discord`).

## Set up

1. Discord Developer Portal → **New Application** (your own: you are its tester). OAuth2 → Redirects → add `http://localhost`.
2. Settings → Integrations → *Discord, without a bot*: paste the Client ID and the Client Secret, switch it on, save.
3. Press **Authorise in Discord** and accept in the Discord app (it must be running). The tokens are stored and masked like the other integration secrets. *Disconnect* forgets them.

Scopes asked: `rpc` and `rpc.voice.read`. If the saved token stops working it is refreshed once; if that fails the card says *Not authorised yet*.

## Limits (also said in Settings)

- **No audio per person**, only who speaks and when. Separating voices still relies on the speaker pipeline. When two people speak at once that moment names nobody.
- **Your own Discord application.** Until Discord approves an application only the people on its tester list (up to 50, from the official RPC docs) can use it. You are a tester of your own, so personal use works. Shipping this to other people would need Discord's approval.
- **Discord recommends the Social SDK** for new projects. RPC over IPC is still documented but its future is not guaranteed. RPC over WebSocket is deprecated (only for old participants of the private beta) and is **not** used.
- The consent notice settings apply unchanged; Discord tells the other people nothing.

## Rejected alternatives (not built)

- The person's own account token (a *selfbot*): breaks Discord's terms and can get the account banned.
- Client mods (BetterDiscord and the like): same problem.
- Reading the Discord window: the sidebar mixes in people from other channels and names often show only on hover.

## How it fits

The source reports a state to Settings (*not set up*, *Discord not running*, *not authorised*, *connected*, *in a call*) and retries with a growing pause (1, 2, 5, 15, 30 s) when Discord is closed or goes away; recording carries on with normal capture meanwhile.

Joining or leaving a Discord voice call is a `meeting` message of platform `discord`, so the meeting detector gets an exact signal. **While the RPC connection is up, the sound-based guess for Discord (heard 3 times in 90 s, held 3 min) is not used at all**: the hub lists the platform as *authoritative*, and Discord's sound proves nothing, in a call or not. Without RPC nothing changes.

## What is verified and what is not

- ✅ The whole protocol against a **fake Discord on a socket** (`test/discord-rpc.test.js`): framing, handshake, authorise (code → token), authenticate, token refresh, subscribe/unsubscribe per call, joining/leaving/changing channel, ignoring events of other channels, Discord closing and coming back, backoff.
- ✅ Against this computer's real, stale socket file: *Discord is not running*, retry.
- ⚠ **Not run against a real Discord**: no Discord was running here, and it needs your own application. The first thing to find out, and to write here:
  - [ ] **Do server voice channels, private (DM) calls and group calls all report the selected channel, the people and the speaking events?** If DM or group calls do not, say so here and in Settings (the card already warns that it is not known).
  - [ ] Linux real call: the card shows the call and the number of people; joining/leaving gives *meeting detected* / *ended*.
  - [ ] macOS and Windows: use the documented socket paths (tested with the fake only).
  - [ ] Measure the lag of `SPEAKING_START` against the real start of speech (see #28) and replace the default in `src/meet/platforms.js` (`lagMs.rpc`, now a guess of 150 ms).

## Naming accuracy on the simulated call set (#28)

`node eval/discord-rpc-naming.js` runs a six-turn, three-voice call through the whole path (RPC events → source → hub → collector → the existing vote) and scores it with the eval's own `namingAccuracy` (share of speech time that carries the right name). The event streams are synthetic: they show what the vote does with this kind of signal, not what Discord's real events look like.

| Stream | Naming accuracy |
|---|---|
| no names (before) | 0 % |
| clean stream, 150 ms / 400 ms / 1000 ms after the voice starts | 100 % |
| 2 of the 6 highlights name the wrong person | 100 % (outvoted) |
| every voice overlapped by a second speaker the whole time | 0 %, nobody named, **nothing wrong** |
| the stream names one person for everybody | 0 %, and 12 s of speech carries a wrong name: a stream that is wrong everywhere cannot be told from a right one |

**WDER is not reported.** The RPC source changes who a voice is called, not where the segments are: the speaker pipeline is untouched, so its WDER is what it was. (The voice fixes the names can trigger, joining or splitting voices, work as before and need real audio to score; the eval set that scores WDER needs datasets that are not in this checkout.) **The lag is not measured either**: the default (150 ms) is a guess and has to be replaced with a measurement against the existing Discord speaker test recording (the bot's per-person streams as reference, evaluation only), which needs a real call.

## Still open (nothing here could be run without a real Discord)

- [ ] Do server voice channels, DM calls and group calls all report the selected channel, the people and the speaking events?
- [ ] Measure the `SPEAKING_START` lag and set `lagMs.rpc` in `src/meet/platforms.js`.
- [ ] Naming accuracy and WDER on a real call with the speaker test recording as reference.
- [ ] The bot joining *after* the RPC source already told the roster: the source checks on every roster and speaking event, so it stops naming from the next event on, but what it already said stays.
