# Speaker-embedding bake-off and voice-match calibration (2026-11-26)

Two questions. (A) Should WhisperBrain keep WeSpeaker ResNet34-LM as its voice model, or switch? (B) How can the voice-match
score become a probability with three outcomes (match / ask the user / no match), and where should the cut-offs be?

Every figure below comes from a command run on 2026-11-26 in this worktree (`eval/voices.js`, `eval/offline.js`). Nothing
is copied from papers or model cards.

## Short answer

- **Switch to 3D-Speaker CAM++ (VoxCeleb, English).** It beats ResNet34-LM on every saved-voice scenario. Pooled over all 13
  scenarios at its own threshold, links are 94.9 % correct, 0.0 % go to the wrong person and 0.3 % of strangers are linked. ResNet34-LM at its
  shipped settings gives 78.5 / 0.6 / 4.2. CAM++ is also 3x faster (114 vs 347 ms per 10 s at 1 thread). Its file is about
  the same size (29.6 vs 26.5 MB) and its licence is Apache-2.0. In diarization (6 cached recordings) it lowers WDER from
  20.3 to 9.2 % (owned pipeline) and from 35.6 to 24.5 % (sherpa `full` at 0.6).
- TitaNet-Large is nearly as accurate (94.0 / 0.0 / 0.5 at its own threshold) but slower (431 ms) and 3.4x larger.
  ResNet293-LM did *worse* than ResNet34-LM here (EER 8.9 vs 4.7 % on the same mic) and is 8x slower. I suspect the
  ONNX/feature front-end does not match this conversion (see caveats), but as shipped it is not a candidate.
- **Band: hi = 0.95, lo = 0.6**, one logistic per channel type on the centred score. For CAM++ this auto-links 86.7-89.4 % of
  known speakers with no wrong-person link and no stranger linked (held out). It turns 2-3.5 % of decisions into questions,
  and 95-100 % of those questions are the right person. For ResNet34-LM the same band is safe (0.0 % wrong person, 0.0-0.1 %
  strangers on the same channel). The cost is that 14-43 % of decisions become questions. On a phone line, or on "system"
  audio generally, ResNet34 practically never reaches P ≥ 0.95, so every candidate link becomes a question.

## Models

| Model | File (`.models/…`) | Size (bytes) | sha256 | dims | ms per 10 s, 1 thread | ms per 10 s, 4 threads (during extraction) | Licence |
|---|---|---|---|---|---|---|---|
| WeSpeaker ResNet34-LM (shipped) | `speaker/wespeaker_en_voxceleb_resnet34_LM.onnx` | 26 530 550 | `e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012` | 256 | 347 | not re-measured (cache from 2026-11-24) | CC-BY-4.0 (weights), Apache-2.0 (code) |
| 3D-Speaker CAM++ VoxCeleb EN | `candidates/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx` | 29 596 979 | `98daf9bcf1c8abf3db374fec4c27a5eda7c58705bb3f180d057b085a72a88bb5` | 512 | **114** | 61 | Apache-2.0 |
| NeMo TitaNet-Large | `candidates/nemo_en_titanet_large.onnx` | 101 405 493 | `d51abcf31717ef28162f26acb9d44dd4127c3d44c9b8624f699f3425daca8e77` | 192 | 431 | 153 | CC-BY-4.0 (HF card); NGC says "NeMo toolkit licence" (Apache-2.0) |
| WeSpeaker ResNet293-LM | `candidates/wespeaker_en_voxceleb_resnet293_LM.onnx` | 114 336 527 | `f65dbc820e534eef64ae12d1e289e20244d60e60f7f00d7b092092b1c458be2e` | 256 | 2787 | 760 | CC-BY-4.0 (weights), Apache-2.0 (code) |

Speed: `node eval/voices.js speed --threads 1 --model a,b,c,d`, the median of 8 runs on one 10 s clip. The machine was shared
with other jobs at a load of about 6 on 32 cores, so the ratios are reliable but the absolute numbers are only approximate. The file sizes match the
GitHub release assets (`api.github.com/repos/k2-fsa/sherpa-onnx/releases/tags/speaker-recongition-models`, published
2023-12-08).

Licence sources (checked 2026-11-26):
- CAM++: the ModelScope API `https://modelscope.cn/api/v1/models/iic/speech_campplus_sv_en_voxceleb_16k` returns
  `License: Apache License 2.0`. The 3D-Speaker repo (`https://github.com/modelscope/3D-Speaker`) README says the project is
  "released under the Apache License 2.0".
- WeSpeaker: `https://github.com/wenet-e2e/wespeaker/blob/master/docs/pretrained.md` ("Model License") says the pretrained
  models follow the licence of their dataset, and for VoxCeleb that is CC BY 4.0. The HF card
  `https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM` lists cc-by-4.0. The code is Apache-2.0. Attribution is required.
