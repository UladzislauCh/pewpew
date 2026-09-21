# Shot-detection eval harness

Measures the detector against the reference labels in `labels/`. Without it every threshold
tweak is guesswork: you can't tell whether things improved or the recall/precision balance
merely shifted.

---

## Project state as of now

The application replaces gunshot sounds in CS2 clips with an arbitrary sound.

### Priorities (important so a solution isn't rejected for the wrong reason)

**Priority number one is a working tool. Optimization comes later.**

The original constraint was "all processing in the browser, the video never goes to a server".
Later it was **explicitly relaxed by the client**: running on the client is optional if it
stands in the way of quality. Individual frames may be sent to a server, the whole video may not.

Therefore:

- **don't reject an approach merely because it is heavy or needs a server** — first make it
  work, and only then think about how to fit it into the browser;
- the current solution fits in the browser, but no longer with a large margin: a minute of
  video at 30 fps costs about 8 s of compute plus decoding, twice that at 60 fps
  (measurements in the "Cost and place of execution" section, script `eval/motionCost.mjs`);
- historically the dead end was not the server side but the attempt to squeeze everything
  out of the AUDIO. The signal turned up in frame motion, and the compute side proved feasible.

Stack: React 19 + Vite + TypeScript + Zustand, `@ffmpeg/ffmpeg` with the multithreaded core
`@ffmpeg/core-mt`. No styling framework, plain CSS. No test framework — executable scripts
in `eval/` serve as the checks. **No ML runtimes**: both the network and backpropagation are
written in TypeScript, the weights ship as plain JSON.

### Best result

The metric is the **amount of manual editing**, normalized by the number of own shots in the
clip, averaged per clip. `w` is the cost of deleting a spurious mark relative to finding a
missed one.

| features | AUC | w=1.0 | w=0.5 |
|---|---|---|---|
| audio only (ShotNet) | 0.726 | **1.00x** | 1.13x |
| **camera + weapon + audio** | **0.910** | **1.75x** | **2.20x** |

Audio alone gives parity with labeling from scratch, i.e. it is useless. Motion carries everything.

Working point (`eval/workingPoint.mjs`, cross-validation by clip, threshold optimal at w=0.5):
**73.5% of own shots found, 34% of the placed marks are spurious.**
The recall ceiling is 94.8% — that's how many own shots fall into the audio candidates.

Composition of the 1296 placed marks:

| | share of marks | share of spurious |
|---|---|---|
| own shots | 66.0% | — |
| **enemy shots** | **4.6%** | 13.4% |
| **not shots** | **29.5%** | **86.6%** |

**Spurious marks are almost entirely noise, not enemy fire.** An "own vs enemy" stage addresses
only 13% of the errors; the rest are triggers on no shot at all. The audio stage gave the same
conclusion earlier (9% enemy), and motion didn't change it.

Per clip the share found is noticeably lower: 54.4% on average, median 61%. The overall figure
is higher because dense clips with bursts outweigh sparse ones.

Previously this said "76% and 39%". They could not be reproduced: the gains of 1.75x and 2.20x
match exactly, i.e. the model and protocol are the same, but recall and the spurious share are
not. The numbers above come from a script that can be rerun.

Weights: `models/motionModel.json` (74 features) and `models/shotNet.json` (7793 parameters).
Both pin the **order of feature names** — without it the weights are useless.

### FFmpeg module (done)

`SharedArrayBuffer` for `core-mt` requires cross-origin isolation — two headers
in `vite.config.ts`, checked via `window.crossOriginIsolated === true`:

```ts
'Cross-Origin-Opener-Policy': 'same-origin',
'Cross-Origin-Embedder-Policy': 'require-corp',
```

Two non-obvious spots:

- `optimizeDeps.exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util']` — Vite's esbuild pre-bundler breaks
  the internal worker, which is resolved through `new URL(..., import.meta.url)`
- the core is self-hosted in `public/ffmpeg` and loaded via `toBlobURL`: the worker must be same-origin

Filter graph in `src/services/videoProcessor.ts`:

```
[1:a]apad[ovpad];
[ovpad]asplit=2[ov1][ov2];
[0:a][ov1]sidechaincompress=threshold=0.05:ratio=8:attack=10:release=250:makeup=1[ducked];
[ducked][ov2]amix=inputs=2:duration=longest:normalize=0[aout]
```

- **`apad` is mandatory**: `sidechaincompress` has no `duration` option and cuts the output
  at the shorter input — without it the video stopped at the last shot
- **`asplit`**: a filter output can be consumed only once, and `[ovpad]` is needed twice
- **`normalize=0`**: otherwise `amix` divides the volume by the number of inputs
- the video track is copied without re-encoding
- **`adelay` is not used**: it was dropped because on a clip with 95 shots the graph grew
  to hundreds of nodes. The overlay is built offline over the samples in `buildOverlayTrack.ts`,
  and the graph no longer depends on the number of shots

### Main technical debt

**Cleared: detection is wired in, but in the PRODUCT repository, not here.** Both stages run
in `pewpew` (branch `shotnet-in-wizard`): audio in `src/domain/detection/shotNet/`, motion in `src/domain/detection/motion/`
together with the mediabunny frame source. The `App.tsx` here still takes timecodes as
comma-separated text — this repository has remained a research one and doesn't need finishing.

Done in `src/lib/detection/`: `shotNet.ts`, `melSpectrogram.ts`, `detectShotsWithNet.ts`,
`extractAudio.ts`, `fft.ts`, `mel.ts`, `score.ts`, `refSimilarity.ts`, `motionFeatures.ts`.

`VideoShotValidator.ts` is an **obsolete approach**: global frame analysis via difference
and brightness. Measured: AUC 0.652 "shot vs noise". Kept for reference, not used in the
solution.

### Plan of further work

0. **MAIN POINT: the work has moved to the product repository.** Two-stage detection
   (audio + motion) has been ported to `/Users/uladzislau/Projects/pewpew`, branch `shotnet-in-wizard`.
   There F1 rose 49.7 → 66.2 on the same labels. State, measurements and open questions are
   in `pewpew/docs/HANDOFF-detection.md` — read it first.
1. ~~Move motion feature extraction into `src/`.~~ **Done:**
   `src/lib/detection/motionFeatures.ts`, breakdown below in "Porting to production".
2. ~~**Frame decoding via WebCodecs**.~~ **Done and reconciled:**
   `pewpew/src/domain/detection/motion/frameSource.ts` on mediabunny, frames are converted by `sampleGrayFrame`
   (nearest neighbour and integer Rec.601, exactly as in `frametool`; the smoothing scaling of
   `drawImage` would give DIFFERENT pixels, and the weights were trained on these).
   The reconciliation against the reference ran on all 49 clips, breakdown below in "Browser
   decoding vs the reference": product F1 64.1 vs 64.3, i.e. noise.
3. **Mark editor**: a timeline with a waveform (`buildWaveformPeaks` already exists
   in `extractAudio.ts`), adding and deleting marks. Measurement showed that **cheap deletion
   matters more than model quality**: at equal edit costs the gain is 1.75x, with deletion
   three times cheaper — 2.65x. Bulk deletion and paging through candidates give a multiplier
   that multiplies with any model improvement.
4. Optional: **finish the ammo counter** — measure the gain on the eight clips
   where it is found by anchoring to the motion detector.

### What not to do

- **Squeeze more out of audio.** Ten attempts, ceiling 1.13x.
- **Go back to synthesis and augmentation.** Both measured, both hurt.
- **Search for HUD elements with weak criteria** ("rare changes", "stillness",
  "small vocabulary"). Failed three times: counter, flash, crosshair.
- **Add the flash to motion.** Checked twice, including on top of the full model
  and across all 36 zones: zero at best, −0.10x at worst.
- **Normalize the score within a clip.** Drops 2.20x to 1.36x: the differing fire density
  of clips is signal, not a nuisance.
- **Train separate per-weapon models.** Checked on the AK-47 (the only one with enough
  data): loses on 6 clips out of 6, 3.71x vs 2.57x.
- **Add accumulated camera drift features.** The firing signature is strong and real,
  but it is shared by the whole firefight and doesn't separate own shots from neighbouring
  candidates.
- **Treat 49 clips as enough for large models.** The learning curve is flat, the slope is
  statistically indistinguishable from zero even with a three-times-larger network. Same on
  motion features: a nonlinear model is worse than a linear one, monotonically with capacity.

### Rules whose violation breaks measurements

- **Cross-validation is grouped only, by clip** — otherwise the model learns the clips' lighting
- **Take weights from the last epoch**: picking "best on test" inflated the result by ~2 pp
- **`minGapMs = 50`** — the cycle of the fastest CS2 weapon; raising it from 25 gave +6 pp precision
- **Burst-aware matching** (`matchDetectionsBurstAware`)
- **Labels are no more precise than ±18.4 ms** (SD on isolated shots)
- **Zone shifts are rounded to three decimals** — the sign-change count, the strongest single
  motion feature, depends on this rounding (breakdown in "Porting to production")
- **`fft()` requires a power of two** — it used to silently return garbage, which cost one
  invalid measurement; a check has been added

Dataset: 49 clips, 17.2 minutes, 1703 shots (1163 own, 540 enemy).
Caches in `.cache/` are about 1.4 GB. Recompute: `motionHiRes.mjs` ~25 min, `zoneMotion.mjs` ~30 min,
`weaponMotionAll.mjs` ~20 min.

---

## Running

```bash
pnpm eval:decode     # one-off: mp4 -> mono WAV 44100 in .cache/audio (afconvert, ~87 MB)
pnpm eval            # detailed report on the current defaults
pnpm eval:sweep      # threshold sweep
pnpm eval:diagnose   # breakdown of misses and false positives
```

The video part needs a one-off build of the frame extractor:

```bash
swiftc -O eval/tools/FrameTool.swift -o .cache/bin/frametool
node eval/decodeVideo.mjs   # mp4 -> 90x160 grayscale frames in .cache/video (~500 MB, 48 s)
node eval/probeVideo.mjs    # separating own and enemy by video features
```

`frametool` uses AVFoundation — the macOS system decoder, no ffmpeg needed. It is an
eval-harness tool: in the application frames are extracted by ffmpeg.wasm, all processing
happens in the user's browser.

Individual parameters and a single clip:

```bash
node eval/run.mjs --deltaStd=0.5 --absFloor=0.3 --minHz=3000
node eval/run.mjs --clip=ak47-dbf13655
```

## How metrics are computed

Detections are matched to labels one-to-one, greedily from the closest pairs, with tolerance
`--tolMs` (50 ms by default). Greediness matters: with a median interval of 92 ms the windows
of neighbouring shots nearly touch, and naive left-to-right matching would attribute a
detection to the neighbouring shot.

Breakdown by label category:

- **own** (`source: own`) — what must not be missed, the main recall.
- **own + hard** — the shot is buried under noise, music or overlapping fire. The most important
  slice: regressions show up there first.
- **enemy** (`source: enemy`) — at this stage these are NOT false positives. Separating own from
  enemy is the job of the next stage (video), so precision is computed against all shots at once.

## Recall ceiling

Labels in dense sprays are imprecise: there are pairs of marks closer than 25 ms, and for the
AK-47 with a 100 ms cycle that is physically impossible — i.e. the same shot is labeled twice.
One detection covers only one mark, the second inevitably counts as a miss. The report prints
this ceiling (`97.2%` at `minGapMs=25`) so that recall isn't compared against 100%.

