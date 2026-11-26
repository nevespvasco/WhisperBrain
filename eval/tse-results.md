# Target-speaker extraction (VoxLock) for overlapped speech: go/no-go

Date: 2026-11-26. Script: `eval/tse.js` (its header describes the method in full). Raw output: `.eval/tse/`
(`runs/*.json` = cached extractions, `meetings.*.json`, `synthetic.json`, `absent.*.json`, `run-*.log`).

**Verdict: NO-GO.** All three pre-registered criteria fail on the real recordings. In the friendly synthetic case,
cpWER does improve by 3.9 points, but WDER gets worse and the time criterion still fails. The absent-speaker control
shows why: on AMI, VoxLock's output barely depends on whose voice sample it is given.

## Question and pre-registered criteria

Can target-speaker extraction recover the second talker's words in overlapped speech, attributed to the right
speaker, in the after-Stop pipeline? This follows the 2026-11-24 blind-separation attempt (MossFormer2: about 1
point gained, CPU RTF about 3, recovered words attributed correctly only about half the time). TSE conditions each
extraction on one known speaker's voice sample, so attribution should come for free.

GO only if all three hold. These were fixed before any result was seen:

1. cpWER improves by at least 3 points absolute (mean over recordings), and WDER does not get worse.
2. Added after-Stop time is at most 0.3 × the duration of the overlap audio processed, on 4 threads.
3. Fewer than 2 % of non-overlap words change.

## Method (short)

Full details are in the `eval/tse.js` header. In outline:

- **"Before"** is the real pipeline's output: cached Parakeet-TDT 0.6B v3 words and the cached full diarization,
  both from `eval/offline.js`, combined by `toTimeline` + `assignWords`.
- **Regions:** spans where at least 2 diarized speakers are active, kept when at least 0.5 s long, plus 1 s of
  context on each side.
- **Extraction:** for each region, the two most active speakers each get one VoxLock run. The voice sample is that
  speaker's longest solo stretches, 3.2–10 s. Parakeet (greedy) then decodes each output.
- **Reconcile rule (primary, `insert`, fixed in advance):** the dominant speaker's words stay. The other speaker's
  extracted words are inserted unless they duplicate a nearby "before" word.
- **Exploratory variants:**
  - `replace`: inside each region, the extracted words replace the "before" words.
  - `passthrough`: Parakeet on the unprocessed window, reconciled like `insert`. This is the no-TSE control: it shows
    how much of any gain comes merely from decoding the region a second time.
- **Scoring:** `eval/metrics.js` `score()` / `scoreTime()`.
- **Settings:** VoxLock int8 throughout. fp32 was run on ami-IS1009a and libri-call only. Everything ran on 4
  threads on a shared 32-core machine.

## Model files and licence

| file | bytes | sha256 |
|---|---:|---|
| `.models/voxlock/sherpa-onnx-voxlock-int8/chunk_int8.onnx` | 66,608,910 | `df61a9d0062b0adbcf1182302b1eb8b815f15ac47ea4923e8e164c1aff64121d` |
| `.models/voxlock/sherpa-onnx-voxlock-int8/enroll.onnx` | 12,476,014 | `5d06048c156bb8cd422d29848e6d38fb26a7b39f6f7fd92eccf2a6ed1ce003c6` |
| `.models/voxlock/sherpa-onnx-voxlock/chunk.onnx` (fp32) | 87,391,782 | `f02a548fcbdc921b8ff22760bc2e69a86eb098e70016e0d77a49f99defc25571` |
| `.models/voxlock/sherpa-onnx-voxlock/enroll.onnx` (same file as int8) | 12,476,014 | `5d06048c156bb8cd422d29848e6d38fb26a7b39f6f7fd92eccf2a6ed1ce003c6` |
| `.models/voxlock/dl/sherpa-onnx-voxlock-int8.tar.bz2` | 72,508,647 | `bcb947f9e8676d3e963f6048b0088505c84f0843bfdc88cb26dde3264d81570b` |
| `.models/voxlock/dl/sherpa-onnx-voxlock.tar.bz2` | 94,467,818 | `1facda8a76bc73ad3f133d560291bc8bc37ca6d9d440ae5f4017d142673f1c33` |

The archives come from the github.com/arbazsiddiqui/voxlock release `sherpa-onnx-models` (see also k2-fsa/sherpa-onnx
PR 4085). `.models/voxlock/dl/checksum.txt` lists other files (gtcrn) and does not cover these archives.

**Licence: Apache-2.0 for both code and weights.**

