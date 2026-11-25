# Meeting assistant

Help *during* a call. When somebody on the other side asks a question, the assistant drafts a short suggestion from your own material (your **briefings**: project notes, an agenda, client or company notes) and from what was said. It also keeps a live summary, explains technical terms, answers questions you type about the call, and can read a question on your screen.

It is **off by default**. Turn it on in *Settings → Assistant*, or for a single meeting with the switch on the meeting page.

## What you see

**Meeting page, side column.** While the meeting records, this column shows:
- the question from the other side;
- the suggestion as it is written;
- **Answer now** and **Another angle**;
- an **Ask about this call** box;
- the live summary (decisions, action items, open questions);
- term cards;
- the briefings attached to the meeting.

After the meeting, the same panel lists what the assistant showed.

**Floating window.** When the app is behind your call:
- The expanded card shows the newest suggestion above the live transcript, with *Another angle*, *Copy* and an ask box.
- The collapsed pill shows a mark when a new suggestion arrives.
- The window never takes the keyboard by itself. It becomes focusable only while you type a question, and gives the focus back when you send it.

**Briefings** (`#/briefings` in the sidebar). Paste text, or import PDF, Word, Markdown, text or HTML. A briefing is a *project*, an *agenda*, a *client*, a *company* or plain *notes* (an imported file starts as notes). Each briefing keeps a list of terms, which also bias speech recognition for the meetings it is attached to.

## How it decides

The decision is made in `src/assistant/turns.js`. It runs on the live transcript only, with no AI involved.

**1. Wait for the other side to pause.** After a final line from the other side, it waits:

| The line… | Wait |
|---|---|
| ends with "?" | 120 ms |
| ends normally | 600 ms |
| is cut off ("…and how did you, um") | 3.2 s, for the rest |

**2. Decide whether to help.** In the **bullet points** style, only questions trigger help. In the **spoken reply** style, prompts such as "tell me about the project…" or "walk me through the plan…" do too. Lines in English and European Portuguese are understood, including a short lead-in such as "So, to start, …".

**3. Ignore what is not a question.** These never trigger help:
- fillers ("ok", "pois") and backchannels ("mm-hmm");
- the user reading a suggestion aloud and being picked up through the speakers;
- the same question asked again within 20 s.

"Can you repeat that?" shows the last answer again.

**4. Prepare, then show.** A suggestion is prepared in the background, then shown once the other side has stayed quiet. The delay is *Settings → Assistant → Wait before showing*; a "?" question is shown sooner. If they keep talking, the prepared suggestion is dropped and never shown.

**5. Your own words count.** When you answer (your microphone), the other side's turn ends. Their earlier lines are then not glued onto their next question.

## What the AI is given

`src/assistant/context.js` builds the context within one character budget. It contains:
- the excerpts of your briefings that bear on the question, picked by word overlap;
- what was just said;
- the last few questions and the help given;
- facts you already stated about yourself (so a suggestion does not contradict you);
- glossary entries that come up.

When the budget is short, your facts go first, then older answers, then the oldest lines, and the briefing is cut last.

The prompt (`assistantMessages` in `src/llm/prompts.js`) says to use only facts from that context and never invent facts, names, numbers, dates or decisions. A sentence the material does not support must start with `[GAP]`; on screen it is underlined as *not in your briefings*.

The two styles (*Settings → Assistant → Style*):
- **Bullet points** (the default): 2 to 4 short points to glance at while you talk.
- **Spoken reply**: a first-person reply you can say aloud, for example when you present a project or answer a client's question on the call.

## Privacy

- **Only a local AI server is used, unless you allow another.** Help runs automatically only when your AI server is on this computer. *Allow an AI server that is not on this computer* must be switched on before what is said on a call is sent anywhere. An organisation's `requireLocalLlm` policy still applies.
- **Nothing runs when someone objects.** If you marked that somebody objected to the recording, the assistant is off for that meeting.
- **It is an ordinary window.** It does not hide from screen sharing or from the other people, and it is not meant to.
- **What is stored, and what is not.** Suggestions, typed questions, live summaries and term cards are kept with the meeting (`assistant_events`). They are deleted with the meeting, and by retention. A screenshot for a screen question is sent to the AI and never stored.
- **No telemetry, no account.**

## Shortcuts

These are global and work only while the assistant is switched on. Change them in *Settings → Assistant*; leave a field empty to switch that shortcut off. A shortcut that cannot be registered is reported.

| Default | Action |
|---|---|
| `Ctrl/Cmd+Alt+Enter` | Answer now (show what is prepared, or prepare one from what was last said) |
| `Ctrl/Cmd+Alt+R` | Another angle |
| `Ctrl/Cmd+Alt+K` | Ask about the call (opens the floating window's ask box) |
| `Ctrl/Cmd+Alt+J` | Assistant on/off for this meeting |
| `Ctrl/Cmd+Alt+S` | Question on screen (a picture of the screen under the pointer, sent to a vision model) |

On Wayland, global shortcuts depend on the compositor. Some report success and never fire, so an X11 session is the reliable choice.

## Measured

- **Question detection.** `node eval/assistant-replay.js` replays timed dialogs (`test/fixtures/assistant/`: English and Portuguese, a team meeting in the bullet-points style and a client project review in the spoken-reply style, with fillers, backchannels, cut-off sentences, repeats, duplicates and echo) on a simulated clock.
  - Result: precision 1.00, recall 1.00 (F1 1.00).
  - A suggestion is shown a median **1.2 s** after the speaker stops (ASR finalisation included; AI time not included).
  - The rules were tuned on these same dialogs, so treat this as a regression check, not as accuracy on real calls.
- **AI time.** `WB_EVAL_LLM=1 WB_EVAL_LLM_URL=… WB_EVAL_LLM_MODEL=…` adds the time to the first words of a real suggestion. See [eval/README.md](../eval/README.md) for the numbers measured on this machine.
- **Try it without a call.** `node scripts/assistant-demo.js` starts the app on a throw-away folder with a project briefing and plays a short client project review through the recorder's events, with a built-in stand-in AI. Add `--llm http://127.0.0.1:11434/v1 --model <name>` to use a real one.

## Limits

- **Technical-term spotting** catches acronyms, CamelCase and names with digits (SLA, gRPC, k8s, OAuth2). Ordinary capitalised words such as "Kubernetes" get a card only when they are in your glossary.
- **Mixed call audio.** With one mixed stream for the whole call, every remote voice is "them". Who asked is not used to decide whether to help.
- **Platforms.** macOS and Windows use the same code and the same windows. Their capture adapters, the floating window's focus behaviour and the global shortcuts have not been run on real Mac or Windows hardware yet; see the platform table in the README.