## Current baseline

Spectral flux (`src/lib/detection/onsetDetector.ts`), tuned for recall:

| metric | value |
|---|---|
| recall own | 96.6% (ceiling 97.2%) |
| recall own + hard | 98.3% |
| precision | 12.7% |
| false per minute | 639 |
| detection offset | median +2.3 ms |

This is a candidate generator, not the final detector: it misses almost nothing, but emits
an order of magnitude more events than needed. Filtering is the next stage.

## What has been tried and didn't work

### Matching candidates against clean weapon sounds — doesn't separate

`eval/matchExperiment.mjs`. Idea: take a timbral fingerprint of the candidate and compare it
with templates from `weapon-samples/`. The fingerprint is the energy gain across 40 mel bands
in a 60 ms window after the onset relative to the background before it (the gain rather than
the spectrum, because in a clip the shot sounds over music).

The feature itself works; this was checked separately on clean samples (`eval/sanityTemplates.mjs`):

| | value |
|---|---|
| weapon guessed by nearest sample | 40.8% (chance — 2.9%) |
| similarity of same-weapon pairs | 0.495 |
| similarity of different-weapon pairs | 0.042 |

But on real clips there is no separation — the score distributions of real shots and false
positives practically coincide:

| templates | median real | median false | false removed at a cost of 10% real |
|---|---|---|---|
| all 82 variants | 0.712 | 0.708 | 12.0% |
| 34 averaged per weapon | 0.699 | 0.693 | 11.3% |
| one shared | 0.446 | 0.347 | 19.7% |

Also checked on a strict candidate set (recall 72% instead of 96.6%) — same picture, so the
problem isn't too many candidates.

Two conclusions:

1. The more templates, the worse: the maximum over 82 templates densely covers the space of
   transients, and any broadband click finds a match. In clips the scores reached 0.71 —
   higher than a weapon matching itself on clean samples (0.495).
2. Even with one template the gap is too small. A clean sample and the same shot in a clip are
   different things: reverberation, mixing with game audio and aggressive stream compression
   eat exactly the timbre difference the method relies on.