- Code: the repo README and LICENSE (github.com/arbazsiddiqui/voxlock).
- Weights: the release page ("VoxLock's weights are released under Apache-2.0") and the HF card
  huggingface.co/arbazsiddiqui/voxlock (apache-2.0).

**Model facts (README / HF card):**

- 27 M-parameter causal band-split RNN at 16 kHz, 24 ms algorithmic latency.
- Built on the REAL-TSE baseline / WeSep, with a WeSpeaker ECAPA speaker encoder.
- Trained on LibriSpeech and the **AMI corpus**.
- Design target: voice agents and phone calls, isolating the caller.

Not checked: the upstream licences of the base weights and training data, the HF LICENSE file and the NOTICE file.

## Results on real recordings (int8, primary `insert` rule)

"Before → after", in %. Overlap regions are diarized ones. The non-overlap column counts "before" words outside the
reference overlap that were added, removed or relabelled. "Inserted r/w/none" splits the inserted words into: right
reference speaker / wrong reference speaker / no matching reference word.

| recording | regions (s) | WER | WER in ov | WER out ov | WDER | cpWER | tcpWER | Δ cpWER | Δ WDER | non-ov changed | inserted r/w/none |
|---|---|---|---|---|---|---|---|---:|---:|---|---|
| ami-EN2002a | 183 (383.6) | 49.4 → 47.6 | 73.2 → 69.2 | 33.2 → 32.9 | 61.3 → 62.4 | 111.2 → 113.2 | 114.2 → 116.1 | +2.00 | +1.09 | 0.8 % (32/3896) | 143/61/61 |
| ami-ES2004a | 45 (63.9) | 37.9 → 37.5 | 63.3 → 61.8 | 30.1 → 30.0 | 35.4 → 35.9 | 82.2 → 82.7 | 82.4 → 83.0 | +0.49 | +0.52 | 0.4 % (7/1757) | 13/7/8 |
| ami-ES2011a | 54 (97.7) | 38.9 → 37.8 | 62.0 → 58.1 | 31.7 → 31.6 | 51.2 → 52.1 | 98.3 → 99.7 | 102.9 → 104.3 | +1.43 | +0.91 | 0.6 % (10/1648) | 16/24/15 |
| ami-IS1008a | 20 (19.9) | 21.6 → 21.5 | 56.6 → 54.2 | 19.1 → 19.2 | 33.3 → 33.7 | 65.6 → 65.8 | 75.4 → 75.6 | +0.20 | +0.45 | 0.3 % (6/2228) | 2/7/5 |
| ami-IS1009a | 49 (64.6) | 35.6 → 34.4 | 69.2 → 65.4 | 24.7 → 24.3 | 26.3 → 26.6 | 60.3 → 60.1 | 68.1 → 67.9 | −0.25 | +0.37 | 0.9 % (12/1370) | 22/10/8 |
| ami-TS3003a | 22 (20.6) | 39.2 → 39.0 | 71.1 → 69.9 | 35.9 → 35.8 | 42.7 → 43.1 | 85.9 → 86.5 | 93.8 → 94.3 | +0.68 | +0.42 | 0.2 % (4/1868) | 8/2/8 |
| libri-call | 1 (0.5) | 25.6 → 25.6 | 55.6 → 55.6 | 25.4 → 25.4 | 25.0 → 25.0 | 57.1 → 57.1 | 61.4 → 61.4 | 0.00 | 0.00 | 0.0 % (0/739) | 0/0/0 |
| **mean of 7** | | | | | | | | **+0.65** | **+0.54** | pooled 0.53 % | 204/111/105 |

A positive Δ means worse. The mean over the 6 AMI meetings alone is Δ cpWER +0.76 and Δ WDER +0.63.

**What the table shows:**

- **Plain WER inside overlap drops by 1–4 points** (ami-IS1008a −2.4, ami-EN2002a −4.0): some missed words do come
  back.
- **The `passthrough` control gets most of the same WER gain without VoxLock.** On ami-EN2002a, WER in overlap is
  73.2 → 70.9 with passthrough vs 69.2 with `insert`; on ami-ES2011a, 58.5 vs 58.1.
- **The recovered words are often given to the wrong speaker.** Of the inserted words that match a reference word,
  65 % went to the right speaker under `insert` (204 of 315), vs 50 % under `passthrough` (107 of 213). So cpWER and
  WDER get worse on 6 of 7 recordings.
- **libri-call** has a single 0.5 s diarized overlap region, so it contributes nothing either way.

### Exploratory variants (not part of the verdict)