- TitaNet-Large: `https://huggingface.co/nvidia/speakerverification_en_titanet_large` says "covered by the CC-BY-4.0
  license". `https://catalog.ngc.nvidia.com/orgs/nvidia/teams/nemo/models/titanet_large` instead points to the NeMo toolkit
  licence (`https://github.com/NVIDIA/NeMo/blob/main/LICENSE`, Apache-2.0). The two statements differ. Either way the
  terms are permissive, with attribution.
- The sherpa-onnx release page states no licence of its own ("each model has its own license").

## Method

Data, scenarios and scoring are those of `eval/voices.js` (see "Saved voices" in `eval/README.md`). The data are 40 LibriSpeech
dev-clean readers, and a chapter stands for a meeting. Per chapter there are 16 utterances (cut at 10 s) and 3 pooled 30 s prints. The mic audio is used as recorded. The video call
and phone line are simulated with ffmpeg (hiss, band limiting, echo, Opus 24 / 12 kbit/s). Each model has its own cache
(`.eval/voices/<model>/`) and its own average voice, built from the other half of the people. The shipped `VOICE_MEAN` is
not used.

Commands per model (`--model <file>`):
- `extract --threads 4`. CAM++ and TitaNet were extracted in one process (47 min). **ResNet293 was extracted with
  `--pools-only`** (50 min). A full extraction would have taken about 2 h at 4 threads, so it has no live (1 / 3 utterance)
  scenarios and no single-utterance EER.
- `run --trials 300 --seed 7 --json` at the shipped settings (centred score ≥ 0.6, margin 0.02) and with `--calibrated`, which uses the
  model's own threshold and margin, picked by `calibrate` on the other half of the people.
- `calibrate`, `eer` (inside `run`, and again with `--exclude 1988/148538`, see caveats), and `prob`.
- Diarization: `node eval/offline.js --strategy full|owned --threads 4 [--threshold 0.7] --embedding <file> --only
  ami-IS1009a,ami-ES2004a,ami-TS3003a,ami-IS1008a,ami-ES2011a,libri-call`. These use cached ASR only.

## (A) Saved-voice recognition

Cells are correct / wrong person / strangers linked, in %. Known-speaker counts per scenario are as in `eval/README.md` (1800 or
1200 known speakers, 1800 or 600 strangers). "n/a" means the scenario needs per-utterance prints, which the ResNet293 pools-only cache lacks.

**At the shipped settings (centred ≥ 0.6, margin 0.02).** These were tuned for ResNet34, and the other models' scores sit lower.

| Scenario | ResNet34-LM | CAM++ | TitaNet-L | ResNet293-LM |
|---|---|---|---|---|
| same mic, 1 meeting saved | 86.2 / 0.0 / 1.5 | 92.2 / 0.0 / 0.0 | 83.8 / 0.0 / 0.0 | 84.3 / 1.6 / 14.3 |
| same mic, 2 meetings saved | 90.6 / 0.1 / 1.6 | 96.0 / 0.0 / 0.0 | 91.6 / 0.0 / 0.0 | 91.9 / 0.5 / 15.4 |
| live (3 utterances), mic | 83.7 / 0.1 / 1.3 | 94.1 / 0.0 / 0.0 | 86.4 / 0.0 / 0.0 | n/a |
| live (1 utterance), mic | 61.2 / 0.1 / 0.7 | 84.1 / 0.0 / 0.0 | 76.9 / 0.0 / 0.0 | n/a |
| video call -> video call | 84.8 / 0.3 / 5.7 | 92.6 / 0.0 / 0.0 | 87.1 / 0.0 / 0.0 | 83.2 / 2.4 / 19.1 |
| poor phone line -> phone line | 78.7 / 5.0 / 25.1 | 90.7 / 0.0 / 0.0 | 86.6 / 0.0 / 0.0 | 75.3 / 5.3 / 26.4 |
| saved on mic, heard on call | 54.5 / 0.4 / 1.1 | 91.8 / 0.0 / 0.0 | 80.3 / 0.0 / 0.0 | 79.2 / 1.9 / 15.1 |
| saved on call, heard on mic | 55.6 / 0.5 / 0.9 | 92.7 / 0.0 / 0.0 | 81.2 / 0.0 / 0.0 | 80.2 / 2.1 / 15.5 |
| saved on mic+call, heard on call | 86.7 / 0.4 / 6.8 | 94.6 / 0.0 / 0.0 | 91.1 / 0.0 / 0.0 | 89.2 / 1.0 / 20.4 |
| saved on mic+call, heard on mic | 90.2 / 0.1 / 1.6 | 95.8 / 0.0 / 0.0 | 91.0 / 0.0 / 0.0 | 90.8 / 0.9 / 17.7 |
| many saved voices (12), same mic | 87.6 / 0.3 / 2.7 | 93.8 / 0.0 / 0.0 | 86.6 / 0.0 / 0.0 | 84.7 / 4.3 / 27.1 |
| first days: 2 voices, no history, mic | 80.7 / 0.0 / 0.0 | 90.8 / 0.0 / 0.0 | 82.3 / 0.0 / 0.0 | 85.8 / 0.0 / 0.8 |
| first days: 2 voices, no history, call | 82.8 / 0.0 / 0.2 | 86.3 / 0.0 / 0.0 | 78.8 / 0.0 / 0.0 | 81.8 / 0.1 / 1.8 |
| **all scenarios pooled** | 78.5 / 0.6 / 4.2 | 92.1 / 0.0 / 0.0 | 85.1 / 0.0 / 0.0 | 84.2 / 1.9 / 17.8 (11 scenarios) |