Don't return to this without changing the feature: a single averaged spectrum of a 60 ms window
is too poor. Meaningful continuations are to take temporal structure into account (a mel patch
of 40×N frames, the shot's decay) or to train a classifier on the labels themselves, where 1656
positive and ~11000 negative examples are already labeled by this same harness.

## Video: own shot vs enemy shot

`eval/probeVideo.mjs`. The metric is AUC: the probability that a random own shot scores higher
than a random enemy one. 0.5 — no signal, 1.0 — perfect separation.

| feature | AUC overall | AUC 30fps | AUC 60fps |
|---|---|---|---|
| brightFull — gain in mean frame brightness | 0.676 | 0.639 | 0.867 |
| brightMid — same over the middle band of the frame | 0.714 | 0.687 | 0.849 |
| diffFull — absolute brightness change | 0.627 | 0.573 | 0.885 |
| **flashSpike** — frame brighter than both neighbours | **0.752** | **0.725** | 0.880 |
| **cellMax** — maximum brightness gain over 5×5 cells | 0.701 | 0.655 | **0.895** |

What works is the **muzzle flash**, not recoil. Camera motion was checked separately
(`eval/probeMotion.mjs`) and doesn't fit: own |dy| 6.0 vs enemy 5.0 with background 0.0 —
the signal drowns completely in ordinary aiming, the player moves the mouse constantly.

The main conclusion: **everything hinges on the frame rate**. The flash lasts less than a frame,
and at 30 fps it either falls between frames or gets smeared: AUC drops from 0.895 to 0.655.
At 60 fps the local brightness gain separates confidently.

What matters about the dataset: these are YouTube Shorts 720×1280, with a banner on top, the
player's webcam at the bottom, and the weapon viewmodel almost cut off by the frame edge — the
muzzle is rarely visible. So what gets caught is not the flash itself but the scene lighting
from it. On source gameplay recordings (full frame, 60 fps, visible viewmodel) the signal
should be noticeably stronger.

The cell format and frame band are currently set heuristically (band at 15–65% of height,
6×6 grid), because the position of the game view differs between clips. Automatic detection
of the game area is a separate task that was never reached.

### Trainable own-vs-enemy classifier

`eval/trainOwnEnemy.mjs`. A candidate is described by a window of per-frame features (7 samples
in time plus the maximum, mean and "peak over background" over a ±80 ms window). Cross-validation
is grouped by clip: otherwise the model learns the lighting of specific clips.

| | AUC |
|---|---|
| all clips | 0.799 |
| 30 fps only | 0.780 |
| 60 fps only | 0.893 |

Colour gave the main gain: with grayscale it was 0.733 at 30 fps, adding "warmth" (R−B) made it
0.780. The best single features are now warm ones: `warmSpike` 0.734.

Importantly, the maximum over the window is stronger than any exact sample (0.721 vs 0.497 for
the same feature): the timestamp comes from the audio, and the flash lands sometimes in one
frame, sometimes in the neighbouring one.

Working points at 30 fps: keeping 95% of own shots, only 26% of enemy shots can be filtered out.

## End-to-end pipeline: why it doesn't work yet

`eval/trainPipeline.mjs`, `eval/trainCombined.mjs`, `eval/trainMelPatch.mjs`.

The negative class here is not only enemy shots but also false positives of the audio detector.
That is exactly the mix the filter has to sort out in real use.

With audio at maximum recall (12 522 candidates for 1 122 own shots):

| filter | recall | precision | false/min |
|---|---|---|---|
| no filter | 96.6% | 9.0% | 663 |
| video only | 91.7% | 10.6% | 525 |
| audio only (trainable) | 91.7% | 14.5% | 366 |
| audio + video | 91.7% | 14.3% | 371 |
| mel patch 32×16, linear model | 91.7% | 11.5% | 475 |

With a moderate audio threshold (3 656 candidates): 71.3% recall at 24.4% precision.

Conclusions worth holding on to:

1. **Combining audio and video gives nothing beyond audio** (14.3% vs 14.5%). Video is better at
   filtering out enemy shots (151 vs 237 while keeping 80% of own), audio is better at filtering
   noise (3530 vs 4185), but there is an order of magnitude more noise — it determines the outcome.
2. **Audio detector precision hits a ceiling of ~29%** at any threshold; beyond that recall
   collapses (44% at absFloor=1.2, 10% at absFloor=2). Shots in these clips are not louder than
   other transients in spectral flux — this is a property of the data, not a tuning question.
3. **A mel patch with a linear model is worse than the hand-crafted fingerprint** (11.5% vs 14.5%).
   The representation is richer, but a linear model has no invariance to shifts in time and
   frequency and can't make use of it. This points to the missing piece — not features, but a
   model with the right inductive bias (convolutions).

Product quality (roughly 90% recall at 95% precision) is far away from here. The conclusion is
not new hand-crafted features but a model with the right inductive bias. Which is what was done
next, see ShotNet.

## ShotNet — a per-frame convolutional network

`src/lib/detection/shotNet.ts`, training `eval/trainShotNet.mjs`.

The scheme is fundamentally different: not "candidate detector, then classifier", but a network
that outputs a "shot here" score for EVERY frame of the mel spectrogram. Peaks are then found on
this curve. This removes both the 10:1 class imbalance and the recall ceiling of the old detector.

The convolution runs over time, the mel bands act as input channels — exactly the shift
invariance the linear model on the mel patch lacked.

```
input     40 mel bands, step 11.6 ms
conv      40 -> 24, kernel 5, ReLU
conv      24 -> 24, kernel 3, ReLU
conv      24 -> 16, kernel 3, ReLU
conv      16 -> 1,  kernel 3   -> logit per frame
```

7793 parameters, receptive field 11 frames (128 ms), weights file 72 KB. All in plain TypeScript:
inference runs in the browser with the same code, ONNX Runtime Web isn't needed.

Result of five-fold grouped cross-validation, at 90% own-shot recall:

| | precision | false/min |
|---|---|---|
| old detector (spectral flux) | 12.8% | 639 |
| old pipeline (audio, trainable) | 16.9% | 290 |
| ShotNet, peak gap 25 ms | 32.6% | 181 |
| **ShotNet, peak gap 50 ms** | **36.3%** | **142** |

The old detector never rose above 29% precision **at any** threshold; ShotNet on individual
folds gives 45–52% at 60–80% recall. The spread across folds is noticeable (26–40%) — the test
has only 9–10 clips.

**Important about precision.** In the tables above ANY shots count as correct, own and enemy:
at this stage separating them is video's job. The product needs only own shots, and for them the
number is noticeably lower. At 90% own recall the detections are composed as follows:

| | share of detections |
|---|---|
| own shots | 28% |
| enemy shots | 9% |
| not shots | **63%** |

So the bottleneck is not "own vs enemy" (that's only 9%) but noise. The video stage fixes exactly
those 9%, and that's why it barely moves the outcome — which the end-to-end run showed.

What was checked while tuning:

- A bigger architecture does worse: `[32,24,16,1]` gave 20.7% vs 23.3% for the base one,
  and the five-layer one didn't reach 90% recall at all. With 36 training clips capacity is
  already excessive.
- Weights are taken from the LAST epoch. Picking "the best epoch on test" inflated the result
  by about 2 pp — that is peeking into the held-out set.
- Backprop is hand-written, so there is a numerical gradient check: `node eval/gradCheck.mjs`.
  The error has a minimum of 5.5e-4 at eps=1e-3; the growth at large eps is the known
  non-smoothness of ReLU.

### How much more to label

`eval/shotNetCurve.mjs`. Precision at 90% own recall, base architecture, 35 epochs,
3 repeats per point, the test is always 12 clips:

| training clips | precision | spread |
|---|---|---|
| 6 | 22.6% | ±2.1 |
| 12 | 23.0% | ±1.5 |
| 18 | 22.9% | ±2.9 |
| 25 | 23.8% | ±3.4 |
| 31 | 23.3% | ±4.1 |
| 37 | 24.7% | ±6.5 |

There is growth, but it's weak: +2.1 pp for a sixfold increase in data, comparable to the spread.
A straight extrapolation to 300 clips gives only +5–8 pp.

The obvious explanation was "a fixed-capacity model saturates regardless of data", so the same
curve was taken for a network three times larger (`--channels=48,48,32,1 --kernels=7,5,3,3`):

| training clips | base network | large network |
|---|---|---|
| 12 | 23.0% | 24.1% |
| 37 | 24.7% | 25.0% |

The slope is the same. Increasing capacity doesn't move the plateau, i.e. the limit is neither
capacity nor data volume in this range.

The main hypothesis remained unchecked: **some of the "false positives" are real shots missing
from the labels.** CS2 clips constantly have background firefights, and what was labeled were
audible and identifiable shots. If so, the measured precision is understated for any model, and
the ceiling is set by the labels, not the algorithm. This can only be checked by listening to a
sample of false positives.

The absolute numbers of the curve (24.7%) are lower than in five-fold cross-validation (32.6%):
here it's 35 epochs instead of 50 and a fixed 12-clip test instead of rotation. The curve is good
for comparing its points with each other, not for comparing with the numbers in the section above.

### Running

```bash
node eval/prepareSpectrograms.mjs                  # one-off, ~2 s
node eval/gradCheck.mjs                            # gradient check
node eval/trainShotNet.mjs --epochs=50 --folds=5   # full cross-validation, ~6 min
node eval/shotNetCurve.mjs                         # learning curve by number of clips
```

### Blind test: are the false positives really false

`eval/exportListeningTest.mjs` + `eval/scoreListeningTest.mjs`. The hypothesis was that clips
constantly have background firefights, only identifiable shots were labeled, and so the measured
precision is understated. 40 fragments of 1 s each from HELD-OUT clips, shuffled, with two
control groups.

The controls passed: fragments matching the labels were identified as shots 10/10, background
0/6. Without them it would be impossible to distinguish "the false positives contain shots" from
"shots are heard everywhere".

| type of false positive | share of real shots |
|---|---|
| right next to a shot (<150 ms) | 8/8 |
| near a firefight (150 ms – 1 s) | 6/8 |
| isolated (>1 s) | 1/8 |

The hypothesis was confirmed PARTIALLY and not where expected. Isolated triggers are almost all
genuinely false — the labels away from firefights are complete. But close to shots the network
fires on something that by ear is indistinguishable from a shot.

The scoring script recomputes precision from the share of "real" ones (it came out at 74.7%),
but this number must NOT be trusted: it assumes the close triggers are shots missed by the
labels. The timing analysis below showed that this is not the case. The value of the test turned
out to be not the correction but the fact that it pointed at where to dig.

### Repeated triggers on a single shot

`eval/analyzeCloseFp.mjs`. By ear, "a missed shot in a burst" and "a reverb tail" sound the same,
but they differ in timing — a weapon has a fixed fire rate.

The histogram showed the distributions are DIFFERENT: false positives peak at 20–60 ms from the
labeled shot and fall off monotonically, while real inter-shot intervals peak at 80–100 ms
(median 104 ms). 60% of the close triggers lie closer than 60 ms — faster than any CS2 weapon
can fire.

So these are not missed burst shots but repeated triggers on one shot. It is cured by the
peak-merge gap (`eval/sweepMinGap.mjs`):

| gap | precision | false/min |
|---|---|---|
| 25 ms (before) | 31.5% | 158 |
| 40 ms | 34.7% | 138 |
| **50 ms** | **37.5%** | **123** |
| 60 ms and more | 90% recall unreachable |

50 ms is roughly the cycle of the fastest CS2 weapon, i.e. a limit justified by physics, not by
fitting. At 60 ms real bursts start getting lost.

### Synthesis of training data — doesn't work

`eval/synthesize.mjs`, diagnostics `eval/domainGap.mjs`.

The plan: mix clean shots from `weapon-samples/` into real background, getting perfect labels for
free and removing the dependence on the volume of manual labeling. Each shot got a pitch shift,
distance attenuation, reflections, random volume; shots were placed in bursts at a real fire rate.

Two modes were tried. Both degrade quality on real clips (all rows are the same `--folds=1` run,
tested on 13 held-out clips, only the training set differs):

| training | precision at 90% recall |
|---|---|
| real only (baseline) | **28.4%** |
| + 15 synthetic clips | 23.4% |
| + 40 synthetic | 23.4% |
| + 150 synthetic | 20.0% |
| + augmentation of real clips | 22.4% |
| synthetic only | 90% recall unreachable at any threshold |

A network trained on synthetic data alone finds only 29.3% of shots in real clips, while its loss
on synthetic data drops to 0.167. It learns synthetic shots perfectly — they are simply a
different phenomenon.

The first version assembled a clip from cut-out pieces WITHOUT shots, and that was a structural
mistake: quiet spots outside firefights are exactly the context where shots don't occur, so the
network learned "a transient in silence". The `--mode=augment` mode fixes this (it mixes into
whole real clips, keeping their labels), but quality still drops.

The cause was measured directly: **AUC "mixed-in vs real" = 0.974**. A linear model on a 40×11
mel patch tells synthetic from a real shot almost without error. So synthesis carries its own
signature, and the network learns from it.

To fix this one would need to reproduce not the shot's timbre but the whole chain: the engine's
reverberation and spatial processing, the game mix, and then YouTube re-encoding. A dry sample
with home-made reflections falls short of that. Without such work synthesis must not be added —
it isn't neutral, it's harmful.

### The labels were not to blame

`eval/thoroughVsRest.mjs`. Eight clips are labeled exhaustively — every audible shot, including
background firefights. The list is set in the script itself (`THOROUGH_CLIPS`):
`sawedoff`, `3 KILL IN THE BLINK`, `awp`, `Biguzera BACKSTABS`, `galil`, `glock`,
`golyi korol` (a Cyrillic clip title, "naked king", transliterated here), `xm1014`.

The hypothesis was: on the remaining clips some "false positives" are real unlabeled shots, and
so precision is understated.

The hypothesis was REFUTED. Both groups were scored by one model at one threshold:

| group | clips | shots/min | precision | **false/min** |
|---|---|---|---|---|
| exhaustive | 8 | 67 | 21.9% | **113** |
| the rest | 41 | 105 | 32.3% | **109** |

The key number is not precision but the false rate: 113 vs 109, i.e. the same. Had the "false"
ones been unlabeled shots, there would have been noticeably fewer of them on the exhaustively
labeled clips. There weren't. The precision difference is explained entirely by shot density:
with an equal stream of errors, fewer real shots give lower precision.

Conclusion: the false positives really are not shots, and it's the model that needs fixing, not
the labels. The earlier blind test (63% "real" among the false ones) was misleading — it was
dominated by the "right next to a shot" category, which then turned out to be repeated triggers
on one and the same shot.

### Correcting for imprecise marks inside bursts

A labeler reliably hears the start and end of a burst but places the individual shots inside it
approximately. Strict matching penalizes this twice: a shifted mark yields both a miss and a
false positive.

`matchDetectionsBurstAware` in [score.ts](../src/lib/detection/score.ts) matches single shots as
before (±50 ms), while for a burst it requires only landing inside its interval with the right
count. At 90% own recall:

| matching | threshold | precision | own only | false/min |
|---|---|---|---|---|
| strict | 0.26 | 30.8% | 21.1% | 200 |
| **burst-aware** | **0.76** | **44.5%** | **31.0%** | **110** |

This is not just a recount: the strict metric forced working at a threshold of 0.26, because
otherwise recall inside bursts fell apart. With the correction the same 90% recall is reached at
a threshold of 0.76, where there are three times fewer detections. So the working point itself
changes, not just the bookkeeping.

The metric is knowingly softer than the strict one, and its upper bound is how imprecise the marks
inside bursts really are. The strict 30.8% should be kept as a lower estimate.

### The right metric: per clip and per shot

`eval/perClipReport.mjs`. "False per minute" measures the clip, not the model: different videos
have different fire rates. The denominator must be the number of OWN shots to be found, and the
average must be taken PER CLIP, otherwise a long dense clip outweighs a short one.

Only a detection of an own shot counts as correct: hitting an enemy shot is the same error as a
trigger on noise — the product would place the sound in the wrong spot.

| threshold | own found | median | spurious per shot | median | clips ≥90% |
|---|---|---|---|---|---|
| 0.5 | 95.1% | 100% | 8.21 | 3.21 | 43/49 |
| 0.7 | 92.9% | 100% | 6.52 | 2.67 | 42/49 |
| 0.8 | 90.4% | 97% | 5.18 | 2.12 | 36/49 |
| 0.9 | 78.5% | 86% | 3.11 | 1.10 | 21/49 |

Recall is good: median 100%, 42 clips of 49 above 90%. The problem is entirely the spurious
triggers — each correct shot comes with 2–3 errors in the median clip.

In total: 1163 own shots, 1068 found, 2617 spurious triggers (465 landed on an enemy shot, 2152
on nothing). So an "own vs enemy" video stage addresses only 18% of the errors.

### The network fires at an almost constant rate

The spread of "spurious per shot" between clips is huge (from 0.0 to 96), and it is explained by
fire density: the correlation with the own-shot rate is r = −0.917 (in logs).

The cause is visible when comparing rates:

| clip | own/min | detections/min | spurious |
|---|---|---|---|
| aug | 383 | 349 | 0 |
| m249 | 451 | 433 | 2 |
| negev | 391 | 453 | 16 |
| deagle | 20 | 178 | 105 |
| nova | 14 | 311 | 130 |
| awp | 11 | 168 | 29 |

The own-shot rate varies 40-fold, while the network's trigger rate varies only 3-fold. The network
learned "fire often on transients", not "tell shots apart". In dense clips this happens to match
reality; in sparse ones almost everything misses.

Checked and rejected: spectrogram normalization is not the cause. The hypothesis was that dividing
by the within-clip SD inflates the background in quiet clips, but the SD of sparse clips is, on
the contrary, HIGHER (awp 4.76, nova 4.66 vs aug 2.57, m249 2.53).

Checked and confirmed: the burst correction doesn't inflate the score. In clips with rapid-fire
weapons it changes the count moderately (aug 4 spurious vs 0, m249 10 vs 2), and in the problem
clips the strict and soft counts coincide — there are no bursts there at all.

### A longer receptive field helps discrimination

`eval/compareDilation.mjs`. The network saw 128 ms — enough for the shot's attack, but not for its
decay. A shot differs from a kick drum or a plosive consonant precisely in how it fades, and that
takes 300–500 ms. A dilated convolution gives such a receptive field without adding parameters.

| configuration | field | parameters | AUC | AUC noisy | AUC clean | spurious/shot |
|---|---|---|---|---|---|---|
| no dilation | 128 ms | 7793 | 0.897 | 0.788 | 0.913 | **6.82** |
| dilation 1-2-4-8 | 383 ms | 7793 | **0.911** | **0.827** | **0.923** | 7.33 |
| +layer | 755 ms | 9545 | 0.908 | 0.824 | 0.920 | 7.67 |

Discrimination improved everywhere: +3.9 points on noisy clips, +1.0 on clean ones, with the same
number of parameters. But the final metric got worse — so what was lost is not discrimination but
peak picking: with a long field the curve is smoother, and settings tuned for a sharp curve don't
suit it. Breakdown in `eval/tunePeaks.mjs`.

Dilation is supported in [shotNet.ts](../src/lib/detection/shotNet.ts) via the `dilations` field.
Gradients were also checked numerically on the dilated configuration (median error 1.8e-5).

### Labels cannot be more precise than a frame

The labeler doesn't allow placing a mark to the exact tick. Measured on isolated shots (n=109, to
exclude the knowingly approximate marks inside bursts):

| | ms |
|---|---|
| mean deviation | 3.2 |
| SD | **18.4** |
| p05 … p95 | −24 … +42 |

With an 11.6 ms frame this is a spread of ±2–4 frames, while the default training target is
±1 frame. So the real shot frame is often marked negative and a neighbouring one positive — the
network learns from shifted labels. Width tuning: `eval/sweepTargetWidth.mjs`.

## Ammo counter — a direct signal instead of indirect ones

Everything described above derived shots from INDIRECT features: timbre, brightness, attack shape.
Yet the frame contains a direct answer — the CS2 ammo counter, which decreases by exactly one on
every OWN shot and doesn't react to enemy ones.

Measured on `m4a4` (33 own shots, 22 enemy), `eval/ammoSignal.mjs`:

| | value |
|---|---|
| own vs background | **AUC 0.982** |
| own vs enemy | **AUC 0.961** |
| own shots producing a change | **33 of 33 (100%)** |
| enemy | 2 of 22 (9%) |
| background moments | 17 of 144 (12%) |

For comparison, the ceiling of the audio approach after a dozen attempts: per-frame AUC 0.895 and
6.5 spurious triggers per own shot.

Two details without which it doesn't work:

- **Binarization is mandatory.** The CS2 HUD is semi-transparent, the moving scene shows through
  it. Comparing brightness gives AUC 0.830, comparing binary masks at threshold 190 gives 0.982.
  The digits are noticeably brighter than the background, and the threshold cuts the scene out
  entirely.
- **The region must be taken precisely.** To the right of the digits are the reserve ammo and the
  weapon model, which jerks with recoil. Shifting the region to the right drops separation to 0.765.

### Automatic region search

`eval/findAmmoRegion.mjs`. The coordinates can't be a constant: there are at least three layouts —
the native HUD, a tournament broadcast with its own design, and a frame with a cropped HUD.

The search uses the TEMPORAL signature, not appearance. The counter's signature is unique: between
shots it is still, it changes all digits at once, and it does so rarely and abruptly. The scene
changes continuously, static captions never change — both extremes are filtered out by bounds on
the number of pixel toggles.

Candidates are ranked by burstiness weighted by size: `p99/median × √area`. Without the size
weight random specks of a dozen pixels win.

On `m4a4` it finds x 0.766–0.822, y 0.778–0.801 — exactly what was found by hand — and counts
35 events for 33 own shots.

### Automatic region search failed on the full set

It worked on one clip, not on 49. The batch run (`eval/ammoStates.mjs`): a region was found in
30 clips, but the event count matched the shot count **in one clip of 49**. Errors in both
directions: `kscerato` has 0 events for 28 shots, `the-last-kill` 60 for seven.

**The cause was found and it is fundamental: health and armour are structurally INDISTINGUISHABLE
from ammo.** Same digits, same font, same small vocabulary of glyphs, same repeatability. On
`dual-berettas` the search picked health and armour and gave it the HIGHEST score of all clips,
0.95, with 5 changes for 22 shots (the player was hit five times).

Checked and rejected along the way:

- **The "rare abrupt changes" criterion** catches the killfeed, editing overlays and the scene.
- **The "small vocabulary + repeatability" criterion** (`eval/findAmmoByStructure.mjs`) separates
  digits from the scene well, but ammo from health not at all. An "agreement with audio"
  multiplier doesn't save it: hits on the player also make a sound and land in the audio candidates.
- **Reading the digits themselves** (`eval/ammoDigits.mjs`, `eval/digitCycle.mjs`). The idea: the
  units digit cycles through 10 glyphs in an unchanging cyclic order, which would give both the
  search and the reading of a drop by 2 at once. The clustering didn't work out — groups came out
  as 429, 122, ..., 1 instead of roughly equal, the cycle of ten didn't close. Three causes were
  checked and rejected: binarization (grayscale didn't help), ink stretching (per-cell
  normalization didn't help), the clustering threshold. At the same time COUNTING worked: 34
  stable-state changes for 33 shots.

### What worked: anchoring to the motion detector

`eval/ammoByMotion.mjs`. Ammo decreases on a SHOT, health on DAMAGE — so the right readout can only
be picked with an already working shot detector. There is one: camera and weapon motion, AUC 0.910.

The anchor comes from its predictions, not from audio, and the check goes BOTH ways: changes must
fall on shots AND shots must be accompanied by changes. Health passes the first (damage often
coincides with a firefight) and fails the second.

Result: **8 clips of 33 with a score ≥ 0.6, median ratio of changes to real shots 1.00**
(before: 5 for 22 and 33 for 1). The gain in the edit metric has NOT BEEN MEASURED — that's an
open step.

Conclusion: the counter doesn't replace the system, it builds on top of it. The statement "where
the counter exists, it covers 100% of shots" is right in substance, but it can only be reached
through motion.

### Reserve ammo as a slot-selection feature — closed

The reserve number to the right of the magazine is readable (glyph threshold 0.006 and neighbour
threshold 0.28), but it doesn't pay off in slot selection: the "magazine + reserve" pair invariant
was confirmed on 3 clips of 20, and none of them needed it; `ssg08`, the reason this was started,
isn't fixed — there are no reloads, so there is nothing to preserve the sum. The metric matched
the baseline to a tenth (F1 80.7), the video pass is 1.72 times more expensive. Not shipped.

## Camera motion — the best signal found

The main result. Audio, after a dozen attempts and a trained convolutional network, gives
**1.00x** in the amount of manual editing, i.e. parity with labeling from scratch — the model is
useless. Camera motion gives **2.13x**.

| rule | AUC | w=1.0 | w=0.5 | w=0.3 |
|---|---|---|---|---|
| audio only (ShotNet) | 0.726 | 1.00x | 1.13x | 1.54x |
| reference-template hint | — | 1.16x | 1.26x | 1.46x |
| motion, intervals | 0.886 | 1.64x | 1.99x | 2.35x |
| + spectrum | 0.897 | 1.63x | 2.05x | 2.51x |
| **+ zones, + audio** | **0.902** | **1.65x** | **2.13x** | **2.61x** |

`w` is the cost of deleting a spurious mark relative to finding a missed one. The number is how
many times less manual work there is than labeling from scratch.

### Why it worked specifically on intervals

Adding motion to audio per frame gave nothing (1.15x → 1.16x): on a single frame a sub-pixel jolt
drowns in the jitter of the estimate itself. A 200–500 ms window averages a dozen frames, and the
characteristic shake emerges above the noise.

Key findings along the way:

- **The weapon zone shift came out exactly 0** in all clips, and from this it was concluded that
  the weapon model is stationary relative to the frame. The conclusion is WRONG, it was a method
  error — breakdown below, in the section "The weapon model's own motion". Camera motion still has
  to be measured on the scene.
- **There is no impulse at the moment of the shot** — the profile at labeled points is flat (+0.5
  over the whole window with a spread of 3.0). A distinct jolt is visible only on SINGLE shots
  (peak at frames +1..+2), and they are 5% of the dataset. In a burst the camera shakes
  continuously, and there is no "before/after".
- **The best single feature is the sign-change rate** (0.774 vs enemy fire, 0.775 vs lull). The
  camera is pushed up, the player compensates down, and so on every shot. Amplitude features don't
  distinguish ENEMY fire: there the player also moves the mouse around.

### What turned out not to be what it seemed

**The spectrum doesn't capture the weapon's fire rate.** The hypothesis was that the camera
oscillates at the firing frequency (AK 10 Hz, M4A4 11.1, P90 14.3). Then a long window (more
precise frequency) and narrow bands (a narrower peak) would help. Neither helps:

| window | AUC (4 bands) |
|---|---|
| 8 frames (0.3 s) | 0.805 |
| 16 (0.5 s) | 0.848 |
| 32 (1.1 s) | 0.849 |
| 64 (2.1 s) | 0.824 |

Four bands are enough, the window optimum is 0.5–1 s. So what is measured is the roughness of
motion over a short span, not periodicity.

**60 fps is no better than 30.** This was checked as a diagnostic: weapon fire rates sit right at
the limit of what's resolvable at 30 fps (15 Hz), and the frequency headroom should have helped.
On 60-frame clips quality is LOWER (0.838 vs 0.857) — i.e. the feature isn't limited by frame rate.

**Zone disagreement adds almost nothing.** A 3×3 grid with a separate shift per zone: top/bottom
disagreement alone gives 0.813, but on top of per-zone motion — zero (0.887 → 0.887). There is
signal there, but it is already contained in per-zone motion.

### Running

```bash
node eval/motionHiRes.mjs              # sub-pixel motion, ~25 min
node eval/zoneMotion.mjs               # per-zone motion 3x3, ~30 min
node eval/audioPlusIntervals.mjs --hires
node eval/zoneFeatures.mjs
node eval/spectrumSweep.mjs --bands=4  # window length breakdown
node eval/checkMotionFeatures.mjs      # reconcile the prod extractor with the caches, ~4 min
node eval/motionCost.mjs               # what motion computation costs, ~3 min
node eval/workingPoint.mjs             # mark composition at the working point, ~40 s
node eval/videoStage.mjs               # what reaches video and how it copes
node eval/flashPlusWeapon.mjs          # flash on top of the model (closed)
node eval/contextAndCalibration.mjs    # burst rate and per-clip calibration
node eval/nonlinearMotion.mjs          # linear model vs network, ~8 min
node eval/sprayPattern.mjs             # accumulated trajectory per burst, by weapon
node eval/driftFeatures.mjs            # drift features on top of the model (closed)
node eval/perWeaponModel.mjs           # shared model vs a narrow AK one (closed)
```

### The weapon model's own motion

A separate signal, independent of camera motion. The physics: the camera is fixed to the player's
head and does NOT jerk on a shot (unlike mouse movement), while the weapon model goes up and
slightly back, into the player.

| features | AUC | w=1.0 | w=0.5 | w=0.3 |
|---|---|---|---|---|
| audio | 0.726 | 1.00x | 1.13x | 1.54x |
| weapon (trajectory shape) | 0.842 | 1.57x | 1.81x | 2.08x |
| camera | 0.887 | 1.62x | 1.97x | 2.40x |
| camera + audio | 0.902 | 1.66x | 2.14x | 2.59x |
| **camera + weapon + audio** | **0.910** | **1.75x** | **2.20x** | **2.65x** |

Two mistakes on which this direction broke twice.

**The zone shift is not weapon motion.** The first measurement gave exactly 0.000 in all clips, and
it was concluded that "the weapon doesn't move relative to the frame". The error is in the method:
block search finds the DOMINANT shift of the zone, and the zone is dominated by the background
around the model. Only the pixels of the weapon mask should be counted.

**The weapon mask is not "the most stable".** The second attempt gave zeros again: in vertical
crops the black bars are ABSOLUTELY still and win such a selection. The weapon is MODERATELY
stable — the bars don't change at all, the scene changes a lot, the weapon is in between.
Selection uses a variability band between p10 and p45, plus the largest connected region.

Also, the frame band can't be a constant: the playfield is found through the motion zones (where
there is no motion, there is no gameplay), and the weapon lies in its lower half.

### IMPORTANT: the "weapon" mask is not on the weapon

Checked by eye for the first time (`scratchpad/maskDump.mjs` — a dump of the band with the mask
highlighted), eight clips. The mask that `weaponMotionAll.mjs` builds from the p10..p45 variability
band and the largest connected region lands:

- on the **streamer's webcam** (`deagle`, `galil`, `p2000` — the bottom of the frame is the
  player's face);
- on **smoke and a wall** (`ak47`, `kyousuke`, `aug`);
- on **editing text overlays** (`kyousuke`, the ELO caption);
- on the weapon — only partially and only in some clips (`m4a4`, `negev`).

Consequences that have to be accepted in full:

1. **The 22 `weapon.*` features in the model don't measure the weapon**, but the motion of an
   arbitrary moderately stable region. The gain they measured (0.902 → 0.910) is REAL — the weights
   were trained on these numbers and work — but the explanation "the camera doesn't jerk, the
   weapon model moves" doesn't apply to them.
2. The "Walking vs firing" section below describes the same series. Its numbers are measurements
   and remain valid, but the interpretation "the weapon moves more when walking" is not supported
   by anything.
3. The ideas "residual after compensation" and "deviation from the resting view"
   (`weaponResidual.mjs`) were tested ON THIS SAME region and gave zero. That doesn't close them:
   they were tested on smoke and a webcam, not on the weapon.

This is the third instance of the same mistake in this place: first "the zone shift is weapon
motion", then "the mask is the most stable part", now "the variability mask is the weapon".
The general lesson: **a region found by a heuristic must be looked at by eye once**, rather than
judged by the fact that features on it give a gain.

#### Weapon region summary: the signal is real, but it fixes the wrong bottleneck

In short, so the breakdown below needn't be reread. A human labeled the weapon region on 15 clips
(`eval/weaponRegions.json`), and the residual in it really does distinguish own shots from enemy
ones better than the whole current model — **0.840 vs 0.808 on the same clips**
(`eval/compareOnLabeled.mjs`). They err in different places: on shotguns the model drops below a
coin flip (0.441 and 0.528), while the residual handles them confidently (0.912 and 0.977).

**But in the edit metric it gives nothing** (`eval/combineWeaponResid.mjs`, 5 permutations):

| set | AUC | w=1.0 | w=0.5 | wins |
|---|---|---|---|---|
| residual alone | 0.686 | 1.00x | 1.01x | — |
| motion + audio | 0.858 | 1.35x | **1.61x** | — |
| + region residual | 0.861 | 1.34x | 1.59x | **0 of 5** |

The reason is the same one measured before, repeating for the third time: **"own vs enemy" is
10% of the task.** 66.9% of the candidate pool are not shots at all, and noise determines the
outcome. A feature that is strong precisely on enemy shots moves a tenth of the errors and drowns
in the rest.

Worth remembering as a rule for selecting ideas: before investing in a feature, look at WHAT share
of errors it addresses, not only at how well it discriminates them.

#### Human-labeled weapon region: the signal is there, and strong

`eval/weaponRegions.json` (reference from the client), `eval/weaponShotSignal.mjs`, `eval/weaponShotEval.mjs`.

The automatic region search was never finished, so a human labeled the regions on five AK-47 clips.
Per-frame series inside the region were computed on them: frame difference, share of bright pixels,
and the RESIDUAL after compensating with the best shift (barrel rotation isn't explained by a shift,
and what isn't explained settles in the residual).

| feature | AUC "shot frame vs lull" |
|---|---|
| **residual after compensation** | **0.884** |
| frame difference | 0.857 |
| share of bright pixels (flash) | 0.664 |
| brightness gain over background | 0.492 |

The same residual on the OLD region (variability band) gave nothing: a flat profile, difference from
background −0.01. The problem wasn't the feature but that it wasn't measuring the weapon.

This isn't the main number. The video stage is needed to tell own shots from ENEMY ones, and here
the residual performs surprisingly well:

| | AUC own vs enemy |
|---|---|
| audio (ShotNet confidence) | 0.546 |
| the whole current model, 74 features | 0.910 |
| **residual over the weapon region, one scalar** | **0.949** |

Per clip: 0.997, 0.990, 1.000, 0.810 (the fifth clip has no enemy shots). The physics is simple: an
enemy shot doesn't jerk MY weapon. Measured on five clips, too early to extrapolate to the full set.

At a threshold that yields about 80% of own shots, 71% is found (per clip 53–90%) with 0.97 spurious
per own shot. That's worse than the full model (0.52 spurious at 73.5%), but it's one scalar vs 74
features.

**The spurious triggers were examined and turned out to be events, not noise.** On `ak47` three in a
row at 15.99/16.12/16.22 s came exactly at the AK's rate and looked like a burst. The ammo counter
showed 11 → 10 by 15.9 s, and after that there is NO counter AT ALL. On the frame: "3DMAX WINS THE
ROUND", the round ended, the player pulled out a KNIFE. So the residual came not from a shot but
from a weapon switch.

This suggested a feature: for a shot the change is TRANSIENT — the weapon view returns within
100 ms, while for a weapon switch the resting view changes FOR GOOD.

**Checked twice, doesn't carry over to the metric** (`eval/weaponTransient.mjs`,
`eval/weaponSwitchVeto.mjs`).

The first attempt compared frame f−3 with f+3 and failed for a crude reason: three frames at 30 fps
is exactly the AK's cycle, and the shot was compared with the NEIGHBOURING shots of the burst. Real
shots got the same score as the knife. AUC vs enemy fell 0.949 → 0.855.

The second compared the median view over one second before and one second after, with a 200 ms
gap — a scale at which a burst fits entirely. The mechanism was confirmed: on `ak47` the weapon
switch and the round end give a view shift of 47–56 vs 26–44 for own shots, and the veto cut the
spurious 0.33 → 0.10 at the same recall.

But this gain turned out to be the result of peeking: the veto threshold was taken as 1.5 medians
over OWN shots, i.e. from the labels. With an honest threshold (median over all candidates in the
clip) and comparing at EQUAL recall of 70%, the gain disappears: spurious 0.83 vs 0.91, i.e.
slightly worse. On a broad candidate set the median view shift of misses (19.1) turns out LOWER
than that of own shots (31.4), and the threshold starts cutting own shots.

The conclusion worth remembering: the view shift separates not "miss from shot" but one specific
kind of miss — a weapon switch or an edit cut — from everything else. As a veto with a relative
threshold it doesn't work; if pursued further, then as a FEATURE among others, not as a filter.

#### Finding the viewmodel by "doesn't move with the camera" — started, `eval/findViewmodel.mjs`

Status: **frame decomposition works, weapon extraction doesn't.**

What worked and was checked by eye on six clips: 16×16 blocks reliably split into "scene" (moves
with the camera) and "pinned to the screen" (stays put despite the motion). Blue on the picture
covers exactly the playfield, yellow — banners, HUD and the streamer's webcam. As a by-product this
gives **automatic detection of the game area**, which was listed as a separate open task: the field
is a connected region of scene blocks, and it isn't fooled by the webcam, unlike the earlier search
by rows with motion.

What didn't work: separating the weapon from EVERYTHING ELSE pinned to the screen INSIDE the field.
In broadcast clips the killfeed, player nicknames and plates hang there too, and by the criteria
"pinned + changing + textured" they are indistinguishable from the barrel. Between 0 and 41 blocks
are selected per clip, and some clips stay empty.

Four pitfalls this measurement stepped on (each cost a run):

1. **The median shift over blocks is not the scene shift.** There are two populations (pinned at
   zero and the scene), and the component-wise median lands BETWEEN them: on frame 14 of clip `ak47`
   there were 269 blocks at (0,0), the scene was around (4,−3), the median gave (0,−2) and zero
   matches with either. What's needed is the MODE of the joint distribution; it matched the
   independent `motionhr` measurement.
2. **The "scene" and "pinned" thresholds overlap at small shifts.** The same HUD block was counted
   both as pinned (0.9) and as scene (0.5). The hypothesis must be chosen exclusively: which is
   closer — zero or the scene shift.
3. **A strict zero selects only UI.** The viewmodel sways, so "shift exactly 0" gives banners and
   black bars, and the barrel drops out. A tolerance is needed plus filtering out "dead" blocks by
   per-frame block variability.
4. **Absolute motion thresholds don't transfer between clips.** In some the camera moves fast, in
   others slowly; with fixed thresholds four clips of six yielded not a single accepted frame. Frame
   selection is by within-clip percentiles, and from above too: on fast flicks the true shift goes
   beyond the search limit and the estimates turn into garbage.

How to find the viewmodel correctly: it is defined by **not moving with the camera**. When turning
with the mouse the scene slides away, while the weapon stays in place in frame coordinates. So one
should take frames with a noticeable global shift (already computed in `.cache/motionhr`) and look
for pixels whose local shift is close to zero. Such a feature depends neither on the hand (the weapon
can be in the left one), nor on frame cropping, nor on brightness.

### Walking vs firing: shape discriminates, not amplitude

The weapon moves when walking too, and this nearly buried the feature. By amplitude the modes don't
separate at all:

| feature | AUC firing vs walking |
|---|---|
| \|dy\| | 0.430 |
| \|dx\| | 0.245 |
| axis ratio | 0.540 |

Values BELOW 0.5 mean the weapon moves more when walking. Amplitude distinguishes "the player is
doing something" from "standing still", not firing from walking.

The difference is in the trajectory shape:

| mode | 0–3 Hz | 3–8 Hz | 8–16 Hz | jaggedness |
|---|---|---|---|---|
| firing | 0.129 | 0.147 | **0.432** | **2.21** |
| walking | **0.539** | 0.230 | 0.131 | 1.22 |

Walking has more than half its energy below 3 Hz — a smooth sway. Firing has 43% in the 8–16 Hz
band, i.e. at the weapon's fire rate, and twice the jaggedness: recoil is a jerk.

| shape feature | AUC firing vs walking |
|---|---|
| vertical jaggedness | **0.764** |
| vertical 8–16 Hz share | 0.744 |
| 0–3 Hz share | **0.169** (inverse feature) |

From 0.430 by amplitude to 0.764 by shape. The vertical sign also diverges: when firing the weapon
goes up (dy +0.10…+0.45), when stepping — down (−0.40…−0.74).

### What reaches the video stage and how it copes

`eval/videoStage.mjs`. At threshold 0.3 audio emits 4840 candidates:

| | count | share of pool |
|---|---|---|
| own shots | 1103 | 22.8% (94.8% of all own — the ceiling) |
| enemy shots | 497 | 10.3% |
| not shots | 3240 | 66.9% |

Each own shot comes with 3.4 spurious candidates. Separation by class, separately
(5 folds, grouped by clip):

| features | own/enemy | own/noise | own/all | 30 fps | 60 fps |
|---|---|---|---|---|---|
| video (73) | 0.910 | 0.895 | 0.897 | 0.906 | 0.880 |
| audio (confidence) | 0.546 | 0.753 | 0.726 | 0.724 | 0.727 |
| video + audio (74) | 0.910 | 0.910 | 0.910 | 0.915 | 0.906 |

Three conclusions:

1. **The video stage is equally strong at both tasks.** It was expected that "own vs enemy" would
   come easily and "shot vs noise" would be hard — no, 0.910 and 0.895. And it removes both at the
   same pace: keeping 90% of own shots removes 70% of enemy shots and 70% of noise.
2. **Audio is useless against enemy shots** (0.546, nearly a coin flip) and weak against noise
   (0.753). It adds to video only on noise, 0.895 → 0.910.
3. **Frame rate doesn't matter** (0.915 vs 0.906), which confirms the earlier conclusion on
   motion — unlike the flash, which didn't work without 60 fps.

Operating curve:

| own kept | enemy removed | noise removed | spurious per shot |
|---|---|---|---|
| 95% | 56% | 58% | 1.51 |
| 90% | 70% | 70% | 1.12 |
| 80% | 86% | 86% | 0.61 |
| 70% | 92% | 92% | 0.39 |

### What was tried on top of the video stage

**The flash adds nothing** (`eval/flashPlusWeapon.mjs`). Previously it was measured on top of
CAMERA motion (`finalCombine.mjs`: 0.905 vs 0.902, the gain even lower — 2.11x vs 2.14x), but back
then there was no weapon motion, and there were two flash features from one zone.
Checked on top of the full 74 features and in three levels of richness:

| set | features | AUC | AUC 60fps | w=1.0 | w=0.5 |
|---|---|---|---|---|---|
| flash alone, minimal | 2 | 0.666 | 0.653 | 1.00x | 1.09x |
| flash alone, all 36 zones | 74 | 0.695 | 0.771 | 1.00x | 1.19x |
| **motion + audio** | 74 | **0.910** | 0.906 | **1.75x** | **2.20x** |
| + flash minimal | 76 | 0.911 | 0.905 | 1.77x | 2.17x |
| + flash over all zones | 148 | 0.903 | 0.886 | 1.66x | 2.10x |
| + zone brightness from the motion cache | 92 | 0.904 | 0.892 | 1.74x | 2.12x |
| + everything together | 168 | 0.898 | 0.879 | 1.65x | 2.06x |

The flash has signal (alone it gives 0.771 at 60 fps vs 0.653 overall), but on top of motion it is
redundant, and the rich variants plainly dilute. The direction is closed.

**Calibrating the score within a clip hurts badly** (`eval/contextAndCalibration.mjs`).
The hypothesis came from the gap between overall recall (73.5%) and per-clip recall (54.4%): as if
some clips fall under the threshold entirely. Both corrections wreck quality:

| correction | AUC | w=1.0 | w=0.5 |
|---|---|---|---|
| none | 0.910 | 1.75x | 2.20x |
| subtract mean, divide by SD | 0.792 | 1.06x | 1.36x |
| rank within clip | 0.769 | 1.06x | 1.29x |

The reason is clear in hindsight and worth remembering: **clips genuinely differ in fire density.**
Where there are a hundred shots, a candidate is more likely a shot; where there are five, more
likely noise. The absolute score level carries this information, and within-clip normalization
erases it, imposing the same distribution on every clip.

**Burst context helps a little, but consistently.** Nine features from the candidate set itself
(intervals to neighbours, their confidence, whether the interval falls within the weapon's rate
of 70–140 ms, density in 0.15/0.5/2 s windows). No new data is needed:

| set | AUC | w=1.0 | w=0.5 |
|---|---|---|---|
| motion + audio | 0.910 | 1.75x | 2.20x |
| + burst context | **0.918** | 1.77x | **2.25x** |

Averaged over FIVE permutations of clips across folds, and context wins on all five.
This matters: the spread between splits (2.13x…2.23x) is larger than the effect itself (+0.05x),
so comparisons can only be paired, on the same split.

Careful with fold splits: a shift of the form `(g + k) % FOLDS` does NOT change the partition, it
merely renames the folds — the numbers come out bit-for-bit identical, and that is easily mistaken
for stability. A permutation of clips is needed.

**Time resolution within the window adds nothing and takes away**
(`eval/rawVsAggregated.mjs`). Checked as reconnaissance before a two-branch "audio plus motion"
network: the hypothesis was that ±250 ms summaries (mean absolute value, SD, sign changes) can't
express "a transient in the audio AND a motion jump in the same frame", because they contain no time.

| set | features | AUC | w=0.5 | wins of 3 |
|---|---|---|---|---|
| **summaries, as now** | 74 | **0.911** | **2.20x** | — |
| same statistics per third of the window | 181 | 0.901 | 2.05x | 0 |
| raw series, 20 channels x 15 samples | 301 | 0.692 | 1.09x | 0 |
| summaries + raw | 375 | 0.889 | 1.98x | 0 |

The drop is MONOTONIC in the amount of resolution: no time 2.20x, coarse 2.05x, full 1.09x.

The key to the interpretation is the middle row. The raw series could have lost simply because of
dimensionality and lack of shift invariance (marks wander by ±18.4 ms, i.e. up to a frame). But the
"three windows" variant doesn't suffer from this: it has the same shift-robust statistics, only 181
features, and adds only a coarse split of the window into thirds. It lost too.

So the issue is not that a linear model can't use time, but that there simply is no useful time
information within the window. This is exactly the conclusion obtained earlier and reproduced here
at three resolutions: adding motion to audio per frame gave nothing (1.15x vs 1.16x), and things
only started working on 200-500 ms windows, where the estimate jitter averages out.

What this means for the two-branch network: its main motive — "seeing motion coincide with audio at
a specific moment" — is not confirmed. The network might learn something else, e.g. the shape of a
300-500 ms transient, but the burden of proof is now on it.

**A nonlinear model is worse than a linear one, and the bigger it is, the worse** (`eval/nonlinearMotion.mjs`).
The hypothesis carried weight: the main gain in the project came from changing the MODEL, not the
features (a linear model on a mel patch 11.5% precision vs 36.3% for the convolution), and the
conclusion "capacity doesn't matter" concerned ShotNet on audio and was never checked on motion
features.

| model | AUC | w=1.0 | w=0.5 | splits won |
|---|---|---|---|---|
| **logistic (current)** | **0.918** | **1.77x** | **2.27x** | — |
| network, 8 neurons | 0.897 | 1.65x | 2.00x | 0 of 3 |
| network, 24 neurons | 0.888 | 1.59x | 1.95x | 0 of 3 |
| network, 48 neurons | 0.876 | 1.48x | 1.81x | 0 of 3 |

One hidden layer, ReLU, full batch, Adam, 200 iterations. The degradation is MONOTONIC in capacity
and identical on all splits — this is not spread but overfitting to the quirks of specific clips.
With 49 clips even eight neurons are already too much capacity.

It was checked that this isn't underfitting: **at 800 iterations the network doesn't catch up, it
falls further behind** — 8 neurons give 0.866 and 1.73x vs 0.897 and 2.00x at two hundred. So 200
iterations acted as early stopping, and the longer the network trains, the worse it transfers to
held-out clips. The limit is the data, not the model class and not the training budget.
The same conclusion was previously obtained for ShotNet on audio; now it's confirmed on motion too.

This also explains why bolt-on features (flash, brightness) gave nothing: it isn't that the linear
model can't combine them.

### Recoil pattern: the signal is there, it doesn't carry over to discrimination

`eval/sprayPattern.mjs`, `eval/driftFeatures.mjs`, `eval/perWeaponModel.mjs`.

The idea came from game mechanics: spread in CS2 is DETERMINISTIC, each weapon has its own rate and
its own drift curve. Everything measured so far looked at a ±250 ms window around a single shot,
while the pattern unfolds over the whole burst — i.e. over a span of seconds.

**The firing signature exists and it is strong.** Accumulated scene shift from the first shot of a
burst (`motionhr` cache, 640×224, sub-pixel), AK-47, 15 bursts of 5 shots and longer:

| shot in burst | horizontal | vertical |
|---|---|---|
| 2 | −3.6 ± 1.9 | +0.2 ± 0.7 |
| 4 | −4.2 ± 2.4 | +5.4 ± 2.0 |
| 6 | −4.8 ± 6.1 | +11.8 ± 3.1 |
| 8 | −7.0 ± 8.0 | +17.4 ± 3.9 |
| 12 | −23.1 ± 7.2 | +25.5 ± 4.6 |

Control on non-firing spans of the same length: **+0.13 ± 1.35** vertically, i.e. zero.
This is not general mouse movement but specifically firing.

**Vertically the signature is stable, horizontally it isn't.** The accumulation by the 6th shot is
positive in ALL seven AK clips (+6.5 … +42.5), while the horizontal changes sign from clip to clip
(−28 … +36): it is swamped by where the player moves the crosshair. So the "left, then right" of the
real AK pattern can't be recovered from this data.

**It doesn't carry over to discrimination.** 22 drift features (net displacement, straightness,
longest jerk over ±0.5/1/2 s windows, asymmetry before and after the shot):

