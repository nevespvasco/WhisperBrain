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
- **Still wrong:** libri-call still merges two of its three remote voices, and overlapped words go to the dominant speaker. Next steps from the research report: VBx instead of AHC, speaker-count hints from the calendar, and caching segmentation/embeddings during recording.