**At each model's own operating point (`run --calibrated`).** Each half of the people is scored with the threshold and margin
that `calibrate` picked on the other half (ResNet34: 0.6 / 0.12 and 0.625 / 0.02; CAM++: 0.4 / 0 both; TitaNet: 0.4 / 0
and 0.375 / 0; ResNet293: 0.75 / 0.05 and 0.7 / 0.08).

| Scenario | ResNet34-LM | CAM++ | TitaNet-L | ResNet293-LM |
|---|---|---|---|---|
| same mic, 1 meeting saved | 84.9 / 0.0 / 1.5 | 93.3 / 0.0 / 0.0 | 92.7 / 0.0 / 0.0 | 73.7 / 0.6 / 5.1 |
| same mic, 2 meetings saved | 90.3 / 0.1 / 1.6 | 96.7 / 0.0 / 0.1 | 96.4 / 0.0 / 0.0 | 81.7 / 0.2 / 4.5 |
| live (3 utterances), mic | 81.4 / 0.1 / 1.3 | 96.8 / 0.0 / 0.1 | 95.3 / 0.0 / 0.0 | n/a |
| live (1 utterance), mic | 58.0 / 0.1 / 0.7 | 95.5 / 0.0 / 0.2 | 94.0 / 0.0 / 0.1 | n/a |
| video call -> video call | 81.4 / 0.2 / 4.4 | 94.4 / 0.0 / 0.0 | 94.0 / 0.0 / 0.1 | 71.6 / 0.9 / 7.6 |
| poor phone line -> phone line | 70.3 / 3.8 / 20.7 | 92.8 / 0.0 / 1.6 | 92.3 / 0.1 / 4.0 | 59.4 / 2.9 / 14.4 |
| saved on mic, heard on call | 49.1 / 0.1 / 1.1 | 93.7 / 0.0 / 0.2 | 92.8 / 0.0 / 0.6 | 57.6 / 0.4 / 4.0 |
| saved on call, heard on mic | 49.0 / 0.4 / 0.9 | 94.4 / 0.0 / 0.2 | 93.8 / 0.0 / 0.3 | 57.7 / 0.2 / 4.7 |
| saved on mic+call, heard on call | 85.1 / 0.3 / 6.1 | 96.6 / 0.0 / 0.3 | 96.6 / 0.0 / 0.4 | 77.8 / 0.2 / 7.2 |
| saved on mic+call, heard on mic | 89.0 / 0.1 / 1.4 | 96.8 / 0.0 / 0.4 | 96.8 / 0.0 / 0.4 | 78.1 / 0.1 / 5.1 |
| many saved voices (12), same mic | 85.1 / 0.3 / 2.7 | 94.9 / 0.0 / 0.1 | 94.3 / 0.0 / 0.0 | 73.0 / 1.2 / 8.5 |
| first days: 2 voices, no history, mic | 79.5 / 0.0 / 0.0 | 93.7 / 0.0 / 0.0 | 90.8 / 0.0 / 0.0 | 73.0 / 0.0 / 0.3 |
| first days: 2 voices, no history, call | 81.8 / 0.0 / 0.2 | 93.8 / 0.0 / 0.0 | 90.8 / 0.0 / 0.0 | 68.4 / 0.0 / 0.7 |
| **all scenarios pooled** | 75.5 / 0.5 / 3.6 | **94.9 / 0.0 / 0.3** | 94.0 / 0.0 / 0.5 | 70.2 / 0.7 / 6.4 (11 scenarios) |

ResNet34's "own" point is slightly worse than its shipped one. The shipped settings were tuned on all 40 readers, test
people included, so they flatter it a little.

`calibrate` output (picked on one half, scored on the other; same-channel scenarios, then cross-channel):