| set | AUC | w=0.5 | splits won |
|---|---|---|---|
| motion + audio | 0.912 | 2.20x | — |
| + burst context | 0.919 | **2.25x** | 5 of 5 |
| + drift | 0.912 | 2.17x | 0 of 5 |
| drift alone | 0.593 | 1.00x | — |

The reason is clear from the problem statement: drift separates "firing is going on" from "silence",
while the model needs to separate an own shot from NEIGHBOURING CANDIDATES in the same firefight —
and they have exactly the same drift. It is a property of the second around the candidate, not of
the candidate itself.

**A separate per-weapon model loses.** The AK-47 is the only weapon where this can be measured: 209
own shots in 6 clips; the next most frequent, m4a1s, gives 88 in 4 clips. One held-out clip at a
time, the shared model trains on all other clips, the narrow one only on the other AK clips:

| | AUC | gain w=0.5 |
|---|---|---|
| shared model | **0.929** | **3.71x** |
| AK only | 0.884 | 2.57x |

The narrow model didn't win on A SINGLE one of the six clips. The training set drops from 43 clips
to five, and data is exactly what everything hinges on (see the nonlinear model above).

As a side note: on AK clips the shared model works noticeably better than the set average
(3.71x vs 2.20x). Dense own fire is easier to sort out than sparse.

