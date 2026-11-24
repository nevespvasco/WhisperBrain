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
| `refine` | off | on | MFCC/F0 split, merge and reassign from `src/speakers/refine.js` |
| `diarize` | on | off | pyannote segmentation-3.0 + global clustering per channel, word-level assignment |
| `diarize+refine` | on | on | Both |

Results are in the PR / commit message that introduced the harness.