| Model | picked on half 0 → scored on half 1 | picked on half 1 → scored on half 0 |
|---|---|---|
| ResNet34-LM | 0.625 / 0.02 / cross 0: 89.5/0.1/0.8, cross-ch 69.9/0.1/1.3 | 0.6 / 0.12 / cross 0: 79.0/0.1/3.9, cross-ch 66.3/0.3/3.8 |
| CAM++ | 0.4 / 0 / cross 0.05: 94.4/0.0/0.0, cross-ch 95.3/0.0/0.0 | 0.4 / 0 / cross 0.05: 96.6/0.0/0.0, cross-ch 96.3/0.0/0.0 |
| TitaNet-L | 0.375 / 0 / cross 0.05: 94.3/0.0/0.1, cross-ch 95.2/0.0/0.5 | 0.4 / 0 / cross 0.05: 95.1/0.0/0.0, cross-ch 94.7/0.0/0.1 |
| ResNet293-LM | 0.7 / 0.08 / cross 0.05: 82.6/0.7/8.2, cross-ch 71.8/0.1/5.1 | 0.75 / 0.05 / cross 0: 67.5/0.3/4.1, cross-ch 59.4/0.2/3.5 |

(`run --calibrated` passes only the threshold and margin to `Speakers.autoMatch`. The cross-channel discount picked here is
not applied there.)