What stays alive from this idea: not features and not separate models, but **analysing the burst as
a whole** — choosing a consistent SUBSET of candidates that keeps the weapon's rate and accumulates
drift monotonically. The closest thing to this now is the nine context features, and they gave the
only consistent plus of all the recent attempts.

### Human-pointed ammo counter: a modest gain, not a change of class

`eval/ammoRegions.json` (regions from the client), `eval/ammoCheck.mjs`, `eval/ammoProduct.mjs`.

The automatic counter-region search failed fundamentally: health and armour are structurally
indistinguishable from ammo. A human's click removes exactly this ambiguity; the digit bounds are
then refined automatically by the frequency of bright pixels.

**Availability matters more than signal quality: the counter is visible in 5 clips of 12, readable
in 4.** In the rest the HUD is cropped out, covered by the streamer's webcam or (sniper rifle) not
shown in the scope.

As a feature it is strong: AUC vs background 0.980–0.999 on four clips.

**But in the product metric the gain is modest** (4 clips, 147 own shots):

| scheme | spurious per shot at 90% recall | at 80% | at 70% |
|---|---|---|---|
| audio only | 3.62 | 3.62 | 3.62 |
| audio + motion model | 1.59 | **0.73** | **0.27** |
| audio + counter | **1.28** | 1.08 | 1.02 |
| audio + motion + counter | 1.25 | 0.78 | 0.64 |

