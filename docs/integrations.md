# Integrations

How to connect WhisperBrain to calendars and other tools.

- **Google Calendar**: Integrations → Google Calendar. Either sign in (create a *Desktop app* OAuth client in Google Cloud with the Calendar API enabled; paste its client ID and secret) or paste the calendar's *secret address in iCal format*.
- **Notion**: create an internal integration at notion.so/my-integrations, share the target page or database with it, paste the secret, pick the page.
- **Linear**: Settings → Security & access → Personal API keys; paste the key and choose a team.
- **Discord**: [Developer Portal](https://discord.com/developers/applications) → New Application → Bot → Reset Token. Paste the token and your own user ID (Discord: Settings → Advanced → Developer Mode, then right-click your name → Copy User ID) in Integrations → Discord, press *Save & test* and open the invite link to add the bot to your server (needs View Channel and Connect; no privileged intents). While you are in a voice channel and record, the bot joins, listens to each person separately and leaves when you stop; your own voice stays on the microphone channel. Everyone in the call can see the bot, so tell them you are recording. The test joins your call for 8 seconds and reports who it heard and whether the call is end-to-end encrypted.
- **Obsidian**: point it at your vault folder. Notes go to `Meetings/` (configurable) with frontmatter and `[[wikilinks]]` to people and topics.
- **Webhooks**: each POST carries the meeting as JSON (including Markdown); with a secret it is signed in `X-WhisperBrain-Signature: sha256=<hmac>`.


All tokens stay in the local database and are never sent to the UI.
