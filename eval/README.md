# Speaker-attribution evaluation

A small harness that plays real multi-speaker recordings through the actual recording pipeline
(`RecordingManager` → ASR worker → transcript store → after-Stop speaker passes) and scores who said what.

```bash
node eval/prepare.js                 # downloads and builds the test recordings into .eval/data (not committed)
node eval/run.js                     # all configurations on all recordings; results in .eval/results/
node eval/run.js --configs online,diarize --only libri-call --threshold 0.5
```

Models come from `$WB_MODELS_DIR` or `./.models`. That means a speech model (Parakeet TDT 0.6B v3), the VAD, the voice model and the speaker-segmentation model; `node scripts/fetch-models.js parakeet-tdt-0.6b-v3` fetches all of them.

## Metrics (`metrics.js`)

- **WDER** (word diarization error rate, DiarizationLM): of the words the recognizer matched or substituted, the share given to the wrong speaker under the best one-to-one speaker mapping. It isolates attribution from ASR errors.
- **cpWER**: concatenated minimum-permutation WER. Each speaker's words are joined, speakers are paired optimally, and a word given to the wrong speaker counts twice (a deletion plus an insertion).
- **tcpWER**: cpWER where two words may only be paired if their times overlap within a 5 s collar, as in [meeteval](https://github.com/fgnt/meeteval).

Hesitations (uh, um, mm-hmm…) and punctuation are dropped on both sides. The JS cpWER and tcpWER can be cross-checked against meeteval itself with `--meeteval path/to/meeteval-wer` (`pip install meeteval simplejson`).

## Recordings (`prepare.js`)

| Name | Source | Channels | Speakers | Notes |
|---|---|---|---|---|
| `ami-IS1009a` | AMI meeting IS1009a, headset mix (CC BY 4.0) | system | 4 | 14 min, real overlap, reference words from the manual annotations |
| `libri-call` | Built from LibriSpeech dev-clean (CC BY 4.0) | mic + system | 1 + 3 | 5.6 min, 37 same-channel turn changes with less than 0.6 s of pause, some overlap |

More AMI meetings: `node eval/prepare.js --ami IS1009a,ES2004a,TS3003a`. The AMI mirror is sometimes unavailable (HTTP 503).

## Configurations (`run.js`)

| Config | `speakerDiarize` | `speakerRefine` | What runs |
|---|---|---|---|
| `online` | off | off | Live labels only: one embedding and one speaker per VAD utterance |
| `refine` | off | on | (old default) MFCC/F0 split, merge and reassign from `src/speakers/refine.js` |
| `diarize` | on | off | pyannote segmentation-3.0 + global clustering per channel, word-level assignment |
| `diarize+refine` | on | on | Both |

## Results (2026-11-24, Parakeet TDT 0.6B v3, WeSpeaker ResNet34-LM, pyannote segmentation-3.0)

Lower is better. WER (speaker-agnostic, same ASR in every row): 35.6 on AMI, 25.6 on libri-call. The JS cpWER/tcpWER matched `meeteval-wer` exactly on every row where both were run.

| Recording | Config | WDER | cpWER | tcpWER | Speakers found / true |
|---|---|---|---|---|---|
| ami-IS1009a | online (before) | 34.1 | 74.6 | 77.3 | 1 / 4 |
| ami-IS1009a | refine only (old default) | 34.1 | 74.6 | 77.3 | 1 / 4 |
| ami-IS1009a | diarize | 25.4 | 59.2 | 66.9 | 6 / 4 |
| ami-IS1009a | **diarize+refine (new default)** | **18.1** | **47.6** | **54.4** | 4 / 4 |
| libri-call | online (before) | 48.2 | 92.9 | 95.8 | 2 / 4 |
| libri-call | refine only (old default) | 48.2 | 92.9 | 95.8 | 2 / 4 |
| libri-call | diarize | 24.9 | 57.1 | 61.3 | 3 / 4 |
| libri-call | **diarize+refine (new default)** | **24.9** | **57.1** | **61.3** | 3 / 4 |

Absolute change from before to the new default: AMI WDER 34.1 → 18.1, cpWER 74.6 → 47.6, tcpWER 77.3 → 54.4; libri-call WDER 48.2 → 24.9, cpWER 92.9 → 57.1, tcpWER 95.8 → 61.3.

Things to know before trusting these numbers:

- **Clustering threshold** (sherpa FastClustering distance, `DEFAULTS.threshold` in `src/speakers/final.js`) is fragile. diarize-only AMI WDER: 0.5 → 25.4 (6 speakers), 0.6 → 25.4 (6), 0.7 → 20.9 (3), 0.8 → no gain. libri-call: 0.5 → 27.7 (5), 0.6/0.7 → 24.9. But at 0.7 two clean, clearly different voices in the real-voice unit test were merged into one, so the default is 0.6 (over-split, then repaired by refine) rather than 0.7.
- **Acoustic refine** (`speakerRefine`, MFCC/F0 split/merge/reassign) only helps on top of diarization. On its own it changed nothing. After diarize at 0.6 it merges the two extra clusters on AMI (25.4 → 18.1) and is neutral on libri-call. At 0.7 it hurt (20.9 → 23.5). It is on by default because the shipped configuration shows a gain, but that rests on one real meeting; re-check when more recordings are added. F0 also stays as the veto in consolidate/autoMatch.
- Both recordings were also used to pick the threshold, so expect some optimism. Add more AMI meetings (`node eval/prepare.js --ami ...`) before tuning further.
- **Stop-time cost:** about 45-55 s for 14 min of single-channel audio, about 30 s for 5.6 min over two channels (8 threads, an idle machine).
- **Still wrong (see the section at the end for what was tried since):** libri-call still merges two of its three remote voices, and overlapped words go to the dominant speaker. Next steps from the research report: VBx instead of AHC, speaker-count hints from the calendar, and caching segmentation/embeddings during recording.

## Saved voices (`voices.js`)

How well does `Speakers.autoMatch` link a meeting's unnamed speakers to saved voices ("Ana", "Bruno"), and leave strangers alone?

```bash
node eval/voices.js extract            # once, about 25 min: voice prints of the real readers, cached in .eval/voices (needs ffmpeg and the voice model)
node eval/voices.js [run] [--trials 300] [--seed 7] [--only "video call"] [--json]
node eval/voices.js calibrate [--cost 3]   # picks threshold/margin on one half of the people, scores them on the other half
node eval/voices.js mean               # prints the VOICE_MEAN constant of src/speakers/cluster.js (base64)
```

**Data.** The 40 LibriSpeech dev-clean readers already fetched by `prepare.js` (31 have 2-4 chapters, recorded in different sessions; nothing else was downloaded). A chapter plays a "meeting": a person is saved from one chapter and must be recognised in another. Per chapter: 16 utterances (cut at 10 s) and 3 pooled 30 s voice prints, as `final.js` makes them. The 9 single-chapter readers and the readers left off the roster are the strangers (open set). A "video call" and a "poor phone line" are made from the same audio with ffmpeg (hiss, band limiting, echo, Opus 24 / 12 kbit/s): simulated, not real calls. Each history is a random roster of 6 saved voices (a meeting with 3 of them plus 3 strangers); the people are split into two halves, the average voice (below) always comes from the other half than the one being scored, and the figures are pooled over both halves.

**Before.** One running mean per voice (weighted by utterance count), raw cosine >= 0.65, a 4-semitone pitch veto, one voice per speaker and one speaker per voice. The harness reproduces the committed code exactly (300/300 random trials identical). "Old, 0.8" is the cheapest alternative fix, just raising the threshold.

**What the data said**

- The main problem is the yardstick, not the profile. With this model every pair of voices shares a large common component: on clean prints two *different* readers have a median cosine of 0.56 (95th percentile 0.79), the same reader 0.92. So 0.65 links 43 % of strangers to somebody (76 % with 12 saved voices) and the cheap fix (0.8) costs recall and still links 7-19 % of strangers. Subtracting the average voice first (a constant of the shipped model, `VOICE_MEAN`, the mean of 291 prints of these 40 readers) and comparing what is left is what separates people: strangers linked 43 % -> 1.5 % at a smaller recall loss than raising the threshold.
- A call and a room microphone each add a constant colour to every voice (plain cosines between *anybody* on a call are 0.7+), which is why calls were the worst case: 60 % of strangers linked. The average voice is therefore kept per channel and pulled towards the distinct voices actually heard on it (`populationMean`, from `note_speakers`; people who are in every meeting count once). That cut strangers linked on calls from 60 % to 6 % and, as a side effect, lets a voice saved on one channel be recognised on the other (55 % now with 1 % of strangers linked; 35-37 % with the old code at 0.8; the old code at 0.65 got 79-82 % but also linked 34-41 % of strangers).
- Several prints per profile did **not** help within one channel: max, top-2 mean or the plain mean of prints scored within about a point of each other (top-2 slightly worse; sweep run during development, not part of the harness), so there is no point keeping 8 near-identical prints. What helps is a print per channel (up to 6 are kept, near-duplicates of a channel merge), which matters when a person is saved on both (mic+call rows) and for the discount-free cross-channel score. Saving a voice from a second meeting does help (recall 86 -> 91 % in the same-mic rows), so `rename(remember)` adds the speaker's print instead of blending counts (same note + speaker again replaces its print), weighted by seconds of speech capped at 30 s (what a pooled print covers). Whether count or seconds is the better weight was not measured: the pooled prints here all cover about 30 s.
- The margin rule (best vs second-best voice) hardly matters once scores are centred: margin 0 -> 0.05 moved wrong-person links from 0.5 % to 0.3 % at threshold 0.55 and nothing at 0.6, for 0.2-0.6 points of recall. It is kept (0.02) as a cheap guard. A cross-channel discount did not help (best 0), the per-channel average already removes the offset.
- Corrections: when a speaker that was linked to a voice is renamed to someone else, that print is stored on the voice as "not you". At a deliberately lenient threshold (0.45, so that lookalikes get linked) the same lookalike was wrongly linked again in 70 % of 20 pairs without it and 5 % with it, the owner staying 100 % recognised. Unit tests cover the store behaviour.
- `autoMatch` now judges again the links it made automatically (live, on a few utterances) once the after-recording print exists, and withdraws them if they no longer hold. Speakers the user named are never touched.

**Results** (300 random histories per half and scenario, seed 7, `node eval/voices.js`; percentages of known speakers, strangers linked = of strangers)

| Scenario | Old: correct / wrong person / strangers linked | Old at 0.8 | **New** |
|---|---|---|---|
| same mic, 1 meeting saved | 92.3 / 1.9 / 43.0 | 88.7 / 0.5 / 7.2 | 86.2 / 0.0 / 1.5 |
| same mic, 2 meetings saved | 95.1 / 1.1 / 47.1 | 92.3 / 0.2 / 9.7 | 90.6 / 0.1 / 1.6 |
| 12 saved voices | 92.9 / 4.6 / 76.4 | 89.2 / 1.3 / 18.6 | 87.6 / 0.3 / 2.7 |
| live, 3 utterances | 94.6 / 1.7 / 47.4 | 89.6 / 0.7 / 7.7 | 83.7 / 0.1 / 1.3 |
| live, 1 utterance | 90.5 / 2.5 / 39.8 | 74.6 / 0.8 / 4.5 | 61.2 / 0.1 / 0.7 |
| video call -> video call | 92.4 / 4.7 / 59.9 | 91.7 / 3.4 / 39.2 | 84.8 / 0.3 / 5.7 |
| poor phone line -> phone line | 84.6 / 10.9 / 67.4 | 84.6 / 9.9 / 60.5 | 78.7 / 5.0 / 25.1 |
| saved on mic, heard on call | 82.4 / 7.3 / 33.6 | 37.3 / 1.4 / 3.1 | 54.5 / 0.4 / 1.1 |
| saved on call, heard on mic | 79.1 / 6.2 / 41.1 | 34.4 / 0.9 / 6.2 | 55.6 / 0.5 / 0.9 |
| saved on mic+call, heard on call | 93.8 / 3.4 / 64.1 | 92.6 / 2.2 / 34.7 | 86.7 / 0.4 / 6.8 |
| saved on mic+call, heard on mic | 93.0 / 1.8 / 49.5 | 85.0 / 0.4 / 11.1 | 90.2 / 0.1 / 1.6 |
| first days: 2 voices, no history, mic | 93.5 / 0.1 / 1.8 | 88.6 / 0.0 / 0.3 | 80.7 / 0.0 / 0.0 |
| first days: 2 voices, no history, call | 96.7 / 0.2 / 2.8 | 94.5 / 0.2 / 0.8 | 82.8 / 0.0 / 0.2 |

In short: strangers wrongly linked drop from 40-76 % to 1-6 % and wrong-person links from 2-5 % to about 0 %, in exchange for 6-10 points of recall (more with one short utterance, and with only one or two saved voices, where the old settings were already safe). The poor phone line is not solved (25 % of strangers still linked, but better than 67 %).

**How far to trust this**

- Sample: 40 readers, 31 of them usable as saved voices. Histories are random redraws from the same people, so they are not independent; the effective sample is the people, not the 1800 decisions per row. Differences of a few points between rows are noise (the two halves of the people differ by 10 points in recall: 91 % vs 81 % in `calibrate`); the 40 % -> 2 % change in strangers linked is far beyond that.
- Read speech in clean recordings, one microphone chain per reader across chapters: easier than real meetings. Real calls, other microphones, noisy rooms, and people who are ill or tired were not tested. The call and phone channels are simulated. No real meeting audio with the same people in two meetings was available (AMI participants do not recur in the downloaded meetings).
- The average voice used in the table is built from the other half of the people. The threshold (0.6) and margin (0.02) were picked with `calibrate` on one half and scored on the other (`calibrate` picked 0.6 and 0.625 on the two halves with a wrong link costed as 3 misses, 0.575-0.65 for costs 2-5; its margin pick was noisy, 0.02 and 0.12), but the shipped values were then chosen having seen both halves, and the table above was run with them on the same people, so the table is somewhat optimistic. `VOICE_MEAN` itself is built from all 40 readers: it will be less well centred on other voices and microphones, which the per-channel adaptation is there to soften.
- The fast path used for sweeps and `Speakers` itself agree on 243 of 260 random histories; the rest are borderline scores (the order in which near-duplicate voices are folded when averaging differs).

## Knowing how many people are on the call, and a faster Stop (2026-11-24)

All numbers: `node eval/run.js --configs diarize+refine`, the same two recordings as above (so the same optimism applies). WDER, lower is better; the defaults are AMI 18.1 and libri-call 24.9.

### Head count from the calendar (`src/speakers/hint.js`, setting `speakerCountHint`, off by default)

The attendee list of the calendar event, minus the user, is the number of voices expected on the system channel (small meetings only: 2 to 6 attendees). `--attendees N` gives the eval note N attendees; `--speakers N` forces a count directly.

| Count given for the system channel | AMI (true 4) | libri-call (true 3) |
|---|---|---|
| none (today's default) | 18.1 | 24.9 |
| exactly right | **14.8** | **17.9** |
| one too few | 20.9 | 24.9 |
| one too many | 24.2 | 27.7 |

- A right count is worth 3 to 7 points, a wrong one costs 0 to 6, and calendar lists overcount (no-shows, people who only listen), so the hint is off by default. The number the user types themselves (see the note's "others on the call") is the reliable version of the same thing.
- The count must also tell the acoustic pass (`speakerRefine`) to keep its hands off the number of speakers: with the right count and the pass free to split and merge, libri-call went from 18.0 to 36.5 and AMI from 14.9 to 17.4. The manager passes `settled` to `refineNote` for every channel that had a count.
- A forced count that produces a voice with under 5% of the speech (or under 8 s) folds it into its nearest neighbour (`foldStarved` in `final.js`), because invited people do not always come.

### Stop-time

- The acoustic description of each utterance (pitch, timbre, about 25 ms) is now made in the gaps while recording (`describeSoon` in the recording manager) and reused by `refineNote`. Results are identical (AMI 18.1, libri-call 24.9); the speaker pass after Stop went from 64.7 s to 51.3 s on the 14 minute AMI meeting.
- The diarization model itself (49 s on AMI, 21 s on libri-call at 8 threads) is the rest. More threads do not help (4: 78 s, 8: 57 s, 16: 63 s, 24: 103 s).
- A larger segmentation hop (`--window-shift`) is faster but not safe: 0.3 took AMI to 19.4 and libri-call to 26.9 (speaker pass 16 s and 11 s), 0.2 took them to 28.6 and 35.8. Kept at 0.1.

### Diarization in pieces (`eval/pieces.js`, `eval/offline.js --strategy pieces`): tried, not shipped

Diarize each finished 4 minute piece while recording, merge the pieces' voice prints at Stop. That leaves 4 to 6 s of work for Stop, but accuracy depends on one threshold that only works in a narrow range: merge at cosine 0.4 gave AMI 20.2 and libri-call 25.4 (offline, diarize only; sherpa over the whole meeting: 26.3 and 25.0), at 0.5 AMI split into 12 speakers (WDER 57.0), and even a forced correct count gave AMI 47.3. Voice prints pooled per piece are too weak to merge reliably on a far-field mix.

### Regrouping turns, VBx-style (`eval/regroup.js`, `eval/offline.js --strategy regroup`): tried, not shipped

Embed every speaker turn of sherpa's output and regroup the prints: average-link, spectral clustering with an eigengap, and a variational Bayes mixture with pruning in the style of VBx, without the trained PLDA (scales estimated from an over-clustering of the same meeting). Starting from the default grouping all of them were worse than sherpa's own clustering (WDER 33 to 51 against 26.3 and 25.0); starting from an over-split at 0.4 they were 34 to 56. Feeding sherpa's own labels through the same code reproduces its score, so the harness is not the cause. Real VBx would need window-level prints cut with the segmentation model's masks (sherpa does not expose them, it would take onnxruntime in the app) and a PLDA trained for this voice model.

`eval/offline.js` caches the recognized words and the diarization output under `.eval/cache`, so a new grouping idea is scored in seconds instead of a 5 minute run.


## Naming accuracy (`naming.js`)

Whether the *names* the meeting window gives to the voices are right, apart from whether the voices are right. No audio and no
models: the voices are the reference's own speakers (perfect diarization), and the window is simulated from the reference
turns, every event a little early or late (about +-150 ms, random). `node eval/naming.js [--only ami-IS1009a] [--seeds 20] [--json]`.

- **Accuracy**: the share of speech time whose final name is the right person's (unnamed speech counts as not right).
- **Precision**: of the speech that was named at all, the share named rightly. A wrong name is worse than none.

| Scenario | What the window does |
|---|---|
| `lagged350/940/1630` | the highlight follows the speaker, late by 0.35 / 0.94 / 1.63 s (0.5 s is assumed) |
| `noisy` | one highlight in five names somebody else; people light up now and then with nobody speaking |
| `dominant` | only the loudest voice is shown: interjections (< 1.2 s) and the quieter side of an overlap never are |
| `hard` | all of it together, 0.94 s late |

Mean over 20 seeds (2026-11-24), the aligner before and after the change in 3.2 (the delay of each source found from the data,
sqrt(precision x recall) scores, one name to one voice by the Hungarian method with an "unknown" column):

| Recording | Scenario | Accuracy before | Accuracy after | Precision before -> after |
|---|---|---|---|---|
| ami-IS1009a | lagged350 | 100.0 | 100.0 | 100 -> 100 |
| ami-IS1009a | lagged940 | 98.5 | **100.0** | 100 -> 100 |
| ami-IS1009a | lagged1630 | 89.8 | **100.0** | 100 -> 100 |
| ami-IS1009a | noisy | 63.8 | **95.4** | 95.0 -> **100** |
| ami-IS1009a | dominant | 97.5 | **100.0** | 100 -> 100 |
| ami-IS1009a | hard | 88.4 | **94.5** | 100 -> 100 |
| libri-call | noisy | 97.8 | **100.0** | 100 -> 100 |
| libri-call | the other five | 100.0 | 100.0 | 100 -> 100 |
| **mean** | | **94.6** | **99.2** | **99.6 -> 100** |

These are simulations of how a meeting window behaves, with perfect voices and one source: they show that the aligner copes with late,
jittery, noisy and partial highlights, not what a given platform does. Captions, a roster, the calendar and several sources
at once are not simulated here. Measuring the real delays and gaps per platform is the latency harness (4.2).


## Latency per platform (`latency.js`)

How late does each source show who is speaking? WhisperBrain keeps the evidence about every recorded meeting (highlights, captions,
roster), so the delays can be measured on real calls after the fact:

```bash
node eval/latency.js --db ~/.config/WhisperBrain/whisperbrain.sqlite
```

Per platform and source it reports the delay the aligner estimates (`est.lag`), how long after a person started speaking their name
lit up (`onset`, p50/p90 over every turn that has one) and how long after that their caption showed the words (`caption`). The time
naming takes when a recording stops is `tookMs` in the `recording.meet-names` event.

The harness is tested on a made-up database with known delays (`test/eval-latency.test.js`). The real numbers need real calls and
have not been measured yet; fill this table from a few recordings per platform:

| Platform | Source | Meetings | est. lag (ms) | onset p50 / p90 (ms) | caption p50 / p90 (ms) |
|---|---|---|---|---|---|
| Google Meet | extension | | | | |
| Google Meet | accessibility reader | | | | |
| Zoom | accessibility reader | | | | |
| Teams | accessibility reader | | | | |

## The live view and names from the conversation (2026-11-24, from the Cicada comparison; see `docs/plans.md`)

`node eval/run.js --configs online,diarize+refine` after the changes below, same two recordings. Nothing moved:

| Recording | Config | WDER | cpWER | tcpWER | Speakers found / true |
|---|---|---|---|---|---|
| ami-IS1009a | online | 34.1 | 74.6 | 77.3 | 1 / 4 |
| ami-IS1009a | diarize+refine | 18.1 | 47.6 | 54.4 | 4 / 4 |
| libri-call | online | 48.2 | 92.9 | 95.8 | 2 / 4 |
| libri-call | diarize+refine | 24.9 | 57.1 | 61.3 | 3 / 4 |

- **Only a line of 2 s or more can start a speaker while recording** (`NEW_SPEAKER_MIN_SEC`, `SpeakerTracker.assign`). A shorter line that matches nobody stays unlabelled, keeps its voice print, and is placed after Stop (`Speakers.placeUnlabelled`, or the diarization/refine passes). These recordings are cut into long utterances, so the harness cannot show the effect: it exists to keep a cough or a "yeah" from making a "Speaker 5" in the live view. The scores above only say it did no harm.
- **Not measured:** the live view itself (how often a speaker is shown that is later folded away), the display rule (`src/speakers/display.js`: five substantive lines, two voices), and names from the conversation (`src/speakers/transcript-names.js`). Both AMI and libri-call have almost nobody saying names, so naming needs a small set of written dialogues (introductions, "Thanks, George", a name in an advert, a name of somebody absent) scored for precision first: a wrong name costs more than none. That set, as a `transcript` source in `eval/naming.js`, is still to do.

## Meeting assistant (2026-11-25)

`node eval/assistant-replay.js` replays the timed dialogs in `test/fixtures/assistant/` (en/pt-PT, a team meeting in the bullet-points style and a client project review in the spoken-reply style: 18 questions, fillers, backchannels, cut-off sentences, a repeat request, duplicates, the user's answer heard back on the call channel) through `src/assistant/turns.js` on a simulated clock. A line's final text arrives 700 ms after the speaker stops, as in the app (VAD 0.6 s + decoding).

| | precision | recall | F1 | median speech end → suggestion shown |
|---|---|---|---|---|
| question detection | 1.00 | 1.00 | 1.00 | 1220 ms (engine only) |

The rules were tuned on these dialogs, which found two real bugs: a short lead-in ("So, to start, tell me…") hid a prompt, and the other side's old lines were glued onto their next question after the user had answered. So this is a regression check, not a measure of accuracy on real calls. `test/eval-assistant.test.js` keeps F1 ≥ 0.85.

With a real model (`WB_EVAL_LLM=1 WB_EVAL_LLM_URL=http://127.0.0.1:11434/v1 WB_EVAL_LLM_MODEL=llama3.1:8b`, Ollama on an RTX 3070 Ti, 12 questions):
- first words of a suggestion: median **93 ms** after it is asked for (76–168 ms);
- the whole suggestion: 0.9–2.1 s (29–69 words);
- the first request after loading took 8.9 s (the model loading).

So with a local GPU model, the first words appear about 1.3 s after the other person stops talking. A CPU-only model will be several times slower; the speculative start (a suggestion is prepared during the pause, before it is shown) hides part of that.