The counter beats the model ONLY at the high-recall point (1.28 vs 1.59), and at 80% and 70% loses by
two to four times. The reason is that it is almost binary: the threshold tightens, but spurious marks
barely decrease (1.28 → 1.08 → 1.02), while the model's smooth score trades recall for precision well.
And they do NOT add up with the counter: 1.25 vs 1.28.

**A correction to an earlier measurement, an important one.** `ammoCheck.mjs` showed "145 own shots of
145 produced a counter change", and that is true, but it was measured with a weak threshold: "the
value near the shot is above the 95th percentile of the background". If instead DISCRETE events are
extracted (a local peak above the 98th percentile with a gap), then an own shot gets its own event
in only 55–73% of cases:

| clip | own | events | of which on own |
|---|---|---|---|
| ak47 | 21 | 24 | 15 |
| kyousuke | 74 | 52 | 41 |
| xm1014 | 11 | 24 | 8 |
| sawedoff | 6 | 11 | 4 |

Inside a burst neighbouring digit changes merge, and a transition like 30→29 changes few pixels.
Hence the rule: **"the feature reacts to the event" and "the feature yields a separate event per
shot" are different claims, and it's the second that must be measured.**

### A reference from a single shot within the clip — doesn't work

`eval/oneShotTemplate.mjs`. The idea sidestepped the set's main problem: clips differ, and a model
trained on other clips works worse on a new one. A reference FROM THE SAME clip removes the
difference completely — same weapon, same player, same scene, same codec. At the cost of one user
action: clicking on one own shot.

45 clips, 4591 candidates, the reference was chosen in eight ways and the result averaged.