**Equal error rates** (pooled 30 s prints from different chapters; centred on the other half's per-channel mean), in %:

| Pair type | ResNet34-LM | CAM++ | TitaNet-L | ResNet293-LM |
|---|---|---|---|---|
| same mic | 4.65 (3.04) | 2.32 (0.02) | 2.32 (0.14) | 8.91 (8.17) |
| video call | 7.75 (7.04) | 2.32 (0.79) | 2.32 (1.19) | 10.98 (9.52) |
| phone line | 13.31 (12.70) | 3.49 (1.19) | 3.49 (1.19) | 13.19 (12.30) |
| cross-channel mic vs call | 7.11 (6.30) | 2.33 (0.32) | 2.13 (0.66) | 10.34 (9.33) |
| cross-channel mic vs phone | 15.04 (14.90) | 2.46 (0.79) | 3.09 (1.79) | 16.80 (16.08) |
| same mic, raw cosine (not centred) | 6.59 (5.16) | 2.32 (0.16) | 2.32 (0.38) | 10.47 (8.74) |
| same mic, single utterances | 9.23 (7.96) | 2.83 (1.18) | 2.40 (1.19) | n/a |

In brackets: the same EER with chapter 1988/148538 excluded (`--exclude 1988/148538`). All four models score that chapter
as a different person from reader 1988's other two chapters. The 18 same-person pairs it creates put a floor of about 2.3 % under
every EER, and that floor is why CAM++ and TitaNet show identical 2.32 % figures. The trial tables above keep the chapter, so
the same handicap applies to every model.

## (A) Diarization impact (6 recordings with cached ASR)

Each figure is the mean over ami-ES2004a, ami-ES2011a, ami-IS1008a, ami-IS1009a, ami-TS3003a and libri-call. "Speakers
found" lists the six recordings in that order, and the reference has 4 speakers in each.

| Model | Strategy | WDER | cpWER | DER | JER | overlap P / R | speakers found | diarization s (6 rec.) |
|---|---|---|---|---|---|---|---|---|
| ResNet34-LM | full @0.6 | 35.6 | 74.9 | 47.6 | 54.8 | 61.9 / 63.2 | 20,23,3,6,28,3 | 800* |
| ResNet34-LM | full @0.7 | 23.5 | 61.0 | 36.2 | 52.6 | 63.5 / 63.3 | 13,11,2,3,14,3 | 487 |
| CAM++ | full @0.6 | 24.5 | 62.3 | 36.9 | 40.8 | 62.7 / 63.1 | 17,23,13,22,21,8 | 324 |
| CAM++ | full @0.7 | 17.3 | 52.2 | 29.7 | 35.1 | 64.4 / 62.7 | 9,12,8,12,14,5 | 308 |
| TitaNet-L | full @0.6 | 28.0 | 67.2 | 41.3 | 44.3 | 62.3 / 62.7 | 16,28,16,18,22,9 | 609 |
| TitaNet-L | full @0.7 | 19.3 | 55.8 | 32.1 | 36.7 | 63.0 / 62.9 | 8,15,10,13,16,7 | 619 |
| ResNet34-LM | owned | 20.3 | 54.2 | 30.1 | 49.7 | 58.8 / 64.9 | 4,4,2,4,4,3 | 354* |
| **CAM++** | **owned** | **9.2** | **40.4** | **20.1** | 34.6 | 58.2 / 63.5 | 4,3,4,4,3,4 | 263 |
| TitaNet-L | owned | 9.3 | 40.9 | 20.5 | 34.3 | 58.1 / 65.2 | 4,4,4,4,3,5 | 555 |

\* These rows were served from the `.eval/cache` entries of an earlier session, so their times were measured then, maybe at
another thread count. The other rows ran at `--threads 4` today.

- With sherpa's default threshold of 0.6, every model over-splits badly, ResNet34 included: up to 28 speakers for 4. I tried 0.7 because a higher
  threshold gives fewer clusters here. It helps every model but all still over-split. I did not try 0.5, which would split
  even more. The ranking is the same at both thresholds: CAM++ < TitaNet < ResNet34 on WDER and DER.
- With the owned pipeline (still under evaluation), CAM++ and TitaNet halve ResNet34's WDER (20.3 → 9.2 / 9.3) and cut DER by
  10 points. The gain comes almost entirely from speaker confusion, because miss and false alarm are set by segmentation and
  do not change. Owned + ResNet34 under-splits IS1008a (2 of 4 speakers), and owned + CAM++ finds 3 of 4 in ES2011a and TS3003a.
- **ResNet293 was not run through diarization.** At 760 ms per 10 s on 4 threads it would have taken about 2 h of 4-thread compute
  for the two strategies, and it had already lost the saved-voice tests to ResNet34. The command, if wanted:
  `node eval/offline.js --strategy owned --threads 4 --embedding .models/candidates/wespeaker_en_voxceleb_resnet293_LM.onnx --only …`.

## (B) Probability calibration: match / ask / no match

`node eval/voices.js prob --trials 300 --seed 7 [--model …]` uses the same random histories as `run`. Every meeting speaker is scored against every
saved voice (centred score, as `cluster.voiceScore` computes it, with the pitch veto). The label is 1 when the best saved voice is the
right person; a stranger is always 0. The fit is P = 1 / (1 + exp(-(b0 + b1·score))), by IRLS, on one half of the people. It is evaluated on the
other half, both directions are pooled, and ECE uses 10 equal-width bins. The coefficients to ship are fitted on both halves.
The rule runs one speaker per voice, highest score first. A link is a **match** if P ≥ hi, an **ask** if lo ≤ P < hi, and otherwise
**no match**. In the tables:
- correct, wrong person: % of known speakers.
- strangers linked: % of strangers auto-matched.
- asked: % of all decisions, known plus strangers.
- asked who were right: of the questions, the share where the suggested voice was the right person.
- right after asking: matched right plus asked right, as % of known speakers, if the user always answers correctly.

Channel types and their scenarios:
- same mic: same mic with 1 or 2 meetings saved, 12 voices, first days on the mic.
- video call: video call, first days on a call.
- phone line: poor phone line.
- system: video call + phone line. The app only knows "mic" vs "system", so this is the type it can select at runtime.
- cross-channel: saved on mic and heard on call, or the reverse.

A second model with the margin to the second-best voice as a feature was also fitted. It did not improve ECE consistently
(ResNet34 same mic 2.24 → 1.73 %, video call 4.75 → 4.04 %, but phone 3.69 → 4.74 %, system 3.29 → 3.72 %), so the
one-feature model is the one recommended. With one feature, a probability maps to a single score threshold.

### ResNet34-LM (shipped model)

| Type | coef [b0, b1] | held-out ECE | per-half fits |
|---|---|---|---|
| same mic | [-7.806, 14.364] | 2.24 % | [-7.97, 14.57] [-7.63, 14.23] |
| video call | [-7.268, 12.639] | 4.75 % | [-6.57, 11.52] [-8.08, 13.96] |
| phone line | [-9.061, 12.083] | 3.69 % | [-9.13, 12.49] [-9.37, 12.20] |
| system | [-6.435, 9.810] | 3.29 % | [-6.36, 9.89] [-6.58, 9.85] |
| cross-channel | [-7.264, 15.133] | 2.34 % | [-6.38, 12.97] [-8.60, 18.36] |
| live, 3 utterances (same-mic model) | same as same mic | 3.30 % | |

| Type | rule (score thresholds) | correct | wrong person | strangers linked | asked | asked who were right | right after asking |
|---|---|---|---|---|---|---|---|
| same mic | current (≥ 0.6, margin 0.02) | 86.7 | 0.1 | 1.7 | 0 | - | 86.7 |
| same mic | 0.95 / 0.6 (0.748 / 0.572) | 65.1 | 0.0 | 0.1 | 13.8 | 90.1 | 88.8 |
| same mic | 0.9 / 0.5 (0.696 / 0.543) | 74.9 | 0.0 | 0.3 | 9.8 | 81.4 | 90.2 |
| same mic | 0.97 / 0.7 (0.785 / 0.602) | 56.5 | 0.0 | 0.0 | 16.9 | 94.5 | 87.0 |
| video call | current | 84.1 | 0.2 | 4.3 | 0 | - | 84.1 |
| video call | 0.95 / 0.6 (0.808 / 0.607) | 37.6 | 0.0 | 0.1 | 27.4 | 93.3 | 83.7 |
| video call | 0.9 / 0.5 (0.749 / 0.575) | 60.8 | 0.0 | 0.3 | 16.6 | 84.0 | 85.8 |
| video call | 0.97 / 0.7 (0.850 / 0.642) | 18.2 | 0.0 | 0.0 | 35.8 | 96.9 | 80.6 |
| phone line | current | 79.3 | 4.7 | 25.2 | 0 | - | 79.3 |
| phone line | 0.95 / 0.6 (0.994 / 0.783) | 0.0 | 0.0 | 0.0 | 33.2 | 86.9 | 57.7 |
| phone line | 0.9 / 0.5 (0.932 / 0.750) | 3.9 | 0.0 | 0.0 | 37.3 | 83.3 | 66.1 |
| phone line | 0.97 / 0.7 (1.038 / 0.820) | 0.0 | 0.0 | 0.0 | 25.9 | 89.5 | 46.3 |
| system | current | 82.3 | 1.9 | 13.3 | 0 | - | 82.3 |
| system | 0.95 / 0.6 (0.956 / 0.697) | 0.1 | 0.0 | 0.0 | 42.9 | 90.5 | 72.8 |
| system | 0.9 / 0.5 (0.880 / 0.656) | 12.9 | 0.1 | 0.1 | 40.0 | 86.9 | 78.0 |
| system | 0.97 / 0.7 (1.010 / 0.742) | 0.0 | 0.0 | 0.0 | 36.8 | 92.5 | 63.9 |
| cross-channel | current | 54.9 | 0.4 | 1.0 | 0 | - | 54.9 |
| cross-channel | 0.95 / 0.6 (0.675 / 0.507) | 28.4 | 0.3 | 0.6 | 26.3 | 89.8 | 75.6 |
| cross-channel | 0.9 / 0.5 (0.625 / 0.480) | 44.9 | 0.5 | 1.3 | 20.4 | 85.0 | 79.6 |
| cross-channel | 0.97 / 0.7 (0.710 / 0.536) | 19.4 | 0.1 | 0.3 | 27.3 | 92.8 | 70.0 |
| live, 3 utt. | 0.95 / 0.6 (0.748 / 0.572) | 51.3 | 0.0 | 0.2 | 18.8 | 94.8 | 86.9 |
| live, 3 utt. | 0.9 / 0.5 | 65.3 | 0.0 | 0.2 | 13.4 | 89.9 | 89.4 |
| live, 3 utt. | 0.97 / 0.7 | 40.6 | 0.0 | 0.0 | 22.2 | 96.9 | 83.6 |

(The ResNet34 phone/system score thresholds are close to or above 1, the top of the centred scores, so P ≥ 0.95 is practically
never reached there.)

### CAM++ (recommended model)

| Type | coef [b0, b1] | held-out ECE | per-half fits |
|---|---|---|---|
| same mic | [-5.795, 13.250] | 1.30 % | [-8.07, 17.31] [-4.83, 11.29] |
| video call | [-4.635, 12.523] | 2.69 % | [-6.73, 17.32] [-3.73, 10.43] |
| phone line | [-6.363, 14.137] | 1.85 % | [-7.90, 17.63] [-5.47, 12.18] |
| system | [-5.375, 13.073] | 2.45 % | [-7.39, 17.60] [-4.42, 10.96] |
| cross-channel | [-6.359, 14.841] | 1.34 % | [-8.19, 18.25] [-5.46, 12.97] |
| live, 3 utterances (same-mic model) | same as same mic | 1.52 % | |

| Type | rule (score thresholds) | correct | wrong person | strangers linked | asked | asked who were right | right after asking |
|---|---|---|---|---|---|---|---|
| same mic | current (≥ 0.6, margin 0.02) | 93.4 | 0.0 | 0.0 | 0 | - | 93.4 |
| same mic | 0.95 / 0.6 (0.660 / 0.468) | 89.3 | 0.0 | 0.0 | 2.8 | 100.0 | 94.7 |
| same mic | 0.9 / 0.5 (0.603 / 0.437) | 93.1 | 0.0 | 0.0 | 0.8 | 100.0 | 94.7 |
| same mic | 0.97 / 0.7 (0.700 / 0.501) | 84.8 | 0.0 | 0.0 | 5.1 | 100.0 | 94.7 |
| video call | current | 90.0 | 0.0 | 0.0 | 0 | - | 90.0 |
| video call | 0.95 / 0.6 (0.605 / 0.403) | 88.8 | 0.0 | 0.0 | 3.0 | 100.0 | 94.2 |
| video call | 0.9 / 0.5 (0.546 / 0.370) | 91.8 | 0.0 | 0.0 | 1.5 | 94.9 | 94.3 |
| video call | 0.97 / 0.7 (0.648 / 0.438) | 83.9 | 0.0 | 0.0 | 5.6 | 100.0 | 93.9 |
| phone line | current | 90.7 | 0.0 | 0.0 | 0 | - | 90.7 |
| phone line | 0.95 / 0.6 (0.658 / 0.479) | 86.7 | 0.0 | 0.0 | 3.0 | 95.4 | 92.4 |
| phone line | 0.9 / 0.5 (0.605 / 0.450) | 90.2 | 0.0 | 0.0 | 1.4 | 84.0 | 92.6 |
| phone line | 0.97 / 0.7 (0.696 / 0.510) | 79.7 | 0.0 | 0.0 | 6.4 | 99.6 | 92.3 |
| system | current | 90.3 | 0.0 | 0.0 | 0 | - | 90.3 |
| system | 0.95 / 0.6 (0.636 / 0.442) | 87.2 | 0.0 | 0.0 | 3.5 | 96.8 | 93.4 |
| system | 0.9 / 0.5 (0.579 / 0.411) | 90.6 | 0.0 | 0.0 | 1.8 | 88.4 | 93.7 |
| system | 0.97 / 0.7 (0.677 / 0.476) | 81.1 | 0.0 | 0.0 | 6.4 | 99.1 | 93.0 |
| cross-channel | current | 92.2 | 0.0 | 0.0 | 0 | - | 92.2 |
| cross-channel | 0.95 / 0.6 (0.627 / 0.456) | 89.4 | 0.0 | 0.0 | 2.3 | 100.0 | 94.0 |
| cross-channel | 0.9 / 0.5 (0.576 / 0.428) | 92.7 | 0.0 | 0.0 | 0.7 | 98.0 | 94.1 |
| cross-channel | 0.97 / 0.7 (0.663 / 0.486) | 84.1 | 0.0 | 0.0 | 4.8 | 100.0 | 93.8 |
| live, 3 utt. | 0.95 / 0.6 (0.660 / 0.468) | 89.7 | 0.0 | 0.0 | 3.3 | 100.0 | 96.3 |
| live, 3 utt. | 0.9 / 0.5 | 93.1 | 0.0 | 0.0 | 1.7 | 100.0 | 96.5 |
| live, 3 utt. | 0.97 / 0.7 | 82.8 | 0.0 | 0.0 | 6.7 | 100.0 | 96.2 |

With hi 0.95 / lo 0.6, TitaNet gives 74.8-88.7 % correct with no errors and asks 2.9-8.4 %, of which 91-100 % are right
(`.eval/results/voices-prob-nemo_en_titanet_large.json`). ResNet293 asks 31-47 %, of which 83-91 % are right, and
auto-matches almost nothing (`…resnet293_LM.json`).

### Recommended band: hi = 0.95, lo = 0.6

- It is the only one of the three pairs that is safe for both models on every channel. Auto links went to the wrong person
  0.0 % of the time on the same channel (0.3 % cross-channel for ResNet34). Strangers were linked 0.0-0.1 % of the time
  (0.6 % cross-channel for ResNet34). And ≥ 86.9 % of questions were the right person (≥ 95.4 % for CAM++).
- 0.9 / 0.5 auto-links more, but for ResNet34 only 81-87 % of its questions are right, and it links 0.3 % of strangers on the
  same mic and 1.3 % cross-channel. For CAM++ it asks only ~1-2 %, but that leaves almost no room for error with only 40
  readers, and on the phone line just 84 % of its questions are right.
- 0.97 / 0.7 asks 1.2-1.3x as often as 0.95 / 0.6 (more on CAM++) for little gain: ResNet34 strangers go 0.1 → 0.0 % on the same mic.
- With CAM++ the band costs 3-4 points of automatic links. Those decisions become questions, and the user confirms them,
  so "right after asking" rises by 1.3-4.2 points over the current single threshold. With ResNet34 the band removes most
  wrong links on calls (video call strangers 4.3 → 0.1 %, phone wrong person 4.7 → 0 %, strangers 25.2 → 0 %), at the
  cost of asking about a third of the time on system audio.

Equivalent raw centred-score thresholds (match if score ≥ scoreHi, ask if scoreLo ≤ score < scoreHi):

| Type | CAM++ scoreHi / scoreLo | ResNet34-LM scoreHi / scoreLo |
|---|---|---|
| same mic (also live) | 0.660 / 0.468 | 0.748 / 0.572 |
| video call | 0.605 / 0.403 | 0.808 / 0.607 |
| phone line | 0.658 / 0.479 | 0.994 / 0.783 |
| system (call + phone; what the app can select) | 0.636 / 0.442 | 0.956 / 0.697 |
| cross-channel | 0.627 / 0.456 | 0.675 / 0.507 |

These thresholds only hold with the same scoring as in the evaluation: `cluster.voiceScore` with the shipped `MATCH.cross`
and `MATCH.prior`, the per-channel adapted average voice, the pitch veto, and an average voice built **for that model**.
Switching to CAM++ also needs a CAM++ `VOICE_MEAN`
(`node eval/voices.js mean --model .models/candidates/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx`). The margin rule is
not needed with the band (`calibrate` picks margin 0 for CAM++).

## Caveats

- **40 LibriSpeech readers** (31 with 2+ chapters), read speech, mostly clean, all English. The effective sample is the
  people, not the thousands of decisions per row. Differences of a point or two between rows are noise. With CAM++ the
  held-out errors are so rare (0.0 % in most cells) that the data cannot tell 0.1 % from 0.5 %. The per-half logistic fits
  of CAM++ also differ a lot (slope 17.3 vs 11.3 on the same mic), which is a symptom of near-separable data, and ECE stays at
  1.3-2.7 % anyway.
- **Calls and phone lines are simulated** with ffmpeg from the same mic audio. They are not real far-end audio: no real
  codec packet loss, AGC, echo cancellation or room changes.
- **Tuning and testing on the same people.** Threshold, margin and logistic coefficients are always picked on one half and
  scored on the other. But the scenario design, the shipped settings, the band candidates and this recommendation were all chosen
  looking at these same 40 readers.
- P is "the best saved voice is the right person", given the stranger rate of these histories: half of the meeting speakers
  are strangers, and 2 in "first days". With a different share of strangers the true probability shifts. Recalibrate on real use if possible.
- Probably mislabelled data: chapter 148538 of reader 1988 scores as a different person for all four models. It is kept in
  the trial tables, which caps every model at about 95 % "right after asking", and is excluded only in the bracketed EERs.
- ResNet293 being worse than ResNet34 contradicts its published VoxCeleb results. The centred scores are compressed: raw same-mic EER
  threshold 0.875 against 0.761 for ResNet34. This points to a feature or normalisation mismatch between this ONNX export and
  sherpa-onnx's front-end, not to a weak model, but I did not investigate. It is also 8x slower than ResNet34 and 24x slower than
  CAM++, which rules it out for the app either way.
- Diarization: only 6 recordings (5 AMI + 1 LibriSpeech call), with cached ASR. `offline.js` exercises clustering and
  word assignment but not the stored-transcript machinery or the acoustic refine pass. Diarization time for the two cached
  ResNet34 rows was measured in an earlier session.
- Speed was measured on a shared machine, and the 4-thread figures were taken while ffmpeg was degrading audio in the same process.

## Files

- Results: `.eval/results/voices-2026-11-26T10-40-06-171Z.json` (ResNet34), `…T10-42-41-543Z.json` (CAM++), `…T10-44-51-254Z.json`
  (TitaNet) and `…T11-47-40-793Z.json` (ResNet293) at the shipped settings. `…T10-49-04-922Z.json`, `…T10-52-45-154Z.json`,
  `…T10-55-18-001Z.json` and `…T11-49-35-141Z.json` are the `--calibrated` runs. `.eval/results/voices-prob-<model>.json` holds the calibration.
- Caches: `.eval/voices/` (ResNet34, from 2026-11-24, still loads), and `.eval/voices/<model>/` for the three candidates.
- `eval/voices.js`: new `--exclude person/chapter[,…]` for the analyses (`loadFor`).

```json
{
  "recommendation": {
    "model": "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx",
    "licence": "Apache-2.0",
    "sha256": "98daf9bcf1c8abf3db374fec4c27a5eda7c58705bb3f180d057b085a72a88bb5",
    "msPer10sOneThread": 114,
    "band": { "hi": 0.95, "lo": 0.6 },
    "note": "switch from WeSpeaker ResNet34-LM; needs a CAM++ VOICE_MEAN; 'system' is the runtime type for call/phone audio"
  },
  "calibration": {
    "same mic": { "coef": [-5.795, 13.25], "hi": 0.95, "lo": 0.6, "scoreHi": 0.66, "scoreLo": 0.468 },
    "video call": { "coef": [-4.635, 12.523], "hi": 0.95, "lo": 0.6, "scoreHi": 0.605, "scoreLo": 0.403 },
    "phone line": { "coef": [-6.363, 14.137], "hi": 0.95, "lo": 0.6, "scoreHi": 0.658, "scoreLo": 0.479 },
    "system": { "coef": [-5.375, 13.073], "hi": 0.95, "lo": 0.6, "scoreHi": 0.636, "scoreLo": 0.442 },
    "cross-channel": { "coef": [-6.359, 14.841], "hi": 0.95, "lo": 0.6, "scoreHi": 0.627, "scoreLo": 0.456 }
  },
  "calibrationResNet34LM": {
    "same mic": { "coef": [-7.806, 14.364], "hi": 0.95, "lo": 0.6, "scoreHi": 0.748, "scoreLo": 0.572 },
    "video call": { "coef": [-7.268, 12.639], "hi": 0.95, "lo": 0.6, "scoreHi": 0.808, "scoreLo": 0.607 },
    "phone line": { "coef": [-9.061, 12.083], "hi": 0.95, "lo": 0.6, "scoreHi": 0.994, "scoreLo": 0.783 },
    "system": { "coef": [-6.435, 9.81], "hi": 0.95, "lo": 0.6, "scoreHi": 0.956, "scoreLo": 0.697 },
    "cross-channel": { "coef": [-7.264, 15.133], "hi": 0.95, "lo": 0.6, "scoreHi": 0.675, "scoreLo": 0.507 }
  }
}
```
