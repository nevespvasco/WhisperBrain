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


## The owned diarization pipeline (2026-11-26, from the voice-intelligence report; `src/speakers/owned/`)

sherpa-onnx's `OfflineSpeakerDiarization` is a black box that recomputes everything at Stop. The owned pipeline is the pyannote 3.1 recipe reimplemented in the app: 10 s windows every 1 s, pyannote segmentation-3.0 run by `onnxruntime-node` (`segmentation.js`), one voice print per active local speaker from the frames where it speaks alone (the same WeSpeaker model through sherpa), global clustering (`ahc.js`, or VBx with an LDA+PLDA, `vbx.js`), and the frame-level activity rebuilt from the overlapping windows (`pipeline.js`), giving overlap-aware turns, exclusive turns and the overlap regions. `worker.js` can follow a channel's spool while the meeting runs (`LiveDiarizer`), so Stop only clusters. Setting `speakerPipeline: 'owned'` ("Analyse speakers while recording" in Settings → Audio); the default stays `sherpa`.

New measures in `metrics.js` / `run.js` / `offline.js`: DER (no collar, overlap scored) and JER from time-based turns, overlap precision/recall, WER inside vs outside reference overlap, per-stage times, CPU and peak memory. In `run.js` DER/JER are computed from word-derived turns (so they are not comparable with `offline.js`, which uses the diarization's own turns). Seven AMI meetings are prepared (`node eval/prepare.js --ami ...`; the mirror returns 503 often, retry) and `node eval/prepare.js --local <folder>` makes your own recording (e.g. pt-PT) a test set from a `ref.tsv`.

**Protocol.** Tuning meetings: ami-IS1008a, ami-ES2011a, ami-TS3004a. Held-out: ami-IS1009a, ami-ES2004a, ami-TS3003a, ami-EN2002a. libri-call is reported but its readers are in the PLDA's training set (dev-clean), so it says nothing about VBx. Parameters were chosen on the tuning meetings only. All figures: WDER %, then number of speakers found (true: 4; libri-call 4).

**Cached comparison, no acoustic refine on either side** (`node eval/offline.js --strategy full|owned [--plda 1 ...]`, window states cached per model):

| | EN2002a | ES2004a | ES2011a | IS1008a | IS1009a | TS3003a | TS3004a | libri-call | mean of 8 |
|---|---|---|---|---|---|---|---|---|---|
| sherpa (threshold 0.6, today's default) | 61.3 / 57 | 35.4 / 20 | 51.2 / 23 | 33.3 / 3 | 26.3 / 6 | 42.7 / 28 | 47.1 / 40 | 25.0 / 3 | 40.3 |
| owned, AHC 0.7046 (pyannote 3.1's value) | 14.2 / 4 | 5.1 / 4 | 15.7 / 4 | 46.6 / 1 | 29.9 / 2 | 14.6 / 5 | 18.8 / 3 | 25.4 / 3 | 21.3 |
| owned, AHC 0.65 (shipped fallback) | 15.3 / 6 | 5.1 / 4 | 16.1 / 4 | 29.1 / 2 | 31.8 / 4 | 14.5 / 4 | 10.7 / 4 | 25.4 / 3 | 18.5 |
| **owned, VBx + PLDA** (vbx threshold 0.4, Fa 0.07, Fb 0.8; shipped) | 14.2 / 4 | 5.3 / 4 | 13.5 / 3 | 9.6 / 4 | 17.9 / 3 | 15.5 / 1 | 18.8 / 3 | 25.4 / 3 | **15.0** |

On the three tuning meetings the means are 27.0 (AHC 0.7046), 18.6 (AHC 0.65) and 14.0 (VBx); on the four held-out ones 15.9, 16.7 and 13.2. Using the exclusive turns for word assignment moved WDER by at most 1.1 points either way (EN2002a 14.2 → 13.1, TS3004a 18.8 → 19.1): no reason to prefer it on this data, it stays on because it cannot overlap-split a word. VBx is sensitive to its parameters: other settings of the 12 tried collapsed to one speaker or split into 20+; the shipped ones were the best on the tuning meetings.

**Warning about WDER.** TS3003a is a meeting where one person says most of the words: VBx merged the three minor speakers into one (1 speaker found) yet WDER is 15.5, because the words of the dominant speaker are right. Read it together with the speaker count and JER (84.3 there).

**PLDA.** `eval/plda-train.js` trains the LDA (128 d) + PLDA for the shipped voice model on 5,793 crops (2-8 s) of 146 LibriSpeech readers (dev/test clean/other; clean 60 %, simulated call 25 %, simulated phone 15 %) and writes `src/speakers/owned/plda/<model>.json` (451 KB). It is specific to the model: without a file for the voice model in use the pipeline falls back to AHC. pyannote community-1's own PLDA is behind a gated download and was not used.

**End to end** (`node eval/run.js --configs diarize+refine,owned,owned+refine`, the real recording pipeline; held-out meetings and libri-call; the audio is pushed much faster than real time, so the live worker's catch-up time is reported separately and is not Stop time). WDER / cpWER, speakers found (true 4), seconds from Stop to the finished transcript:

| Recording | sherpa + refine (today) | owned + refine | **owned** (shipped: the acoustic refine is skipped for it) |
|---|---|---|---|
| ami-EN2002a (36 min) | 59.7 / 110.0, 55, 733 s | 30.6 / 67.0, 4, 17 s | **14.4 / 55.8**, 4, 42 s |
| ami-ES2004a (17.5 min) | 29.3 / 72.5, 18, 314 s | 11.0 / 47.7, 4, 6.8 s | **9.5 / 45.2**, 4, 6.6 s |
| ami-TS3003a (25 min) | 32.6 / 72.0, 25, 437 s | 15.5 / 53.9, 1, 3.0 s | **15.5 / 53.9**, 1, 2.8 s |
| ami-IS1009a (14 min) | **18.1 / 47.6**, 4, 268 s | 31.4 / 65.3, 2, 4.5 s | 17.3 / 48.8, 3, 3.9 s |
| libri-call (5.6 min) | **24.9 / 57.1**, 3, 150 s | 25.4 / 58.6, 3, 4.0 s | 25.4 / 58.6, 3, 7.0 s |
| **mean** | 32.9 / 71.8, ~380 s | 22.8 / 58.5, ~7 s | **16.4 / 52.5**, ~12 s |

(Sherpa's ES2004a/TS3003a/EN2002a figures are far from IS1009a's 18.1 because its clustering threshold was tuned on IS1009a.) The acoustic refine was made to repair sherpa's over-splitting; on the owned pipeline it merged real people (IS1009a 17.3 -> 31.4, EN2002a 14.4 -> 30.6), so `RecordingManager.stop` skips it for channels the owned pipeline diarized. The Stop pass drops from 2.5-12 minutes to well under a minute (the 42 s on EN2002a was measured while two other jobs shared the machine; the pipeline's own part was 16 s); the work moves into the meeting, in a niced single-thread worker that ran at roughly 0.3x real time on a busy machine (the 36 minute meeting needed about 680 s of catch-up), so it keeps up. Times are wall-clock on a shared 32-core machine: upper bounds. The DER/JER of `run.js` come from word-derived turns and are not comparable with the table above.

**What this does and does not show.** Five recordings, one of which (IS1009a) the old pipeline was tuned on and one (libri-call) the PLDA saw the readers of. The owned pipeline is clearly better on the three long meetings where sherpa over-splits (and ties on IS1009a and libri-call), but it can under-split: it found 3 of 4 people on IS1009a and TS3003a collapsed to one (WDER hides it, cpWER 53.9 and JER 84.3 do not). Not yet measured: the live overlap events against the reference (overlap P/R from `offline.js`: EN2002a 86/70, ES2004a 78/50, TS3003a 47/46), CPU load on a 4-core machine, real calls, pt-PT. It is therefore opt-in; making it the default needs the held-out set above to be extended (more AMI meetings via `--ami`, a pt-PT meeting via `--local`).


## Voice model bake-off and calibrated "ask" band (2026-11-26; details and method in `eval/bakeoff-results.md`)

Same 40 LibriSpeech readers and simulated call/phone channels as the saved-voices harness (`node eval/voices.js ... --model <file>`; each model has its own cache and its own average voice), 300 histories, seed 7; the diarization column is `offline.js` with the same model on the six cached recordings. Correct / wrong person / strangers linked, % (shipped settings 0.6 / 0.02):

| Model | Saved voices | WDER, owned pipeline (AHC) | ms per 10 s, 1 thread | Licence |
|---|---|---|---|---|
| WeSpeaker ResNet34-LM (shipped) | 78.5 / 0.6 / 4.2 | 20.3 | 347 | CC-BY-4.0 weights |
| **3D-Speaker CAM++ (en voxceleb)** | **92.1 / 0.0 / 0.0** | **9.2** | **114** | **Apache-2.0** |
| NeMo TitaNet-L | 85.1 / 0.0 / 0.0 | 9.3 | 431 | CC-BY-4.0 (HF) |
| WeSpeaker ResNet293-LM | 84.2 / 1.9 / 17.8 | not run | 2787 | CC-BY-4.0 weights |

CAM++ is better in every scenario, three times faster and cleanly licensed, and **it is now the app's voice model** (see "CAM++ as the voice model" below). One chapter of one reader (1988/148538) is probably mislabelled and puts a floor under every EER; the saved-voice results exclude nothing. ResNet293 is worse than ResNet34 here, probably an export or front-end mismatch.

Calibration (logistic on the centred score, fitted on half the people, scored on the other half): for ResNet34-LM, P(same person) never reaches 0.95 on call/phone audio, so a "match if P >= 0.95, ask if >= 0.6" rule would ask about 14-43 % of decisions; for CAM++ it asks 2-3.5 % and 95-100 % of the questions are right, with 0 wrong links. The app's "ask" band (`MATCH.ask` = 0.45, speakers between 0.45 and 0.6 are suggested as "Ana?" and the user answers yes or no) is a first, uncalibrated value for the shipped model; the calibrated thresholds for both models are at the end of `bakeoff-results.md`.


## CAM++ as the voice model (2026-11-26)

**What changed.** The default voice model is 3D-Speaker CAM++ (Apache-2.0, 512 dimensions, 30 MB, `models.js`); `src/speakers/voice-models.js` holds, per model, its average voice (`VOICE_MEAN` for CAM++ from `node eval/voices.js mean --model`) and its match settings (CAM++: link at a centred score of 0.63 with no margin, suggest "Ana?" from 0.44 to 0.63; ResNet34: the old 0.6 / 0.02 / 0.45). Migration v16 tags every stored voice print (`voices`, `voice_exemplars`, `note_speakers`) with the model that made it (everything before is `wespeaker-resnet34-lm`). Prints of different models are never compared (`cosine` of different sizes is -1), never folded into one profile or mean, and each model has its own channel averages.

**Saved voices keep working.** Raw audio is deleted after Stop, so a voice saved with ResNet34 cannot be remade with CAM++. While such voices exist and the ResNet34 file is installed, the after-recording pass also makes every speaker's print with ResNet34 (`alt_centroid`); `autoMatch` judges a voice on the current model's prints when it has any, otherwise on that second print. Remembering the voice again (naming the speaker, "Yes, it is Ana") adds prints of both models, after which the new model alone recognises her. Not covered: meetings with no after-recording diarization (no pooled print, so no second print), and the live labels while recording (live matching uses the current model only). An existing install keeps ResNet34 until CAM++ is downloaded (Settings → Audio shows a banner; new installs get CAM++ directly); the app switches by itself when the download completes. Tests: `test/voice-models.test.js`.

**Results with CAM++ in the owned pipeline.** Cached comparison (`offline.js --strategy owned --embedding <CAM++>`), WDER, mean of the 8 recordings: AHC 0.55 10.3, **AHC 0.65 9.6** (on the three tuning meetings 8.4; 0.55: 9.3; 0.75: 11.3), AHC 0.75 11.8, and VBx with a PLDA trained for CAM++ (`eval/plda-train.js --model`, 5,793 crops) 11.3 at best, with 5-10 speakers where 4 are true. So CAM++ uses plain AHC at 0.65 and no PLDA (the unused PLDA file is not shipped; ResNet34 keeps its own). With AHC 0.65, 6 of 8 recordings find the 4 true speakers (the other two find 3).

End to end (`node eval/run.js --embedding <CAM++> --configs owned`), WDER / cpWER, speakers found (true 4), seconds of speaker work after Stop:

| Recording | sherpa + refine + ResNet34 (before) | owned + ResNet34 | **owned + CAM++** |
|---|---|---|---|
| ami-EN2002a | 59.7 / 110.0, 55 | 14.4 / 55.8, 4 | **11.3 / 53.9**, 4, 3.4 s |
| ami-ES2004a | 29.3 / 72.5, 18 | 9.5 / 45.2, 4 | **8.9 / 44.8**, 4, 2.0 s |
| ami-TS3003a | 32.6 / 72.0, 25 | 15.5 / 53.9, 1 | **10.1 / 47.5**, 3, 1.6 s |
| ami-IS1009a | 18.1 / 47.6, 4 | 17.3 / 48.8, 3 | **8.4 / 40.7**, 4, 1.7 s |
| libri-call | 24.9 / 57.1, 3 | 25.4 / 58.6, 3 | **17.1 / 42.3**, 4, 1.9 s |
| **mean** | 32.9 / 71.8 | 16.4 / 52.5 | **11.2 / 45.8** |

(The "after Stop" time of `run.js` for the owned pipeline includes transcription still to finish, because the audio is fed far faster than real time; the speaker pass itself is the figure above.) The owned pipeline with CAM++ is better than today's pipeline on all five recordings, but it is still **opt-in** (`speakerPipeline`): the sample is five recordings plus the cached comparison on eight, all English (AMI, LibriSpeech); no real calls, no pt-PT, nothing on a 4-core machine. The step to take before making it the default is a pt-PT meeting through `node eval/prepare.js --local`.

### Checks added later the same day (owned pipeline + CAM++)

- **Live overlap events** (`test/owned-live.test.js`, real models): two voices mixed at once are reported as `recording.overlap` while recording, before Stop. In the browser (Settings → Audio switch, recording bar chip, "Ana?" yes/no chips, "voice not remembered" toast, "better voice model" banner) the behaviour was checked by hand against a seeded scratch server; the chip disappears after 4 s.
- **Second print by the old model** (same file): with CAM++ active and a voice saved by ResNet34, every speaker gets a CAM++ print and a ResNet34 print, with both the owned and the sherpa pipeline.
- **File import** (`test/server.test.js`): a two-voice WAV imported with `speakerPipeline: owned` has two speakers, the first recognised when it returns, prints and their quality stored, and no voice print in the API response (a second print, `altCentroid`, did leak into it before this check and is now stripped).
- **Model download** (`test/voice-models.test.js`, local HTTP server): the CAM++ file is checked against its SHA-256 and installed, a wrong checksum leaves nothing behind, and the old ResNet34 file is untouched. The real GitHub URL was not downloaded from the app in this check (the file's checksum is that of the copy used in the bake-off).
- **Packaged build** (`electron-builder --dir --linux`): `onnxruntime-node` is now unpacked from the asar (its binding loads `libonnxruntime` beside it) and only the target system's binaries are packaged. Linux unpacked: 20 MB asar + 105 MB native modules (71 MB of them onnxruntime, x64 and arm64). The segmentation model was run from inside the packaged app (Electron 45). macOS and Windows packaging are not checked here.
- **Small machines** (`taskset`, `eval/run.js --embedding <CAM++> --configs owned --only ami-IS1009a`, 14 min of audio fed as fast as possible): 4 cores 117 s, 2 cores 155 s for transcription and speaker analysis together (7x and 5x faster than real time), same result as on 32 cores (WDER 8.4, 4/4 speakers), 1.7 s of speaker work after Stop.
- **A forced number of speakers** ("Others on the call", `--speakers N`): the right count gives the same result as the free one (libri-call 17.1, IS1009a 8.4), one too few costs a lot (ES2004a with 3 instead of 4: 8.9 -> 35.9 WDER), which is why the calendar hint stays off by default.

## Overlapped speech: separation second pass (research, 2026-11-24): no-go for now

Question: when two or three people talk at once on one mixed channel (Discord, Zoom, Meet), can a pass after Stop get back the words the mix ASR never wrote? Pipeline tried (all offline, scripts in `eval/`):

1. **Find overlap.** Use the regions where two or more of sherpa's diarization turns overlap (pyannote segmentation-3.0's powerset output already marks overlap, and `OfflineSpeakerDiarization` returns overlapping turns, so no extra model is needed). On AMI these regions have a time precision of 0.72 and a recall of 0.63 against the reference overlap.
2. **Separate** each region, padded by 0.5 s, into 2 streams. sherpa-onnx 2.0.3 only has *music* separation (Spleeter, UVR), so this used Python: SpeechBrain `sepformer-whamr16k` and ClearVoice `MossFormer2_SS_16K`.
3. **Transcribe** both streams with Parakeet TDT 0.6B v3 (`eval/sep-asr.js`).
4. **Merge.** The stream sharing more words with the mix ASR is the dominant voice and is dropped. From the other stream, only words that do not match a mix word within 0.6 s are added. Speakers for added words were tried three ways: the other voice the diarization heard in the region, a voice per word from the turns, or the nearest voice print of the final speakers (`eval/overlap.js`, `eval/final-voices.js`).

Baseline = `diarize+refine` (the shipped default) on `ami-IS1009a`. **Overlap recall** = share of the 497 reference words (of 2026) inside reference overlap that some hypothesis word matches (same word within 1 s, any speaker). It is 32.6 % today, against 76.5 % outside overlap, so a quarter of the meeting's words fall where the recognizer gets only a third of them.

| Variant | WER | WDER | cpWER | tcpWER | Overlap recall | Words added (correct) |
|---|---|---|---|---|---|---|
| baseline (diarize+refine) | 35.6 | 18.1 | 47.6 | 54.4 | 32.6 | – |
| SepFormer WHAMR 16k, detected overlap | 35.0 | 27.5¹ | 61.1¹ | 69.0¹ | 36.0 | 42 (60 %) |
| **MossFormer2, detected overlap** | **33.9** | 19.0 | **46.7** | **53.3** | **39.2** | 53 (83 %) |
| MossFormer2, detected, ±3 s context | 32.3 | 21.2 | 46.6 | 53.1 | 48.9 | 134 (73 %) |
| MossFormer2, *oracle* overlap (reference) | 32.9 | 21.3 | 46.1 | 53.4 | 45.1 | 107 (75 %) |
| MossFormer2, detected, *oracle speaker* for added words | 33.9 | 18.2 | 46.3 | 52.6 | 39.2 | 53 |
| Opus 32 kbps copy: baseline | 32.5 | 12.4 | 43.2 | 44.9 | 35.8 | – |
| Opus 32 kbps copy: MossFormer2, detected | 31.3 | 14.4 | 42.6 | 44.7 | 42.7 | 57 (68 %) |

¹ The SepFormer row was scored on the older offline diarize-only baseline (WDER 26.3, cpWER 60.3, tcpWER 68.1), so read only its change: WER −0.6, cpWER +0.8.

How to read it:

- **Separation does recover words.** MossFormer2 adds about 50 words with 83 % precision and raises overlap recall from 33 % to 39 % (49 % with more context). WER drops 1.2 to 3.3 points.
- **But the gain is small where it matters.** cpWER and tcpWER improve by only about 1 point, because only about half of the added words land on the right speaker. Diarization inside overlap is the weak part, and voice prints from 1–3 s separated snippets are unreliable. Even a perfect speaker choice (the "oracle speaker" row) caps the gain at −1.3 cpWER. Even with perfect overlap regions, both streams together reach only 54 % overlap recall: short backchannels and the overlapped words themselves still come out wrong after separation.
- **Opus.** Re-encoding the mix at 32 kbps (voip) did not hurt the separator: the gain was about the same. Discord and Zoom encode each person separately before mixing, which is probably easier than this test. Note that the codec pass alone moved the baseline by 3 WER points (different VAD cuts and clustering, 3 speakers found instead of 4). **Single-recording differences of about 1 point are within noise.**
- **Stop-time cost is the blocker.** MossFormer2 (55.7 M params, PyTorch CPU) needed 432 s for the 141 s of detected overlap in this 14-minute meeting at 8 threads (RTF 3.1; 2.9 at 16 threads, with other jobs loading the machine at about 13). Re-transcribing the streams adds about 25 s. Today's whole after-Stop speaker pass takes 55–80 s, so this would add roughly 3–7 minutes per 14-minute meeting. On a GPU the separation takes 20 s, but the app is CPU-only. SepFormer took a third of MossFormer2's GPU time (its CPU time was not measured) but gave no gain.
- **Licences and shipping.** MossFormer2 code and weights are Apache-2.0, but its training recipe points to WSJ0-2mix (LDC). Most other checkpoints also touch WSJ0 or WHAM! noise (CC BY-NC). Clean-data options are `ConvTasNet_Libri2Mix_sepclean_16k` (LibriSpeech only; models trained on Libri2Mix score badly on real meetings) and pyannote `speech-separation-ami-1.0`, which is trained on AMI, gated, 1.28 GB, and has no ONNX export. Not measured: TIGER (0.8 M params, fast, but no ONNX export and WHAM!-noise training data) and pyannote PixIT (gated). Neither would change the main limit, which is speaker attribution. The model survey with sources is in the session notes, not in the repo.

**Recommendation: no-go for wiring this into the app now.** The best realistic setting gains about 1.7 WER and 0.9 cpWER on the one real recording. That is within run-to-run noise, at 3–7 extra minutes of CPU per meeting, with an extra 200+ MB model of unclear training-data provenance. Better ways to get overlapped speech back: per-speaker capture where the app allows it (the Discord per-user audio spike), a joint diarization-plus-separation model trained on meetings once one exists in ONNX at a reasonable size, and better diarization inside overlap first, since attribution, not recovery, is what caps cpWER. Revisit if a fast (RTF < 0.2 on CPU), cleanly licensed 16 kHz separator appears, or with more real overlapped recordings to show a gain beyond noise.

Reproduce: see the header of `eval/overlap.js`. `eval/run.js --dump DIR` writes each run's final words for it, and `eval/separate.py` needs a throwaway Python venv.

## CAM++ regression on real calls, and the fix (2026-11-26)

**Symptom.** After the app switched itself to CAM++ (download done), a 3-person Discord call came out as 18 voices; the day before, with ResNet34, a Discord call came out as 1.

**Causes.** (1) The same-voice threshold (`speakerThreshold` 0.6: live labels, consolidate, imports) was ResNet34's. Raw cosine on call audio (`.eval/voices`, clips >= 2 s): ResNet34 puts 51 % of different people at >= 0.6 (merges everyone), CAM++ puts 20 % of the same person under 0.6 (splits everyone). (2) The default after-Stop pipeline was still `sherpa`, which with CAM++ finds 13-23 voices for 4 (bakeoff table above). (3) The `whisperbrain-integrate` checkout's `node_modules` was a symlink to main's, which has no `onnxruntime-node`, so the owned pipeline could not start and failed silently ("not following a recording" at Stop).

**Fix.** Each voice model has its own same-voice threshold (`voice-models.js` `same`: ResNet34 0.6, CAM++ 0.5; `speakerThreshold` defaults to null = the model's), `speakerPipeline` defaults to `owned`, a live follower that cannot start warns at once and Stop runs the one-shot instead.

**Results (CAM++, `run.js`).** After Stop, owned: ES2004a 4/4 voices WDER 8.9, IS1009a 4/4 8.4, libri-call 4/4 17.1 (before, sherpa+refine: IS1009a 20/4 23.8, libri-call 7/4 24.2). Live labels (online), WDER / voices: 0.4 49.4/5, 28.4/4, 48.0/3; 0.45 34.3/6, 27.9/4, 48.0/3; **0.5 34.3/6, 28.1/5, 32.0/5**; 0.6 –, 29.3/9, 31.4/7. Not yet measured on real Discord audio (Opus, Krisp, short turns).

## Speaker tests on your own Discord calls (2026-11-26)

The eval recordings above are meetings and audiobooks; Discord sounds different (Opus, Krisp noise suppression, short turns, laughter). A **speaker test recording** gives a scored recording of a real call with no hand labelling:

1. Settings → Integrations → Discord (bot set up, your user ID filled in) → **Start a speaker test**, while you are in a voice channel with 2+ people (ask them first). Talk normally for 5-10 minutes, then Stop. The bot hears each person on their own and the computer's mixed sound is recorded too; only the bot's people are transcribed. Both are kept in `<data>/speaker-tests/<time>-<note>/` (`system.pcm`, `person-<id>.pcm`, `meta.json`, `src/recording/speaker-test.js`) until you delete the folder. On Linux `<data>` is `~/.config/WhisperBrain`.
2. `WB_MODELS_DIR=~/.config/WhisperBrain/models node eval/discord-test.js <folder> --name discord-1`: aligns the people's streams on the mixed sound (speech activity, best lag within ±3 s; it warns when the match is weak), leaves out your own voice (Discord does not play it back to you), transcribes each person's stream and writes `.eval/data/discord-1/` (system.wav + ref.json, every word with its real speaker).
3. `node eval/run.js --only discord-1 --configs online,owned`, and `--same 0.45` / `0.55` to tune the live labels' same-voice threshold.

Rehearsal: libri-call turned into a fake speaker test (each person's stream = the call cut to their words, the mixed sound 0.25 s late) gave lag 0.25 s found exactly (correlation 1.00, next best 0.40) and owned WDER 17.4 (libri-call itself: 17.1), so building the reference adds no error of its own.

## One voice for a 5-person Discord call (2026-11-28)

**Symptom.** A Discord server call (19 people in the channel, at least 5 speaking, no bot) came out as one participant. The live labels had told several voices apart (ids up to s12); the owned pipeline after Stop put all 78 lines on one voice.

**Cause.** `ahc.js` (pyannote's rule) hands every cluster smaller than `minClusterSize` to the nearest large one, and if none is large makes everything one cluster. When every voice comes through the same chain (Opus, noise suppression, one output stream) the prints of different people sit close together: the stored per-line prints of that call had a median cosine of 0.29, against 0.12 for distinct people in a simulated call. Centroid linkage then chains most windows into one cluster and the rest are small and folded into it. Simulated calls (LibriSpeech dev-other, Zipf talk shares, short turns, Opus 24 kbps; 6 people, and 11 with pink noise) with a shared component added to every window print to reach that similarity: 9 and 8 voices before, **1** voice after. The real audio was deleted at Stop, so the real call could not be re-run.

**Fix.** `fallbackSpeakers`: the number of live voices holding real speech (`final.js liveVoiceCount`: at least 15 s and 5 % of the channel's speech), capped by the call's list of people (`RecordingManager.liveVoices`). Only when the free clustering finds fewer than two voices, the dendrogram is cut again for that many (`ahc.js`, also after VBx in `pipeline.js`); if the result is still one voice, nothing is relabelled, the live labels stand and a warning says so (`diarizeChannel` → `collapsed`). Calls the clustering already splits are untouched, so the AMI/libri figures above do not move. On the simulated collapse (fallback 8): 6-person call 5/6 people found, purity 74 % (79 % without the shared component); 11-person call 7/11, purity 57 % (58 %).

**Discord RPC.** The same call's speaking highlights stopped after 23 s: a person who leaves or mutes without a `SPEAKING_STOP` stayed in the "speaking" set, so "exactly one other person speaks" was never true again. Roster updates now drop people who left or are muted (`rpc-source.js`, `muted` from the voice state in `rpc.js`). Not yet seen on a real call.