| scheme | spurious per shot at 90% recall | at 80% | at 70% |
|---|---|---|---|
| **shared model (across clips)** | **2.08** | **1.38** | 1.00 |
| reference: 74 summaries | 2.43 | 1.84 | 1.44 |
| reference: raw series | 2.75 | 2.37 | 2.06 |
| reference in a weighted metric | 2.38 | 1.74 | 1.34 |
| model + weighted reference | 2.00 | 1.38 | **0.97** |

The reason is the arithmetic of one example: it doesn't say WHICH features matter, and the distance
treats all 74 as equal, including the noisy ones. A metric weighted by the model's trained weights
helps (2.43 → 2.38), but doesn't reach the model. The combination gives a reproducible but tiny
2.08 → 2.00.

Along the way it was independently confirmed: raw series are worse than summaries here too
(2.75 vs 2.43).

What remained unchecked is training a tiny model PER CLIP: one positive example plus all other
candidates of the clip as approximate negatives. That is no longer a distance but adaptation.

### Session summary: the feature path on 49 clips is exhausted

Nine directions were checked in one session, and none gave more than +0.05x:

| direction | result |
|---|---|
| flash on top of the model | zero, rich variants −0.10x |
| within-clip calibration | −0.84x |
| nonlinear model | −0.27…−0.54x, monotonic in capacity |
| recoil pattern, drift features | −0.04x, 0 wins of 5 |
| separate per-weapon model (AK-47) | 0 wins of 6 clips |
| weapon-region residual | strong vs enemy (0.840 vs 0.808), zero in the edit metric |
| ammo counter | −20% spurious at one point, available in a third of clips |
| time resolution within the window | −0.15x for coarse, −1.11x for full |
| single-shot reference | −0.35x |
| **burst context** | **+0.05x**, the only consistent plus |

The conclusion is not "the task is unsolvable" but "features are no longer what moves it". What moves
it is either the volume of labels or the cost of an edit in the interface — the latter is measured
and gives 1.75x → 2.65x.

### Porting to production: what exactly was checked

`src/lib/detection/motionFeatures.ts` — a port of `eval/zoneMotion.mjs`, `eval/weaponMotionAll.mjs`
and the feature assembly from `eval/exportMotionModel.mjs`. Frames in, 74 features out, in the order
from `models/motionModel.json`. `assertMotionModel` aborts the run if the order diverges: a shuffled
order otherwise doesn't crash but silently degrades quality.

TWO passes over the video are needed, one won't do: the weapon band is found through the motion
zones, and those are known only after viewing the whole clip.

Reconciliation: `node eval/checkMotionFeatures.mjs`. Three stages, so that on a mismatch it's visible
which part diverged:

| stage | what is reconciled | max difference |
|---|---|---|
| A. feature assembly | cache → port vs cache → eval code, all 49 clips, 4840 candidates | 0.0 |
| B. motion | frames → port vs the `zoneMotion` and `weaponMotionAll` caches, 3 clips | 0.0 |
| C. end-to-end | frames → features → model score, 188 candidates | 0.0 |

**A trap that only measurement found: the motion cache is rounded to three decimals, and the model
was trained on ROUNDED series.** The first run matched the motion series themselves to 5e-4, but the
features diverged by up to 0.53 and the model score by up to 0.26 in probability. The cause: rounding
collapses sub-pixel noise into an EXACT zero, and sign changes are counted only over non-zero
values — and that is the strongest single feature (AUC 0.774). On clip `aug` without rounding there
are 20 exact zeros instead of 113. After rounding in `computeZoneMotion` everything reconciles to zero.

The same yields the requirement for the decoder in step 2: frames must be converted by
`sampleGrayFrame` (nearest neighbour plus integer Rec.601, as in `frametool`). Smoothing scaling gives
different pixels, and the weights were trained on these.

### Browser decoding vs the reference: reconciled on all 49 clips

The scripts live in the product repository: `pewpew/eval/decodeCheckPrep.ts` lays out the clips,
caches and candidates, the page `pewpew/eval/decodeCheck.html` computes. The computation has to run in
the browser: what's checked is exactly what Node lacks — WebCodecs.

The concern was that the model was trained on `frametool` frames (AVFoundation), while in production
frames come from mediabunny/WebCodecs, and those are different pixels. The pixels really are
different. The question wasn't about them, but whether the discrepancy survives to the DECISION.

How the reconciliation works: both branches — from the cache and from browser frames — run through
THE SAME code on the page, so the only difference between them is the pixel source. Candidates are
computed beforehand in Node, so that differences in audio decoding don't mix into the difference in
video decoding.

49 clips, 4808 candidates:

| | result |
|---|---|
| frames decoded | matched on 49 clips of 49 |
| playfield band | matched on 49 of 49 |
| weapon mask | median discrepancy 0.07%, one outlier — `p250`, 11116 px vs 8140 |
| model score correlation | median 0.9941, minimum 0.9096 (`the-last-kill`) |
| decision at threshold 0.5 | matched 98.2% (88 of 4808 diverged) |
| **product F1, threshold 0.5** | **browser 64.1 vs cache 64.3**, 1549 marks vs 1563 |
| **product F1, threshold 0.6** | **browser 66.1 vs cache 66.2**, 1301 marks vs 1314 |

The 0.2-point difference is noise, and that shows not by its size but by its SIGN: the browser branch
is better on 15 clips, worse on 15, equal on 19. Control: the cache branch reproduces the product
measurement's numbers EXACTLY (64.3 with 1563 marks, 66.2 with 1314), i.e. what's measured is
decoding, not a divergence between harnesses.

Two conclusions worth remembering.

**Raw pixel agreement predicts nothing.** The share of exactly matching `dx`/`dy` varies across clips
from 29% to 67%, and it has NO relation to the correlation of the final scores (r = −0.06). Summaries
over a ±250 ms window wash out per-frame discrepancy regardless of its size. This is the same
conclusion as in "Time resolution within the window", from the other side: there is no time within
the window, and so noise within the window doesn't matter either. Measure the decision, not the
series — on raw series the reconciliation would have looked failed.

**There is exactly one fragile spot — the weapon mask.** It is selected by a threshold over the p10..p45
variability band plus a fill of the largest connected region, and threshold-plus-fill can jump to a
different region: on `p250` the mask grew by 36%. It barely affected the decision (3 divergences of
120), but on any decoder change this is where to look, not at zone motion.

The clips with the largest divergence (`sawedoff` F1 11.8 vs 21.1, `the-last-kill` 0.0 vs 20.0) are
clips with 6 and 7 own shots, where the model finds one or two and all scores sit right at the
threshold. I.e. the same shotguns on which the model is below a coin flip anyway (AUC 0.441 and
0.528). One mark there moves F1 by 9 points, and such clips can't be used to judge decoding.

### Cost and place of execution

The current solution doesn't need a server — but that is a consequence, not a requirement.
The priority is a working tool (see "Priorities" at the start of the file): if quality demands a heavy
model or sending individual frames to a server, that is acceptable.

`eval/motionCost.mjs`, eight clips spread across length and frame rate, Node on a MacBook.
What's measured is exactly the code that goes to the browser — `src/lib/detection/motionFeatures.ts`:

| stage | per frame | median | spread across clips |
|---|---|---|---|
| camera zones 3×3 | 1.24 ms | 26.9× real time | 13.3–27.7× |
| weapon's own motion | 3.19 ms | 10.6× | 3.5–35.1× |
| assembling 74 features | — | 1–3 ms per whole clip | — |
| **motion in total** | **4.44 ms** | **7.6×** | **2.8–15.5×** |
| decoding, two passes (AVFoundation) | — | 14.8× | 9.7–19.6× |
| audio: spectrogram and network | — | 288× | — |

**A minute of video at 30 fps is about 8 s of compute plus 4 s of decoding, twice that at 60 fps.**

The earlier figure in this section (744 ms for a 28.7 s clip, 39×) doesn't apply to the current
solution: a 28.8 s clip takes 4.9 s, i.e. six times longer. How exactly it was obtained couldn't be
reconstructed — there was no script in the harness measuring the cost of motion (this one was written
now). Such an order of magnitude could at most come from the single-step estimator `motionHiRes.mjs`,
with one frame band and one shift per frame instead of nine zones and a weapon mask.

The spread is set not by clip length but by the SIZE OF THE WEAPON MASK: block search tries 169 shifts
over the mask pixels, and clips with a large mask cost five times more (4.76 ms per frame vs 0.95).
Zones meanwhile are stable, 1.2–1.3 ms per frame for any clip. If speed ever becomes important, it's
the weapon that needs optimizing, not the zones — but the priority now is a working tool.

Less than 100 KB is added to the bundle: ShotNet weights 72 KB plus the logistic regression
coefficients. No neural-network runtime is needed.

The only dependency is per-frame decoding: in the browser that's WebCodecs
(Chrome, Edge, Safari 16.4+, Firefox 130+). The fallback via seeking a `<video>` works everywhere,
but costs tens of milliseconds per frame.

### Production path

`src/lib/detection/detectShotsWithNet.ts` — samples in, shot times out: mel spectrogram, per-band
normalization, network, peak picking. A pure function, works the same in the browser and in Node.
A 39 s clip is processed in 136 ms (288× real time).

Normalization at inference must match training — otherwise the weights are meaningless, which is why
`normalizePerBand` is called internally both in eval and in production.

---

## Viewmodel recoil: a per-frame oracle from the counter

August 27, 2026. `python/tools/recoil_probe.py`, `recoil_report.py`, `recoil_curve.py`,
`recoil_gate.py`.

The idea was that the ammo counter won not through signal quality but through its MODE: it doesn't
filter audio candidates, it generates events itself. Hence the question — can the same be done with
weapon motion, thereby covering clips without a HUD.

There is now something to check this with. Previously all recoil measurements were against MANUAL
marks, which wander by half a frame; now there are 399 shots on 16 clips whose frame is known exactly
and was set not by hand but by the counter. Scoped weapons are excluded: in the scope there is no
viewmodel at all.

The region is a human-labeled box (`eval/weaponRegions.json`), downscaled to 192×96 and split into
6×3 sub-blocks. For each pair of frames an integer shift per sub-block (±6) is searched, and the
affine components are computed from the field.

### Arc and pull into the player: rejected by measurement

The hypothesis was that the shift of the region as a whole is unsuitable by construction — the weapon
pulling into the player is SCALE, the arc is ROTATION around a point near the hands, and the
projection of both onto a shift is small and partly cancels itself.

| quantity | AUC shot frame vs lull | AUC own candidate vs the rest |
|---|---|---|
| **frame difference in the box** | **0.951** | **0.781** |
| difference without global brightness | 0.948 | 0.781 |
| residual after the best shift | 0.940 | 0.776 |
| field spread across sub-blocks | 0.867 | 0.603 |
| residual after affine fit | 0.863 | 0.619 |
| magnitude of the region shift | 0.826 | 0.608 |
| brightness rise (flash) | 0.726 | 0.521 |
| **curl (arc)** | **0.575** | 0.505 |
| **divergence (into the player)** | **0.495** | 0.558 |
| audio (ShotNet confidence) | — | 0.723 |

Divergence and curl are at coin-flip level. And this is NOT a resolution artifact: the median field
spread is 2.26 px, |div| median 1.21, an exactly zero field on only 8.3% of frames. The measurement
could have seen them, they are simply noisy — block search over a 32×32 sub-block on a low-contrast
weapon gives an estimate in which the affine components drown.