| variant | mean Δ cpWER (7) | mean Δ WDER (7) | pooled non-overlap changed | inserted r/w/none |
|---|---:|---:|---:|---|
| `insert` (primary) | +0.65 | +0.54 | 0.53 % (71/13506) | 204/111/105 |
| `replace` | +0.69 | +0.23 | 3.21 % (433/13506) | 734/340/267 |
| `passthrough` (no TSE) | +0.53 | +0.51 | 0.31 % (42/13506) | 107/106/71 |

The fp32 model on ami-IS1009a gives the same picture as int8:

| ami-IS1009a, fp32 | cpWER | WDER | inserted r/w/none |
|---|---|---|---|
| `insert` | 60.3 → 60.1 | 26.3 → 26.7 | 21/10/8 |
| `replace` | 60.3 → 61.1 | 26.3 → 26.9 | 58/20/13 |

## Timing

All runs used 4 threads on a shared machine (another agent's 8-thread offline.js job ran at the same time), so these
times are upper bounds.

"Added" = VoxLock load and enrollment (one per speaker) + VoxLock runs + Parakeet on the outputs. Parakeet's model
load is not counted.

| recording | overlap s | windows s | load s | VoxLock s | Parakeet s | added / overlap | without load | VoxLock RTF per window-s per speaker |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| ami-EN2002a | 383.6 | 749.6 | 62.5 | 314.4 | 80.7 | 1.19 | 1.03 | 0.21 |
| ami-ES2004a | 63.9 | 153.8 | 23.5 | 57.6 | 15.1 | 1.51 | 1.14 | 0.19 |
| ami-ES2011a | 97.7 | 205.7 | 26.3 | 80.9 | 20.7 | 1.31 | 1.04 | 0.20 |
| ami-IS1008a | 19.9 | 59.9 | 3.9 | 24.8 | 6.6 | 1.78 | 1.58 | 0.21 |
| ami-IS1009a | 64.6 | 162.6 | 10.5 | 103.8 | 25.5 | 2.17 | 2.00 | 0.32 |
| ami-TS3003a | 20.6 | 64.6 | 22.2 | 21.9 | 5.8 | 2.43 | 1.35 | 0.17 |
| libri-call | 0.5 | 2.5 | 4.1 | 1.6 | 0.4 | 11.43 | 3.78 | 0.31 |
| **pooled** | 650.7 | 1398.6 | 153.0 | 605.1 | 154.9 | **1.40** | 1.17 | — |

- The ami-IS1009a run was done earlier by the previous agent under a different machine load; its higher VoxLock RTF
  is probably due to that.
- fp32 on ami-IS1009a was 2.91× overlap (VoxLock RTF 0.44).
- **VoxLock alone costs 0.93 s per overlap-second** (pooled). That is about 3× the 0.3× budget before any ASR, because
  each region needs 2 extractions over a window about 2.1× the overlap.

## Synthetic set (friendly case, reported separately)

- **Set:** 30 pairs of LibriSpeech dev-clean utterances, 30 readers, none of them libri-call readers. Each pair is
  mixed with 20–50 % overlap at 0, +5 and −5 dB, giving 90 mixtures.
- **Oracle:** turns and overlap spans come from the reference.
- **Voice sample:** a different utterance of the same reader.

| SIR | rule | WER | WER in ov | WDER | cpWER | tcpWER | inserted r/w/none |
|---|---|---|---|---|---|---|---|
| all | insert | 34.9 → 32.0 | 70.6 → 61.5 | 8.2 → 9.1 | 40.2 → 36.3 | 40.4 → 36.6 | 133/29/15 |
| all | replace | 34.9 → 35.1 | 70.6 → 71.4 | 8.2 → 3.5 | 40.2 → 35.2 | 40.4 → 35.3 | 228/42/28 |
| 0 dB | insert | 32.2 → 30.0 | 68.3 → 61.4 | 9.1 → 9.6 | 38.8 → 35.1 | 39.1 → 35.3 | 43/6/6 |
| +5 dB | insert | 36.1 → 32.9 | 71.0 → 60.7 | 11.2 → 12.3 | 43.4 → 40.4 | 43.7 → 40.7 | 33/16/3 |
| −5 dB | insert | 36.7 → 33.4 | 72.4 → 62.4 | 4.3 → 5.2 | 38.3 → 33.7 | 38.3 → 33.7 | 56/8/6 |

The SIR is the second talker's level relative to the first.

**Against the criteria, primary `insert` rule:**

| criterion | result | met? |
|---|---|---|
| cpWER | −3.9 points | yes |
| WDER | +0.9 points (worse) | no |
| non-overlap change | 0 % (only the oracle region is touched, so trivially met) | yes |
| time | 1.94× overlap (262.7 s for 135.6 s; load 86.2 s, VoxLock 140.7 s, Parakeet 35.7 s) | no |

**So even the friendly case is a no-go.** The exploratory `replace` rule does better: cpWER −5.0 and WDER −4.7.

**Whole-mixture extraction** (VoxLock on the full mixture, conditioned on each talker):

| SIR | first talker WER | second talker WER |
|---|---:|---:|
| 0 dB | 13.6 % | 62.4 % |
| +5 dB (second louder) | 31.4 % | 50.5 % |
| −5 dB (second quieter) | 5.6 % | 61.7 % |
| all | 16.9 % | 58.2 % |

The clean utterances score 3.8 % / 3.6 % WER. The talker who speaks first, and so has solo speech at the start of
the mixture, comes out well. The second talker mostly does not, even when 5 dB louder. This fits VoxLock's
caller-isolation design: it locks onto whoever owns the stream rather than strictly following the voice sample.

## Absent-speaker control

VoxLock was conditioned on a diarized speaker who is not among the region's two speakers. A model that follows its
voice sample should return near silence.

| meeting | regions | output/input RMS: absent (present) | corr | words per region: absent (present, unprocessed) | empty outputs |
|---|---:|---|---:|---|---:|
| ami-IS1009a | 49 | 0.91 (0.91) | 0.92 | 3.55 (3.47, 3.88) | 26.5 % |
| ami-ES2004a | 45 | 0.77 (0.78) | 0.79 | 3.9 (3.9, 3.6) | 11.1 % |

- **With the wrong speaker's voice sample, the output is as loud and as wordy as with the right one.** On this
  far-from-call-like meeting audio, VoxLock's output is largely independent of the enrollment.
- **This explains the poor attribution:** each "speaker" extraction contains much the same mixture.
- **Provenance:** the ami-IS1009a control was computed by the previous agent (file `absent.ami-IS1009a.json`, read
  here). The ami-ES2004a control was run in this session.

## Verdict against each criterion (real recordings, primary rule)

| criterion | threshold | result | met? |
|---|---|---|---|
| 1. cpWER | ≥ 3 points better | mean Δ +0.65 (worse); best single recording −0.25 (ami-IS1009a) | **no** |
| 1. WDER | not worse | mean Δ +0.54; worse on 6 of 7 recordings | **no** |
| 2. added time | ≤ 0.3 × overlap | 1.40× pooled (range 1.19–2.43× on AMI); 1.17× even with the load excluded | **no** |
| 3. non-overlap change | < 2 % | 0.53 % pooled; at most 0.9 % per recording | yes |

**NO-GO.**

## Caveats

- **Diarization limits which regions are found.**
  - Several meetings are badly over-split: 21–61 diarized speakers for 4 real ones, and cpWER above 100 % on
    ami-EN2002a.
  - Voice samples then come from fragments of a person, and some speakers have no usable 3.2 s sample. 17 region
    speakers across the 6 meetings had none and could not be extracted (ES2004a 1, TS3003a 4, EN2002a 9, ES2011a 3).
  - libri-call shows only one 0.5 s overlap region.
  - A better diarizer would find more and cleaner regions. However, the absent-speaker control is independent of
    that, and so is the synthetic set with oracle turns and clean voice samples. Both show that VoxLock does not
    follow the voice sample well enough.
- **Design target:** VoxLock is built to isolate a phone caller, not to pull a secondary talker out of meeting
  audio. The sherpa-onnx wrapper also uses only the loudest 3 s of the voice sample (its own log message).
- **Training data:** VoxLock was trained partly on AMI. Some test meetings may have been in its training data, which
  would favour it. It still fails.
- **Small samples:** 7 recordings and 650.7 s of diarized overlap. AMI headset-mix audio only; no real call audio
  with overlap was tested.
- **Shared machine:** times are upper bounds. Even so, VoxLock alone (0.93× overlap pooled) is about 3× over the
  time budget.
- **Possible metric drift:** `eval/metrics.js` was being edited by others while this ran. All numbers here were
  scored with the version present on 2026-11-26 around 09:00–09:45. The "before" WDER/cpWER for ami-ES2004a
  (35.4 / 82.2) and ami-TS3003a (42.7 / 85.9) match the `eval/offline.js --strategy full` output in
  `.eval/tse/offline-fill.log`.
- **Recordings not run:** ami-TS3004a had no cached diarization and was not run. fp32 was not run beyond
  ami-IS1009a and libri-call.