As a side effect a long-standing question is closed: **it is motion, not the flash.** Removing the
global brightness level costs 0.003 (0.951 vs 0.948), and brightness itself discriminates nothing on
candidates (0.521).

### Motion doesn't work as an event generator — and that's the main point

AUC 0.951 looks like a win right up until it's converted to a working point. There are 399 shot
frames and 9175 lull frames, and with such an imbalance even 0.95 doesn't make a detector:

| recall | precision | spurious events per shot |
|---|---|---|
| 20.1% | 33.9% | 1.95 |
| 34.6% | 29.3% | 2.41 |
| 51.4% | 21.7% | 3.60 |
| 62.2% | 14.0% | 6.13 |

Against the counter's 78.4 recall and 80.0 precision this is neither a competitor nor a help.

Hence the explanation of why the counter worked and motion didn't, and it's not about signal quality.
**The counter is a discrete SYMBOL**: the value changes by exactly one, and an event either happens or
it doesn't. Motion is a continuous score that has to beat a negative class twenty-three times more
numerous; 0.95 is not enough for that, it takes about 0.999.

### What remained true

- **As a filter motion works and beats audio**: one scalar 0.781 vs 0.723.
  But the residual over the human box was already run through `eval/weaponRegionGain.ts` — 0 wins
  of 5, and there's no point repeating it: the quantities are almost the same.
- **The production region is fine, and this needed checking.** The top 12 blocks of the trainable
  classifier vs the human box: median IoU 0.437, a median 67% of blocks on the weapon, more than half
  the blocks on the weapon in 37 clips of 46, no block on the weapon in only 2. The old heuristic gave
  0.065 and a miss on 31 clips of 46. The same mistake didn't happen a fourth time.
  The numbers 0.065 and 31/46 hard-coded into the output of `eval/viewmodelEval.ts` refer to the OLD
  heuristic; there is no live measurement of the product region there — don't take them for one.
- **Candidate merging on counter clips is lower than across the corpus**: 37 shots of 399 (9.3%)
  share a candidate with a neighbour.
- A side observation, not checked in the metric: in the four frames BEFORE a shot the weapon region
  is unusually still (shift magnitude 3.6–5.9 spreads below the lull median). This is an "the player
  is aiming" feature, not "a shot happened", and by family it's closer to the burst context — the
  only thing that ever gave a consistent plus.

### Reading motion on candidates: the direction is NOT closed, the conclusion above was hasty

Same day. `python/tools/field_probe.py`, `field_series.py`, `field_model.py`.

The previous section's conclusion "motion doesn't work as an event generator" is correct, but it
answers a question the product doesn't pose: candidates come from audio, and the class imbalance
there is not 1 to 23 but 1 to 4.4. The 0.781 measured with one crude scalar from ONE frame at 0.4x
downscaling was not the ceiling of reading but its absence.

What was done differently: a 320×160 box instead of 192×96, an 8×4 grid, sub-pixel refinement with a
parabola over the SAD surface, the field is kept whole (frames × blocks × 4) and features are computed
from a ±3-frame WINDOW, not from a single frame. Plus the field relative to scene motion — the
viewmodel is defined by not moving with the camera.

**Resolution and sub-pixel gave almost nothing** (diff 0.781 → 0.794, div 0.558 → 0.556,
curl 0.505 → 0.511). The affine components are dead for good: checked twice, at two resolutions,
with and without sub-pixel.

**The window and the set of series did.** Logistic regression, folds by clip, AUC within fold:

| set | features | human box | product box |
|---|---|---|---|
| audio alone | 1 | 0.688 | 0.688 |
| frame difference, one frame | 1 | 0.768 | 0.706 |
| frame difference, ±3 window | 11 | 0.777 | 0.724 |
| audio + difference, window | 12 | 0.813 | 0.773 |
| motion without audio | 143 | 0.832 | 0.814 |
| **motion + audio** | 144 | **0.855** | **0.839** |
| motion + audio, without affine | 122 | 0.846 | **0.846** |

The right column is a transfer check: the box is not the human one but the bounding rectangle of the
classifier's twelve blocks, i.e. what's actually available to the product. The loss is 0.016, and
without the affine features there is none at all.

More strictly, one held-out clip at a time with AUC WITHIN the clip (product box):

| | median | mean | worst clip |
|---|---|---|---|
| audio | 0.653 | 0.636 | 0.315 |
| **motion + audio** | **0.838** | 0.797 | **0.626** |

Motion beats audio on 11 clips of 15. The worst case rises from 0.315 to 0.626 — that's directly about
robustness on unfamiliar material.

**What these numbers must NOT be used to claim.** They aren't comparable with the current model's
0.910: that's 49 clips, manual marks and a different candidate pool. A comparison with the product
model on the same material is the next step, and until then no gain is claimed.

#### Two measurement mistakes, both looked convincing

1. **A series must not be normalized by the candidate's neighbourhood.** A ±12-frame ring in a
   firefight contains OTHER shots: the background rises exactly where the shot is. On the `diff`
   series: raw 0.794, per clip 0.694, per neighbourhood 0.572 — the harm is monotonic in locality.
2. **Scores from different folds must not be pooled** — they are calibrated differently. For one
   feature this gave 0.361 where the true value was 0.612. Compute AUC within the fold.

Plus a bug that nearly led to a wrong conclusion: the output directory was passed to the pool processes
via a module variable, and on macOS they start fresh and don't inherit it — the `--auto` run wrote
the product-box fields OVER the human ones. It was noticeable only because a single feature's AUC
changed, which a regularization change couldn't have caused.

#### Comparison with the shipped model: it already reads motion no worse

`eval/motionScores.html` (the whole product path, a score for every candidate),
`python/tools/vs_product.py`.

The numbers of the previous section were compared against AUDIO, and that was the wrong baseline: the
second stage is already in the product and already does this job. A measurement on the same material —
the same 15 clips, the same 1826 candidates, the same per-frame counter labels, leave-one-clip-out
training and AUC WITHIN the clip:

| set | median | mean | worst clip |
|---|---|---|---|
| audio alone | 0.653 | 0.636 | 0.315 |
| **shipped model** | **0.847** | 0.799 | 0.486 |
| Python field reading | 0.838 | 0.797 | **0.626** |
| **shipped + Python** | **0.871** | **0.839** | **0.652** |

Python does NOT beat the shipped model: 0.838 vs 0.847, 7 wins of 15. The claim "audio 0.688 → 0.839"
is arithmetically correct and useless in substance: the product moved away from audio long ago.

**But the features turned out to be COMPLEMENTARY.** On top of the product score: 0.847 → 0.871 median,
0.799 → 0.839 mean, 9 wins of 15. And the worst clip rises from 0.486 to 0.652 — i.e. the gain goes
where the product is currently worst. The comparison is generous to the product, too: its weights were
trained on all clips, including these, while the Python features are checked with leave-one-clip-out
training.

Per clip it's visible that they err in different places: `donk-5100` product 0.581 vs Python 0.876,
`xm1014` 0.525 vs 0.683, `m249` 0.486 vs 0.626 — and the other way round `mp5sd` 0.981 vs 0.756,
`bizon` 0.894 vs 0.678. That explains why the sum is better than the parts.

**What this must not be used to claim.** This is AUC, not the metric. By the project rule a gain counts
only after `pnpm exec tsx eval/trainMotionModel.ts` at equal recall.
The nine closed directions in the journal all had discriminative power and no gain in the metric.

#### Metric: field features rejected. The tenth closed direction

`eval/trainMotionModel.ts` (schemes P and F), `eval/motionScores.html`, `src/domain/detection/motion/weaponField.ts`.

The features were ported to TypeScript and computed by the PRODUCT code. Reconciliation of the two
implementations per clip: `diff` 0.999, `resid` 0.988, `spread` 0.980, `residAff` 0.969, frame count
matching frame for frame. The port is correct — the divergence from here on isn't in it.

Scheme F puts 66 field features on top of the product path's SCORE; the honest baseline P is the same
regression on that score alone (the technique from `eval/weaponRegionGain.ts`). Checked with 5 folds
by clip, 45 clips, 4544 candidates:

| scheme | F1 | AUC | AUC in clip | spurious at 90% | at 80% | at 70% |
|---|---|---|---|---|---|---|
| P — product score | 60.3 | **0.916** | 0.864 | **0.81** | 0.49 | **0.27** |
| F — P + field | 61.5 | 0.910 | 0.872 | 0.82 | 0.47 | 0.29 |

F1 rises by 1.2, and that is exactly the trap rule 2 is about: **at equal recall the curve doesn't
move**. Overall AUC even drops.

Only on counter clips, where the labels are per-frame and not set by hand:

| scheme | F1 | AUC | AUC in clip | spurious at 80% |
|---|---|---|---|---|
| P — product score | 63.4 | **0.933** | **0.894** | **0.30** |
| F — P + field | 64.2 | 0.925 | 0.883 | 0.35 |

Here, at equal recall, the features make things WORSE, and so on all five frame shifts.

**Alignment was checked and is not the cause.** The features were taken with shifts of −2…+2 frames:
spurious at 90% comes out 0.87 / 0.81 / 0.82 / 0.86 / 0.85 — there is no sharp optimum at zero.

**Why Python showed +0.044 and the metric shows nothing.** It's not the features that diverged but the
SETUP. In Python "own" is the candidate nearest to a counter event, one per event; in the metric it's
a hit on a labeled shot with a 50 ms tolerance. Because of this the baseline diverges too: 0.847 vs
0.894 on the same clips. The gain was against a weaker baseline under a different class definition.

A lesson to add to rule 2: **your own definition of the positive class is just as good a way to get a
non-existent gain as a fixed threshold.**

The series remain in the product code behind the `field` flag, off by default: the product doesn't pay
for them, and without them the measurement can't be reproduced.

---

## The whole corpus is vertical shorts, and that explains the counter's coverage

August 27, 2026.

Dimension measurement: **44 clips of 45 are 720×1280**, one is 640×640. There is NOT A SINGLE wide frame
in the set. All clips with a counter are vertical, and all without one too.

When 16:9 is cropped to 9:16, the bottom HUD row — health, armour, ammo — goes out of frame entirely.
Hence the coverage of 19 of 45: the other 26 physically have no counter in the frame, and this is a
property of SOMEONE ELSE'S EDITING, not of the game or the reader. Checked by eye on eight clips:
gameplay takes the top two thirds, a photo of the player is pasted below, a title above.

Indirect confirmation from the data: in all 26 uncovered clips the reader finds spots and reads them
100% (`presence: 1, readRate: 1`), but the value doesn't go down — `range: [5,5]`, "almost no drops".
It sees other interface elements, not the ammo.

**Consequences important for planning.**

1. **42% coverage is a ceiling, not unfinished work.** Extending the reader in hopes of picking up the
   remaining clips is pointless: there's nothing to pick up.
2. **The system has never been checked on an ordinary 16:9 recording.** There isn't a single such clip
   in the corpus. All of the project's numbers refer to one genre — someone else's gameplay, reframed
   for vertical.
3. The user confirmed that the target input is precisely shorts. So the path without the counter is the
   main one, and features that look for signal at the BOTTOM of the frame are useless for this audience:
   only the centre of the frame and the top, where the killfeed is, survive the crop.

The earlier statement "the counter isn't in frame on 26 clips" was right in substance but gave no cause,
and because of that looked like a property of the material in general. The cause is the framing.
