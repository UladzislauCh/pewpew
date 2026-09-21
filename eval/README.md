# Shot detector measurement pipeline

The goal is to stop improving detection blindly. Every change to `src/domain/detection/onsetDetection.ts` or
`src/domain/detection/shotDetection.ts` is run through the same clips and the same metric, so it is
visible whether things got better or merely different.

## Two tiers

**Synthetic** (`eval/synth.ts`, `eval/*.test.ts`) — committed and works for everyone. Impulses with
known timestamps on top of controlled interference: white noise, tonal "music", a very loud explosion
next to quiet shots. Runs in a fraction of a second, needs nothing, and every test states a specific
condition rather than "whatever happened on the recording".

**Real clips** (`labels/`, `examples/.cache/`) — local only. The video itself is copyrighted and never
enters the repository; only the labels, i.e. timestamps and tags, are committed.

## Why an audio cache is needed

Node here has neither WebCodecs nor ffmpeg — mediabunny can only demux mp4, and there is nothing to
decode AAC with (`canDecode: false`). So the browser does the decoding, and the result is saved to
`examples/.cache/<slug>.wav` as 32-bit float. That bit depth is deliberate: the samples must be
bit-identical to what the app itself analyses, otherwise the offline evaluation would measure
quantisation differences rather than the detector.

## Labeling

```bash
pnpm dev          # then open http://localhost:5173/labeler.html
```

Clips are taken from `examples/`. The list is on the left, the waveform with onset curves on the right.

| Key | Action |
| --- | --- |
| `Space` | play / pause |
| `A` | mark exactly at the cursor position — no snapping |
| `J` / `K` | previous / next mark |
| `X` | delete the selected mark, or the one nearest the cursor if nothing is selected |
| `E` | own ↔ enemy shot (enemy shots are labeled too — see below) |
| `H` | mark as "hard" — a shot buried under noise, music or an explosion |
| `←` `→` | ±20 ms, with Shift ±500 ms, with Alt ±5 ms |
| `⌘S` | save |

A mark lands exactly where the human put it. It used to jump to the loudest sample within
25 ms, and that was removed on purpose: the loudest sample is not the attack but the body of the
transient, and in a burst it was often the tail of the PREVIOUS shot. The mark slid onto the
neighbouring shot more often the denser the fire — exactly where labeling is already hardest.
Precision does not suffer from dropping it: the spread of manual labeling is about 18 ms against a
metric tolerance of 50 ms.

Mouse wheel zooms, dragging the background scrolls. On a 23-second clip a spray with 100 ms spacing
takes six pixels, so marks can't be placed without zooming.

The narrow strip at the top captioned "detector" is what the current pipeline finds. It is a
backdrop for comparison, not marks: those ticks can't be deleted, because "rejecting" a finding
simply means not placing your own mark there. Only the full-height coloured marks are editable. If the
strip gets in the way, the "Hide detector lane" button turns it off.

The "Fill from auto-detection" button copies the findings into the reference, after which they become
ordinary editable marks. By default the reference is still empty: if you label on top of the
detector's output, its false positives end up in the reference and the metric stops noticing them.

Label **all** the gunfire in a clip, not just your own: own shots with `A`, enemy shots with the same
marks plus `E`. Only own shots are the target, but the scorer can't tell an unlabeled enemy shot
from a false positive on crowd noise or music.

Until the "Clip fully labeled" checkbox is ticked, the clip stays out of evaluation — to the scorer a
partly labeled clip looks like a pile of false positives.

Saving writes `labels/<slug>.json` and `examples/.cache/<slug>.wav` straight into the repository through
the dev endpoints in `scripts/labelerServer.ts` (only in `vite dev` mode).

## Running

```bash
pnpm test                              # synthetic + unit tests + regression guard on clips
pnpm eval                          # per-clip table and delta to the baseline
pnpm eval --verbose             # plus timestamps of every miss and false positive
pnpm eval --only <slug>         # a single clip
pnpm eval --update-baseline     # pin the current numbers
pnpm eval --fail-on-regression  # non-zero exit code if F1 drops
pnpm eval --spectral            # the old spectral flow, for comparison
```

`pnpm eval` measures the **product scheme**: candidates from the ShotNet network on audio, then a
motion filter at threshold 0.5. The weapon region is taken from the twelve blocks selected by the
classifier if the cache `eval/.cache/blockSignals.json` exists; otherwise the old variability band is
used, and the run says so explicitly.

The block cache is computed by the browser, because Node has no WebCodecs:

```bash
pnpm exec tsx eval/weightedPrep.ts --prod   # block weights from the SHIPPED classifier
pnpm dev                           # /eval/weighted.html, ~5 min
cp eval/.cache/weightedSignals.json eval/.cache/blockSignals.json
```

The `--prod` flag is mandatory. Without it the block weights are cross-validated ones — those are
needed for TRAINING the motion model, so that region selection doesn't peek at the clip it is later
tested on. Regression tracking needs the opposite: the same selection as the product. Until 20 August 2026 this used `createDefaultDetector()` —
the old spectral flow, which is on no execution path in the app at all,
and `baseline.json` described that same flow. In other words, for many weeks the project's standard
measurement was measuring something other than what ships.

Motion is read from `eval/.cache/motion`, because Node has neither canvas nor WebCodecs.
Clips without a cache are scored on audio ONLY, and the run says so in red.

**The numbers here are inflated by roughly 4 F1 points.** The motion model is trained on all 49 clips
with no held-out set and is checked here on those same clips. Fine for tracking regressions,
not fine as a description of quality; the honest numbers come from `pnpm exec tsx eval/trainMotionModel.ts`.

Totals are printed separately for sparse and dense clips, because the combined number is weighted
towards dense fire (902 of the 1163 own shots are in dense clips) and describes
no real video at all: 40.8 vs 72.6.

## What exactly is counted

Predictions are matched to labels strictly one-to-one, maximising the number of pairs.
The traversal is not a greedy "nearest first": on a dense spray that loses pairs. With reference `[0, 0.05]`
and predictions `[0.04, 0.10]` at 50 ms tolerance, greedy-by-distance finds one pair where
there are two. Since both series are sorted and the tolerance window yields a convex bipartite graph,
walking predictions in time order and picking the earliest free reference is optimal (`matchEvents` in
`src/domain/detection/detectionMetrics.ts`).

Metrics: precision / recall / F1 at ±50 ms tolerance (the MIREX standard for onsets) and ±25 ms, plus
the median |Δt| over matched pairs — for sound replacement it matters not only to find the shot but to
land on it. The per-clip aggregate is micro-averaged: TP/FP/FN counts are summed before computing
ratios, otherwise a 5-shot clip would weigh as much as a 60-shot one.

Recall over the `hard` category is computed separately. The overall score easily hides a regression
on exactly the hard cases the whole thing exists for.

### Target — own shots (assistant)

The app substitutes the viewer's weapon sound. The metric optimises **minimum edits**:
`edits = FP + FN`, the target is `own` marks. A hit on an enemy shot counts as FP (the user
has to remove the mark). Enemy fire still has to be labeled, otherwise it is indistinguishable from junk.

Tolerance ±50 ms (MIREX).

## What has already been measured

Order matters: several "obvious" improvements came out negative on these clips, so every change
was tested one at a time, with a reproduction of the current pipeline as the control.

**What worked.**

- **HFC increment instead of raw energy.** `hfc += mag * (k + 1)` is the level of high frequencies, not
  their rise, and it stays high through the whole burst. Half of `onsetStrength` was this background, and
  `pickPeaks` only re-arms once the curve drops to `valleyRatio` of the peak — so the entire spray
  merged into a single detection. Recall 52.3% → 63.1%, on "hard" shots 11.1% → 44.4%.
- **Local prominence instead of a gate relative to the clip's peak.** A candidate is compared with the
  background around it (median short RMS in a ±0.5 s window), not with the loudest sample of the recording.
- **Stereo-width gate.** The best single feature found, AUC 0.741: shots have a
  side/mid ratio around −13 dB, false positives around −19 dB. False positives turned out to be nearly mono
  (channel correlation 0.973 vs 0.903) — mostly the centre-mixed commentator voice,
  music and UI sounds. The −20 dB threshold was chosen on a plateau: from −25 to −15 dB F1 stays within
  46.2–47.7%, which points to a real effect rather than a lucky coincidence.
- **Self-similarity / largest cluster.** Own shots are near-copies of one game sample.
  The `largestCluster` mode keeps the main cluster of "my" gun and cuts enemy/junk
  clusters better than neighbor-gate — for the assistant that means fewer edits. See the defaults in `shotDetection.ts`.
- **Causal local threshold instead of a single mean+kσ per clip.** For every frame of the onset curve
  threshold = `max(minThreshold, mean_past + k·σ_past)` over a ~1 s window looking only into the past. A loud explosion
  no longer raises the bar for the whole recording; the synthetic case "quiet shots after an explosion"
  is caught in full again. `minThreshold` = 0.02. Subtracting a running median from the *curve* is still
  harmful — only the comparison bar changes.

### Stage 1: audio assistant (current defaults)

Defaults were tuned for min(edits) on the labeled clips: prominence 6 dB, stereo −15 dB,
self-sim ≥0.97 in **largestCluster** mode. On ~201 own: around **~114 edits** (F1 ~60%,
P ~90%, R ~49%) vs ~330 for recall-first. The regression in `clips.test.ts` watches **F1**.

### Stage 2 (later): ML filter and own/enemy

The next notable gain is a classifier on top of candidates and/or video ownership on a larger
set of clips.

**What did not work** (tested, discarded — not worth retrying without new data):

- Local normalisation of the curve by a running MAD: in quiet stretches MAD goes to zero, the z-score
  explodes, and the threshold stops having any effect (1031 false positives).
- Subtracting a running median from the curve: F1 34.8% vs 36.4% without it.
- A centred (non-causal) mean+kσ window for the threshold: the peak itself inflates the local σ and sometimes
  blocks the very event we're looking for.
- Log compression of magnitudes and band-limited flux (150–4000, 300–6000, 400–10000 Hz): worse everywhere. The cause
  was measured — false positives are *brighter* than shots (centroid 5467 vs 4063 Hz), so emphasising high
  frequencies amplifies precisely the interference.
- Mid-frequency weighting of the curve (300–2000 Hz): 32.9% vs 36.4%. Spectral shape is useful
  for *scoring* a candidate, not for *finding* it.
- Replacing valley-based peak-picking with "local maximum + refractory period": 40.3% vs 48.6%.
  The existing valley algorithm is clearly better; best left alone.
- Logistic regression on 4 spectral features as a candidate filter: under
  leave-one-clip-out validation F1 45.6% vs 44.4%, i.e. a gain of one shot. Adding stereo
  features made it worse (43.6%) — overfitting on five clips with different mixes.
- **Matching against the weapon-samples library (all 34 guns).** A 42-dimensional fingerprint: AUC own>fp
  0.75, but almost everything gravitates to Glock; the best threshold gave F1 51%. A mel-spectrogram "matched
  filter" on raw wav collapsed (all scores ~0.97). Matching against the clip's *labeled* weapon turned out
  *worse* than matching against any template — the dry asset and the mixed clip are too far apart. The library
  stays for the UI hint, not for a gate.
- **Cadence decoding by RPM.** A grid from auto-IOI or the clip weapon's oracle RPM cuts recall
  harder than precision (lots of taps and semi-auto off the ideal grid); F1 drops to ~40%.
- **YAMNet zero-shot (AudioSet gunshot classes) on top of candidates.** A ~1 s window around each
  finding with self-sim off (own=46, enemy=30, fp=82). Sum/max over the classes Gunshot /
  Explosion / Machine gun / Fireworks / …: AUC own>fp **0.436** (worse than chance), median
  gun_score own 0.075 vs fp 0.415 and enemy 0.662. The top class for own shots is often Speech (the commentator
  in the window), for false positives Explosion/Gunshot. The best threshold gave F1 ~38% vs the baseline at the time,
  56%. CS2 POV (voice + mix) is out of AudioSet's distribution; do not ship a zero-shot gate.
  Scripts: `scripts/_exportCandidates.mts`, `scripts/_yamnet_score.py` (local model in
  `eval/.yamnet_model/`, venv `.venv-yamnet/`).

The main constraint is still data and timing quality (echo peaks). **The next stage** is
ownership (own/enemy). More fully labeled clips will help calibrate the gates.

## Known defects pinned by tests

The synthetic case "quiet shots after a loud explosion" is a regular `it` (causal local threshold).

**Low precision at stage 1.** Many audio candidates (commentator, music, enemy fire without
enemy labels) — expected until the video gate. Enemy fire must be labeled, otherwise it counts as FP.

**Recall < 100%.** The remaining FN are quiet/buried shots that don't pass onset or prominence;
some of them video may rescue, if there is a visual signal.

## Where to plug in an experiment

`Detector = (audio: AudioLike, fixture: Fixture) => number[]` in `eval/evaluate.ts`.
The fixture is needed because the product scheme is two-stage: the second stage needs the
specific clip's motion signals, and those are stored by slug. `createProductionDetector()` in
`eval/productionDetector.ts` is what ships; `createDefaultDetector()` is the old
spectral flow.
Any alternative implementation with the same signature is scored on the same fixtures, so variants
can be compared side by side without touching the app.

For the same reason `computeOnsetCurve` and `detectShots` take a structural `AudioLike` rather than the browser
`AudioBuffer`. A real `AudioBuffer` satisfies it, so nothing changed in the app,
and in Node an object over the decoded WAV is passed in. `tsconfig.node.json` builds this part
without `lib: ["DOM"]` — so the type checker itself makes sure no browser API leaks into the detection core.

## Reviewing errors by eye

`eval/errorReviewPrep.ts` + `eval/errorReview.html`. Shows the frames around those candidates
where the motion model was wrong, with its score and the ground truth from the labels.

```bash
pnpm exec tsx eval/errorReviewPrep.ts --per-clip 3   # material goes to public/__review/
pnpm dev                                    # then /eval/errorReview.html
pnpm exec tsx eval/errorReviewPrep.ts --clean
```

Why a separate tool. Tables say THAT the model is wrong, but not what is in the frame
at that moment — and once the feature path on 49 clips was exhausted
(`docs/RESEARCH-journal.md`, the session summary), there was nowhere left to get new features from.

The selection targets the bulk of errors, not the most spectacular ones. At threshold 0.5, of 527 extra marks
83% sit where there is NO shot at all, and only 17% on enemy shots; so the error type
and clip density are shown in the interface, and they should be looked at separately.

The page is browser-based out of necessity: frames come from WebCodecs, which Node lacks. Nothing
is recomputed — the numbers come from the manifest, so what's shown matches what
the cases were selected by. The gameplay band and the "weapon" mask box are drawn over the frame: the mask
has been checked by eye and lands on the webcam, smoke and edit captions, so in every case under review
it helps to see where the model is looking at all.

Notes live in localStorage and are exported to JSON with a button.

## Human labeling of the weapon region

`eval/weaponRegionPrep.ts` + `eval/weaponRegion.html`. Draw a box around the viewmodel on a frame;
the output is `weaponRegions.json` with frame fractions.

```bash
pnpm exec tsx eval/weaponRegionPrep.ts   # material goes to public/__region/
pnpm dev                        # then /eval/weaponRegion.html
pnpm exec tsx eval/weaponRegionPrep.ts --clean
```

Why a human draws the box. The automatic region search (variability band p10..p45 and the largest
connected region) was checked by eye on five clips in a row and missed every time, each time differently:

| clip | what the heuristic found |
|---|---|
| `usp-0` | the entire bottom strip of the frame, x 0.00–1.00 y 0.73–1.00 — the streamer's webcam is there |
| `ssg08` | the LEFT half (centre x 0.26), while the player's weapon is on the right |
| `awp` | 25% of the frame area |
| `deagle` | a photo of the player |
| `3-kill` | 17% of the frame area |

The viewmodel never takes up that much space. The consequence was measured: 16 of the 74 `weapon.*` features
currently come out a draw — switching them off moves F1 from 64.3 to 64.2, better on 15 clips
and worse on 22, i.e. they measure some random, moderately stable region.

Frames are taken at the moments of own shots plus 120 ms: gameplay is guaranteed there,
the weapon is raised and no longer blurred by recoil. Sparse clips come first — that's where the model
fails, and that's also where pistols and snipers are, which have enough frames
per shot.

The "no weapon in frame" flag is a legitimate state, not a skip: the weapon can be cut off by the clip's
crop, and in a sniper's scope the viewmodel isn't drawn at all.

## Signal inside the weapon region: human vs heuristic

`eval/weaponSignalPrep.ts` → `eval/weaponSignal.html` → `eval/weaponSignalEval.ts`.

```bash
pnpm exec tsx eval/weaponSignalPrep.ts
pnpm dev                        # /eval/weaponSignal.html, ~7 min for 49 clips
                                   # the result lands in eval/.cache/ by itself
pnpm exec tsx eval/weaponSignalEval.ts
pnpm exec tsx eval/weaponSignalPrep.ts --clean
```

The human regions are in `eval/weaponRegions.json` (labeled on all 49 clips: 46 boxes
and 3 "no weapon" — two sniper scopes and one clip where there is simply no weapon in frame).

How far they diverge from the heuristic:

| | human | heuristic |
|---|---|---|
| median box area | **8.0% of frame** | 15.5% |
| median IoU between them | **0.065** | |
| clips with IoU < 0.2 | **31 of 46** | |
| clips where the heuristic didn't cover the box at all | 6+ | |

Four per-frame series are computed inside the region: rigid shift `dx`/`dy`, **residual after
compensating** for that shift, frame difference without compensation, and mean brightness. The residual is
the main one: bolt travel, the opened ejection port and barrel highlights can't be explained by a
rigid shift and settle precisely there.

Both regions are computed from ONE decoding pass, otherwise decoding differences would be mixed
into the difference between regions.

The analysis is split into "own vs enemy" (17% of extra marks) and "own vs noise"
(83%), and separately into sparse and dense clips — the combined metric is weighted towards dense ones.

## Training the motion model

`eval/trainMotionModel.ts` — a TypeScript port of `eval/legacy/exportMotionModel.mjs`.

```bash
pnpm exec tsx eval/trainMotionModel.ts             # compare schemes
pnpm exec tsx eval/trainMotionModel.ts --export    # plus weights to eval/.cache/motionModel.v2.json
```

There are two differences from legacy, both intentional. First: features are extracted by PRODUCTION code
(`motionFeaturesAt`), not by a copy of the formulas — in legacy `summarize` and `shape` are duplicated,
and drift from prod would quietly devalue the weights. Second: validation uses folds BY CLIP,
because candidates within a clip are not independent.

### The shipped model is overestimated by about 4 F1 points

Know this before reading any of the project's summary numbers. The model is trained on all 49 clips
with no held-out set (the weights file itself states that quality must not be measured on it),
and `pnpm eval` measures it on the same clips. Scheme B* — the same training without a held-out
set — reproduces the shipped model almost exactly, while honest fold validation drops it
by four points:

| scheme | F1 | extra per shot at 90% recall |
|---|---|---|
| A — as shipped | 64.3 | 0.81 |
| B* — same training, no held-out set | 63.8 | 0.77 |
| **B — same, with honest folds** | **59.7** | **1.02** |

A must not be compared with anything validated by folds. B, C and D should be compared with each other.

### What the right weapon region gives

| scheme | F1 | extra at 90% | sparse F1 | dense F1 |
|---|---|---|---|---|
| B — heuristic region | 59.7 | 1.02 | 35.1 | 69.5 |
| C — human region | 62.0 | 0.91 | 39.3 | 70.2 |
| **D — C + frame difference** | **62.9** | **0.86** | **39.4** | **71.6** |

So the human box is worth **+3.2 F1 points** and **−16% extra marks** at 90% recall,
**+4.3 points** on sparse clips. After retraining the weapon features become
the heaviest in the model — before, they were noise:

```
+0.569  weaponBox.diff.mean      -0.565  weapon.dx.band0_3
+0.542  weapon.dy.flips          -0.539  weapon.dx.meanAbs
```

**A limitation that takes away half the joy.** Schemes C and D need a HUMAN-LABELED
region, and a user's clip has none. Shipping this needs an automatic region search
of human quality — the very task `findViewmodel.mjs` stumbled on.
The difference is that there are now 46 human boxes as a reference, which didn't exist before.

## Automatic weapon-region search

`eval/viewmodelPrep.ts` → `eval/viewmodel.html` → `eval/viewmodelEval.ts`.

```bash
pnpm exec tsx eval/viewmodelPrep.ts
pnpm dev                              # /eval/viewmodel.html, ~5 min for 49 clips
pnpm exec tsx eval/viewmodelEval.ts --sweep    # threshold-based selection
pnpm exec tsx eval/viewmodelEval.ts --learn    # learned; writes weaponRegions.auto.json
```

### The "doesn't move with the camera" criterion is closed by measurement

The journal suggested finding the viewmodel by the fact that it doesn't move with the scene. A check
against 46 human boxes (11 776 blocks) closes this path:

| block feature | AUC "block inside the human box" |
|---|---|
| `pinned` — doesn't move with the scene | **0.528** |
| `scene` — moves with the scene | 0.460 |
| `neither` — moves, but not with the scene | 0.631 |
| `reacts` — stirs at candidate moments | 0.685 |
| `activity` — simply the most changing block | **0.710** |

The reason: the viewmodel is NOT pinned to the screen, it sways when walking and jerks on recoil —
exactly what the features measure. What is pinned to the screen is the killfeed, nicknames and the webcam, so the criterion
selects precisely the junk that needs to be discarded. A threshold sweep confirms it
head-on: at `minPinned ≥ 0.7` the result is zero on every clip.

### What came out

| | learned selection | threshold-based | heuristic in prod |
|---|---|---|---|
| median IoU with the human box | 0.209 | 0.221 | 0.065 |
| centre inside the human box | **31/46** | 23/46 | — |
| misses (IoU < 0.2) | 23/46 | 22/46 | 31/46 |

Position features carry almost everything: without them the median goes 0.209 → 0.122, centre hits 9 of 46.
So the selection largely learned "the weapon is bottom-right". On `p2000`, where the weapon is on the left, IoU is 0.00.

### But the end-to-end measurement matters more than IoU

Automatic boxes obtained with by-clip folds were run through the same training pipeline:

| scheme | F1 | extra at 80% recall | sparse F1 |
|---|---|---|---|
| B — heuristic region | 59.7 | 0.71 | 35.1 |
| **C — AUTO SEARCH** | **61.4** | **0.61** | **38.4** |
| C — human region | 62.0 | 0.58 | 39.3 |
| D — human + frame difference | 62.9 | 0.56 | 39.4 |

**A box with IoU 0.21 captures more than half the gain, and on sparse clips three quarters
(+3.3 of +4.3).** So the feature tolerates an imprecise box: it only needs to land on the weapon,
not outline it. This agrees with the fact that the feature's strength doesn't depend on the box area
(correlation 0.13).

What the automatic search does NOT carry over is scheme D: with an imprecise box the frame-difference feature becomes
noise (60.9 vs 61.4 without it, against 62.9 on the human box). That one needs precision.

### The cost in prod doesn't grow

Per-block analysis is needed on the full frame — the same place camera motion is computed now,
so it can be merged into the first pass. The second pass then runs not over the variability
band but over the found box. There are still two passes.

## A weight map instead of a rectangle

`eval/weightedPrep.ts` → `eval/weighted.html` → `eval/weightedEval.ts`.

```bash
pnpm exec tsx eval/viewmodelEval.ts --learn   # per-block weight maps
pnpm exec tsx eval/weightedPrep.ts
pnpm dev                             # /eval/weighted.html, ~5 min
pnpm exec tsx eval/weightedEval.ts --emit     # sweep schemes, write weaponSignals.json
pnpm exec tsx eval/trainMotionModel.ts
```

### Cache of per-block frame differences

`blockDiffs.bin` — 8.3 MB, the difference of each of the 256 blocks on every frame, one byte per value,
scale 4 units per pixel of brightness. After a single decoding pass any weighting scheme
is computed locally in seconds; before that every check cost seven minutes
of a browser run and broke whenever the machine went to sleep.

Shift and residual can't be cached this way — they need a pixel search. That's no loss: it was measured
that compensation barely pays off (residual 0.771 vs 0.774 for plain frame difference).

### Soft weights DON'T work — tighter selection does

The hypothesis was: the rectangle throws away what the classifier knows, and soft weights
would fix that. The sweep refutes it — softness is WORSE than the rectangle:

| weighting scheme | AUC all | sparse |
|---|---|---|
| block rank over all 256 | 0.613 | 0.668 |
| raw probability over all 256 | 0.634 | 0.699 |
| rectangle (what we had) | 0.670 | 0.741 |
| top-24 | 0.672 | 0.741 |
| **top-12** | **0.691** | **0.748** |
| top-8 | 0.688 | 0.742 |
| top-4 | 0.675 | 0.735 |

The optimum is 12 blocks, i.e. 4.7% of the frame. And **weights within the selection add nothing**:
"top-12 weighted" and "top-12 unweighted" match to the third decimal (0.691). What decides it is
solely WHICH 12 blocks, not the weight they enter with.

### What it gave in the metric

| scheme | F1 | extra at 80% | sparse F1 |
|---|---|---|---|
| B — heuristic region (as in prod) | 59.7 | 0.71 | 35.1 |
| C — auto search, rectangle | 61.4 | 0.61 | 38.4 |
| C — auto search, top-12 blocks | 61.4 | 0.59 | **39.5** |
| **D — top-12 + frame difference** | **62.3** | **0.56** | 39.1 |
| D — human boxes + frame difference | 62.9 | 0.56 | 39.4 |

**Scheme D came back to life.** On the auto-search rectangle it was WORSE than without it (60.9 vs 61.4);
on top-12 it is better (62.3 vs 61.4). The diagnosis was confirmed: what hurt the frame-difference feature
was not the region's size but the background inside it.

The automatic pipeline now captures 2.6 of the 3.2 points that manual labeling gave,
and at 80% recall matches it exactly (0.56 extra per shot).

Caveat: in this run the shift and residual series were computed on top-24 (that's how the browser
pass was set), and only the frame difference on top-12. A clean run entirely on top-12 wasn't done.

## How the pages hand back results

The research pages in `eval/` compute in the browser, because Node has no WebCodecs.
They send the result as a POST request to the dev endpoint `/__cache/<name>`
(`scripts/evalCacheServer.ts`), and it lands straight in `eval/.cache/`.

This used to be done by downloading, and the browser asked for confirmation on every file —
while a `weighted.html` run produces three. Writing is allowed only into `eval/.cache/` and only
under a plain file name: slashes and ".." are rejected, otherwise the dev server would become a write
into any point on disk. The endpoint is mounted only by `vite dev` and never ends up in the build.

If the page is opened outside `vite dev`, it falls back to downloading — the result
isn't lost (`eval/saveResult.ts`).

## End-to-end check of the new pipeline with browser decoding

`eval/browserCheck.html` → `eval/browserCheckEval.ts`.

```bash
pnpm exec tsx eval/weightedPrep.ts     # if public/__weighted/ doesn't exist yet
pnpm dev                      # /eval/browserCheck.html, ~5 min for 46 clips
pnpm exec tsx eval/browserCheckEval.ts
```

Weapon features were already computed by the browser — nothing to check there. One thing remained
unchecked: the camera motion for them came from the `frametool` reference cache, while in the app it will come
from mediabunny/WebCodecs. The page computes both pipelines from ONE decoding pass,
sampling every frame twice: 384×384 for camera motion via production code and 256×256 for the blocks.

The comparison isolates exactly this factor: the weapon series are identical in both branches, only
the source of camera motion changes.

| | F1 | precision | recall | sparse | dense |
|---|---|---|---|---|---|
| camera from the `frametool` cache | 62.8 | 54.2 | 74.7 | 40.6 | 71.2 |
| camera from WebCodecs | 62.7 | 54.1 | 74.4 | 39.6 | 71.3 |

- correlation of the camera motion series: median **0.9984**, minimum 0.9653;
- the decision at threshold 0.5 matched on **98.9%** of candidates (50 of 4619);
- per clip, the browser is better on 10, worse on 12, equal on 24 — **the losses aren't systematic**.

For the old pipeline the same check gave 0.2 F1 points and 98.2% matching decisions. The new
pipeline carries over no worse.

The only thing to keep in mind: on sparse clips the gap is 1.0 point (40.6
vs 39.6) — larger than on the combined number. With 26 clips and 261 own shots that's within
noise, and per clip the sign isn't systematic, but if the gap grows — that's where to look.

**Beware of the first version of this check.** It took the weapon series from different files —
top-12 in one branch and top-24 in the other — and changed two factors at once. That's not a valid measurement;
one factor must be isolated.

## Moving to prod: the block-based weapon region

The scheme is in `src/domain/detection/motion/blockMotion.ts`, the weights in `public/models/blockModel.json`
(block classifier) and `public/models/motionModel.blocks.json` (the motion model,
retrained on signals from the selected blocks).

```bash
pnpm exec tsx eval/exportBlockModel.ts        # block classifier weights
pnpm exec tsx eval/trainMotionModel.ts --export   # motion model weights
pnpm dev                             # /eval/prodRun.html — run of the product path
```

### One pass over the video instead of two

The video used to be decoded twice: in full for camera motion, then the band with the weapon —
and the band was only found from the results of the first pass. Decoding is about 8 seconds
out of 10 on a 22-second clip.

Now 256×256 frames are accumulated in the same pass and everything else is computed from them: block
analysis, region selection and its shift. Measured on 46 clips: **0.28x real time vs
0.46x**. A one-minute clip takes about 17 seconds instead of 27.

### What it gave

Both schemes were measured the same way, on the same 46 clips, with weights trained on all clips
(so both are equally inflated):

All 49 clips, both paths — with weights trained on all clips (so equally inflated):

| | F1 | precision | recall | marks | speed |
|---|---|---|---|---|---|
| old scheme | 64.3 | 56.0 | 75.3 | 1563 | 0.46x |
| by blocks, standard measurement | 64.8 | 56.1 | 76.7 | 1591 | — |
| by blocks, product path | **65.1** | 56.4 | **77.0** | 1588 | **0.27x** |

The two paths agree within 0.3 F1 points — that is the decoding noise band established
by a separate check. The quality gain is modest (+0.5…+0.8 F1, recall +1.4…+1.7); the main things are
twice the speed and sparse clips: 42.6 vs 40.8.

The real quality claim comes from HONEST by-clip fold validation, not from these numbers:
59.7 for the old region vs 62.3 for auto search. At equal recall (extra marks
per own shot):

| scheme | recall 90% | 80% | 70% |
|---|---|---|---|
| heuristic region | 1.02 | 0.71 | 0.50 |
| auto search, top-12 | 1.02 | **0.61** | **0.40** |

At 90% it's parity; at moderate recall a 14–20% gain.

### Frame-difference features dropped

While the region's shift was computed on top-24 and the frame difference on top-12, three such features
gave +0.9 points. On consistent signals the gain vanished: 62.3 vs 62.3, and on
sparse clips 39.3 vs 38.0 — harmful. The feature was patching the mismatch, not adding
signal. They're not in prod.

### Fallback

The new scheme needs both models; without either of them, or if the block analysis didn't work out
(the camera is static throughout the video — "scene" can't be told from "pinned"), the second stage takes
the old path through the variability band.

The weights live in SEPARATE files. The schemes' features are identical in names and order, but the weights aren't:
`weapon.*` are taken from different regions. Substituting one for the other means silently getting
garbage: a check by name won't catch such a swap.

## The recall ceiling and why `minGapMs` shouldn't be lowered

### The ceiling is in the audio, not in the video filter

| | shots | share |
|---|---|---|
| own shots in the labels | 1163 | |
| audio found at least some candidate | 1103 | 94.8% |
| **got THEIR OWN candidate** | **994** | **85.5%** |

The gap between 94.8% and 85.5% is 109 shots which, in a dense burst, share one
nearest candidate. This is a RESOLUTION limit, not a sensitivity one.

Recall above 85.5% is unreachable with any filter, and right at the ceiling there remain
**3.3 extra marks per found shot** — easier for the user to label from scratch.

#### But this ceiling hits the half of the set that wasn't hurting

Reading the previous table as "the project's main problem" is a mistake. Breakdown of the losses:

| | shots | share |
|---|---|---|
| audio gave no candidate at all | 60 | 5.2% |
| a candidate exists but is shared with a neighbour | 109 | 9.4% |
| — of these, on DENSE clips | **106** | |
| — on sparse | **3** | |

The gap to the nearest neighbouring shot among the lost ones is a **median of 1.3 frames**; 73% have
a neighbour closer than two frames, 93% closer than three. For found shots the median is 2.7 frames.

Two consequences.

**Video can't bring them back in principle.** As separate events they don't exist in the frames —
it's the limit of the sampling rate, not of the model. The idea "let video itself propose shots
where the audio merged them" is closed before any work started.

**The ceiling isn't where it hurts.** 106 of the 109 losses are on dense clips, where F1 is already 72.8.
On sparse clips, where the product falls apart (F1 42.6), sharing loses THREE shots.
So on sparse clips the bottleneck is not recall but PRECISION: extra marks.

### Lowering `minGapMs` raises the ceiling but worsens the curve

At `minGapMs` 25 the ceiling rises to 89.1% (6606 candidates instead of 4808). But at EQUAL
recall the current 50 ms is better:

| | recall | extra per shot |
|---|---|---|
| `minGapMs` 50, threshold 0.50 | 73.3% | **0.86** |
| `minGapMs` 40, threshold 0.55 | 73.9% | 0.93 |
| `minGapMs` 30, threshold 0.55 | 74.0% | 0.93 |
| `minGapMs` 25, threshold 0.60 | 73.9% | 1.21 |

Lowering the gap adds not new shots but DUPLICATES on already found ones, and each duplicate is
an extra mark. The direction is closed.

### WARNING: how to count recall

This check gave the wrong answer twice because of how recall was counted, and both times the numbers looked
convincing.

1. Recall must not be counted PER CANDIDATE: 1163 shots have 1301 candidates,
   and "100% recall" comes out with a ceiling of 94.8%.
2. Counting without charging duplicates is also wrong: if two candidates land on one shot,
   the second goes into neither TP nor FP — it vanishes. The smaller `minGapMs`, the more
   such duplicates, so the method systematically flatters small values. That is exactly how
   the direction first looked like a win.

**Measure only with `scoreDetections`** — strict one-to-one matching, where a duplicate
on an already found shot counts as an extra mark. That is exactly what the user sees.

### Motion threshold 0.5 is not F1-optimal

| threshold | F1 | precision | recall | extra per shot |
|---|---|---|---|---|
| 0.50 (in the product) | 62.1 | 53.9 | 73.3 | 0.86 |
| 0.60 | 62.6 | 57.9 | 68.2 | 0.73 |
| **0.65** | **63.0** | 60.5 | 65.8 | **0.65** |
| 0.70 | 62.6 | 62.9 | 62.4 | 0.59 |

Moving to 0.65 removes 24% of extra marks at the cost of 7.5 recall points, with no retraining.
0.5 was chosen not by F1 but as a product decision: a missed shot the user has to find
by ear, while an extra mark is removed with a slider. Change it only deliberately.

## Is video analysis exhausted

In short: the "weapon region" idea — yes; video analysis as a whole — no, but everything untried
runs into the amount of data.

**The weapon region is exhausted.** Human labeling gives F1 62.9, auto search 62.3.
The remaining 0.6 points cost manual work on every clip. There is nothing more to get there.

**Video as a SOURCE of candidates is closed by measurement** (see above): the shots the audio
loses are 1.3 frames apart.

**Not tried at all — two things, neither about the region:**

1. **A learned model on pixels.** Everything so far is 74 human-invented numbers
   fed into logistic regression. A convolutional network over a stack of weapon-region frames
   has never been tried. The journal tried a "non-linear model", but on the same 74 features —
   that's something else. It runs into 1163 positive examples.
2. **Labeled NON-shots.** 83% of extra marks sit where there's no shot, and the model
   has never seen labeled running, jumping, reloading, weapon switching. The biggest
   bucket of errors, not touched at all.

Both roads lead to `docs/DEMO-recording.md`. Without new data video analysis really is
exhausted — not because there are no ideas, but because there's nothing to test them on.

## What extra marks actually consist of

Measured at threshold 0.5, honest fold validation, distance to the nearest own shot:

| kind | sparse | dense | total |
|---|---|---|---|
| **DUPLICATE**: a shot nearby, already found by another mark | 44% | 67% | **56%** |
| **NEAR MISS**: a shot nearby, but found by no one | 10% | 5% | 7% |
| **NOISE**: no own shot within 150 ms | 46% | 28% | 36% |

The median distance to the shot for duplicates and near misses is **57 ms**, p75 — 84 ms.

**Real noise is a third, not 83%.** The earlier estimate "83% of extra marks aren't shots" holds
for the CANDIDATE CLASS, but doesn't describe what the user sees: more than half of the extra
marks sit almost right next to the correct one.

### Merging duplicates in time does NOT work — checked three times

| merge window | F1 all | sparse | dense |
|---|---|---|---|
| no merging | **62.1** | **38.6** | **70.7** |
| 60 ms | 56.3 | 38.7 | 62.2 |
| 80 ms | 45.0 | 34.5 | 48.6 |
| 100 ms | 21.6 | 25.5 | 20.1 |
| 200 ms | 15.8 | 21.8 | 13.7 |

Duplicates sit at 57 ms, and real neighbouring shots are right there too (median interval 88 ms,
p5 is 31 ms). Any window removes equal numbers of both.

A window tuned per clip (a fraction of the median interval between marks) was checked too: it gives
62.2 vs 62.1, i.e. nothing. The median itself is dragged down by duplicates, and the window comes out tiny.

Measuring the halves of the set separately doesn't help: on sparse clips the interval between
shots is 218 ms vs 71 for dense ones, but even there merging gives 38.7 vs 38.6.

### Consequence: 56% of extra marks are removed by the EDITOR, not the model

A duplicate 57 ms from the correct mark is two marks almost on top of each other. For the user this
is not the same as a mark in the middle of silence: they see them as one, but delete them with two clicks. The metric
counts them the same, but they cost differently.

Showing time-coincident marks as one and deleting them as a group removes 56% of extra marks
with no risk to recall and no retraining. It's the same lever the journal measured as the
largest: ease of deletion gives 1.75x → 2.65x, more than any feature improvement.

What's left for the model is a third — real noise.

## How much more to label: the curve for the motion model

The journal took such a curve for ShotNet (+2.1 precision points on a sixfold increase in data).
For the motion model there wasn't one. The test is always on 14 held-out clips, 5 repeats each:

| clips in training | F1 | spread |
|---|---|---|
| 5 | 57.0 | ±7.4 |
| 15 | 55.0 | ±8.2 |
| 20 | 62.3 | ±5.9 |
| 25 | 57.6 | ±7.0 |
| 30 | 61.3 | ±2.5 |
| 35 | 62.3 | ±5.3 |

Growth from 5 to 35 clips is **+5.3 points with a spread of ±5–8**, the curve is non-monotonic, 20 clips
are indistinguishable from 35. The same conclusion as for the audio stage: **labeling fifty more clips
of the same kind is not a lever.**

Labeling NON-shots in the existing clips isn't needed either: they are already labeled implicitly. Everything
not near a shot mark is a negative example, and there are 3507 of those vs 1301 positives.

## The ceiling of a perfect filter

If the video filter were perfect (kept exactly the candidates on own shots):

| | now | ceiling | headroom |
|---|---|---|---|
| whole set | 62.1 | **92.2** | 30 points |
| **sparse** | **38.6** | **94.3** | **56 points** |
| dense | 70.7 | 91.5 | 21 points |

On sparse clips the audio ceiling is 89.3% — higher than overall. Audio works fine there,
and almost all the loss sits in the video filter.

The headroom is huge, but it isn't unlocked by compute: the model is logistic regression
on 74 numbers, that's microseconds, and all the time goes into feature extraction. Capacity
on this data has already been measured, and it hurts. So the bottleneck is features, not power or volume.

## Weapon-region pixels: checked, no gain

`eval/stackPrep.ts` → `eval/stacks.html` → `eval/stackTrain.ts`.

```bash
pnpm exec tsx eval/stackPrep.ts        # region boxes + candidates to public/__stacks/
pnpm dev                      # /eval/stacks.html, ~3 min
pnpm exec tsx eval/stackTrain.ts       # training and sweep of representations, seconds
```

The hypothesis was: the 74 features are summaries of rigid shifts over a window, and they erase at once
WHAT changed, WHERE inside the region and AT WHICH moment. Yet that is exactly what distinguishes a shot —
bolt travel, the ejection port, barrel highlights. So a spatially resolved frame
difference should add something.

Checked on stacks of 13 frames of 32×32 around every candidate:

| representation | features | F1 all | sparse |
|---|---|---|---|
| **74 summaries (current)** | 74 | **61.8** | **38.6** |
| frame difference, a single mean | 12 | 43.7 | 25.5 |
| frame difference, 4×4 grid | 192 | 45.9 | 27.0 |
| residual after compensation, 2×2 | 48 | 47.1 | 29.6 |
| 74 summaries + residual 2×2 | 122 | 61.7 | 38.4 |
| 74 summaries + residual 4×4 | 266 | 61.3 | 37.6 |

Shift compensation helps (47.1 vs 44.8), but the pixels add nothing to the summaries:
the combination gives 61.7 vs 61.8.

### Resolution checked, and it doesn't unlock a gain

The doubt was legitimate: 32×32 compresses the box roughly fifteen times from the original
1080p, while a human saw bolt travel in a region of about 180 pixels. It was re-exported larger
(`pnpm exec tsx eval/stackPrep.ts --size 64`, with the window narrowed so the cache doesn't balloon):

| stack resolution | 74 summaries | 74 + residual 2×2 | gain |
|---|---|---|---|
| 32×32, 13 frames | 61.8 / 38.6 | 61.7 / 38.4 | none |
| **64×64, 9 frames** | 61.8 / 38.5 | **62.4 / 39.1** | +0.6 / +0.6 |
| 96×96, 7 frames | 61.8 / 38.5 | 62.3 / **39.4** | +0.5 / +0.9 |

(the slash separates the whole set and sparse clips)

From 32 to 64 a gain appeared, from 64 to 96 it stopped growing. The result — **+0.5 points overall
and +0.9 on sparse**, at the edge of the spread.

Conclusion: the pixels carry not "nothing", but not something worth building a convolutional network for either.
The hypothesis is closed.

## Summary: four hypotheses, all closed by measurement

| what was tried | result |
|---|---|
| more labeled clips | +5.3 points on a sevenfold increase, spread ±5–8 |
| more model capacity | HURTS: 62.1 → 56.8 → 52.7 at 8/16/32 hidden |
| the right weapon region | squeezed dry: human 62.9 vs auto search 62.3 |
| pixels instead of summaries | +0.5 overall, +0.9 on sparse, plateau in resolution |

Meanwhile the ceiling of a perfect filter is 92.2 on the whole set and 94.3 on sparse.
The headroom exists and it's huge, but **none of the levers testable on this corpus
unlocks it**.

The common denominator of all four is transfer between clips. Forty-nine videos from different
people, with different editing, webcams and overlays; the model learns the videos, not the shots.
Hence two ways out, both outside the video stage:

1. **Data of a different quality** — clean demos with per-frame ground truth and, above all,
   with labeled NON-shots: running, jumping, reloading, weapon switching.
   The specification is in `docs/DEMO-recording.md`.
2. **The cost of an edit in the editor.** 56% of extra marks are duplicates 57 ms from the correct one,
   they're removed by the interface without any model, and the journal measured this lever as the
   largest: 1.75x → 2.65x.

---

## Speed: where the time goes and what is already closed

The benchmark was taken with `eval/speed.ts` on 50 clips, via the product path (`detectByFlash`) in the browser.
The earlier 0.27x in the documentation refers to the MOTION SCHEME and has nothing to do
with the current path.

| | ×real time | ms/frame |
|---|---|---|
| main before the changes | 0.699 | 20.55 |
| after reading only the fitted frame | **0.653** | 19.22 |

Of the 19.22 ms per frame: **network 12.88 (67%)**, tensor preparation 3.85 (20%), remainder 1.83 (9%).

**Decoding is NOT the bottleneck.** It's those 9%, and part of them is hidden behind the model.
The comment in `detectByFlash` about "decoding being the bottleneck" is true for the motion
scheme and is outdated for the current one.

### Decimation to 30 fps: does NOT pass

Eight clips in the corpus are shot at 60 fps and cost 1.15–1.90x real time vs
0.55–0.70 for the rest. Capping the frame rate gives **15.4% speed** and costs **1.2 recall
points** (59.5 → 58.3): at 60 fps a muzzle flash lives 4–6 frames, after decimation
2–3 remain, and a short one falls between sampled frames. Marks shifted on four clips,
and all four are 60 fps.

### Skipping frames by brightness: DOES NOT WORK, checked with four rules

The idea: the network takes 67% of the time, and there are 1006 shots in 35 thousand frames — so
for the overwhelming majority of frames the model computes only to return zero. The flash is bright,
so dark frames needn't be handed to the network.

Measured on the fast set (5628 frames, 319 firings); the safe threshold is the minimum
of the feature over FIRING frames:

| rule | median, firing | cold | skipped at zero loss |
|---|---|---|---|
| whole-frame brightness | 11300 | **12807** | 0.8% |
| frame brightness jump | 199 | 0 | 3.3% |
| max over 8×8 cells | 1902 | 1677 | 0.5% |
| max minus median of cells | 1880 | 1581 | 0.9% |
| bright pixels at bottom centre | 620 | 550 | 0.0% |
| jump in a single cell | 276 | 89 | 0.0% |

Even at the cost of 3% lost firings the best rule skips 16.6% of frames.

**Why there's no separation.** Cold frames are just as bright, and by whole-frame brightness
they're even brighter. CS2 is bright: the HUD, sky and walls constantly give thousands of near-white pixels,
and a flash adds a hundred to that. The network fires not on "bright" but on the SHAPE of the blob — that
is, on exactly what it's called for. There is no cheap feature in the pixels
that would replace it.

The idea looks obvious and will be proposed again — that's why it's written down.

### Decoding cost: 1.0 ms per frame — and why that closes two-pass schemes

Measured with probes on the fast set, main branch:

| what is disabled | wall, ms/frame |
|---|---|
| nothing | 19.96 |
| ammo counter | 17.52 |
| model on 4 frames of 5 | 6.86 |

Hence: the counter costs **2.44 ms/frame** (12% of the time), and decoding about **1.0 ms**
(3.44 irremovable minus 2.44 for the counter). The model on a processed frame doesn't get cheaper
with decimation (17.07 vs 16.24), so there's no hidden saving from unloading the pipeline.

### Two passes, "counter first, then the model around its moments": DOES NOT PAY OFF

The idea: on 19 clips of 45 the counter is readable and gives marks by itself, while the model walks all
frames there for the flash reference and cross-checking. So the first pass could collect the counter, and
the model would be called only around the found moments.

Measured with a probe (the second decoding included in the cost):

| clip | before | after | network frames |
|---|---|---|---|
| ak47 | 0.61x | 0.51x | 658 -> 93 |
| five-seven | 0.97x | 0.73x | 475 -> 117 |
| mag7 | 1.17x | 1.04x | 968 -> 28 |
| m0nesy-awp | 0.59x | 0.57x | 325 -> 28 |
| **m249** | 0.59x | **0.87x** | 377 -> 316 |

The model is called SEVEN times less often, yet time drops only 10–25%: the saving is eaten by the second
decoding, 3.44 ms/frame paid twice. `m249` is an outright loss — with dense
fire the windows around shots cover almost the whole video, there's nothing to save.

The scheme wins only where there are few shots AND the counter is readable. Where the counter is silent
(26 clips of 45), there will be a FULL model pass plus the already spent first decoding,
i.e. slower than now. Across the corpus the gain is about zero.

Separately: the cross-check with the flash looks for ORPHANS — flashes without a counter decrement (that's how
the false counter "4 VS 2" on awp-flicks was identified). A model looking only at the neighbourhoods of counter moments
won't find orphans by construction.

### Frame decimation in general: ceiling 0.17x, all of it paid for in quality

With a step of 5 frames analysis runs at 0.247x vs 0.700x — three times faster. But 3.44 ms/frame
doesn't depend on the model at all, so even a free model would only give 0.17x. The whole
decimation headroom is the model's 16.5 ms divided by how many frames it gets, and
the price is missed flashes: at step 5 there are 167 ms between frames, a flash lives 10–20.

### The red counter outline breaks reading, but it costs 0.5% — NOT FIXED

User's observation: on `donk-5100` the last two shots are missed, although the counter is
visible to the very end. The diagnosis was confirmed on pixels: at low ammo CS2 paints
the digit red AND ADDS A NEON GLOW, and the glow passes the threshold on a par with the digit itself.

Frame 5.60 (orange "6") vs 5.80 (red "4"), threshold 190 on max(R,G,B):

| frame | pixels above threshold | mask extent |
|---|---|---|
| orange | 248 | 59x24 |
| red | **909** | **68x36** |

The mask swells 3.7 times, the glow floods the gaps in the digit, and the match with the prototype
collapses. The counter series breaks off exactly at the value 5.

**No single threshold exists: for the two states they are opposite.** For the orange digit
the body lives in 190–249, with only 10 pixels above 250. For the red one the core is SATURATED (382 pixels
≥250), and the glow occupies 190–249. At threshold 250 the red digit reads and the orange one
disappears.

This is the INVERSE of the breakage fixed earlier: back then red ink dropped out of the mask
under Rec.601 luminance, and the threshold was moved to the max over channels (see the header of `glyphs.ts`).
Now the same measure lets the glow through.

**Why it isn't fixed.** Measured on all 50 clips (`eval/flashWhy.ts`, dump `whyAll.json`):
the counter gives an answer on 16 clips, and the tail of confident flashes after its last event
exists only on TWO — `donk-5100` (4 flashes) and `my-skills` (1). Five flashes across a corpus
of 1006 own shots, i.e. less than half a recall point even in the ideal case.
Meanwhile changing the threshold risks breaking reading on the 16 clips where it works.

A side result: 14 of the 16 clips have no tail at all. The "counter, otherwise flash" ladder
works cleanly, and misses at the end of a video on other clips have a different cause.

## Falling back to audio marks when the video stage found almost nothing

Checked on 9 September 2026, direction CLOSED.

**Where the idea came from.** The user brought a clip on which the product path
missed completely: three marks, not one of them lands on any shot even at a tolerance
of a second (`labels/fallen-masterclass-clutch-furia-vs-na-vi-cs2-hig-f533987b.json`,
25 own shots in four bursts). It's a tournament broadcast cropped to
vertical: there's no in-game HUD, the only ammo digits are in the player card next to
the webcam, and all four firefights go through a molotov, where the muzzle flash isn't visible.

Yet AUDIO works on the same clip: 154 candidates at threshold 0.3 cover all
four bursts and hit 20 of the 25 marks at a 150 ms tolerance. Hence the assumption:
since the video stage was left without a signal, why not hand over the audio marks instead of its own.
Currently such a fallback exists only for a technical failure (`WizardApp.tsx`, the `catch` branch).

**Measurement.** 50 clips, 1006 own shots, `scoreDetections`, tolerance 0.05 s,
micro-averaging. Video-path marks were taken from `eval/.cache/speedMarks-flashNet416.json`,
audio ones computed by `detectShotsWithNet` on the same PCM cache.

| variant | F1 | precision | recall |
|---|---|---|---|
| **video path as now** | **60.5** | 68.8 | 54.0 |
| audio only, threshold 0.5 | 32.7 | 20.1 | 88.1 |
| audio only, threshold 0.3 | 31.2 | 18.9 | 89.6 |

Fallback rules — none is better than the current behaviour:

| rule | F1 | precision | recall | fires on |
|---|---|---|---|---|
| marks ≤ 1 | 53.7 | 52.3 | 55.3 | 3 clips |
| marks ≤ 2 | 53.3 | 51.7 | 55.1 | 4 clips |
| marks ≤ 3 | 50.4 | 45.8 | 55.9 | 8 clips |
| marks ≤ 5 | 46.9 | 39.9 | 57.0 | 13 clips |
| marks < 5% of candidates | 52.4 | 49.8 | 55.2 | 3 clips |
| marks < 10% of candidates | 36.6 | 25.9 | 62.6 | 20 clips |
| marks < 20% of candidates | 32.6 | 20.8 | 74.4 | 32 clips |

**Why it doesn't work.** The audio stage takes 88% recall at the cost of 20% precision — that's
3524 extra marks across the corpus. The fallback buys 1–3 recall points for 16–29 points
of precision at any trigger threshold.

**The rule "if video found NOTHING" is unimplementable by construction.** There are no clips with zero
marks in the corpus at all; the minimum is one. The threshold has to be set at "few", not
at "nothing", and that's where the trade-off above already begins.

**On the original clip the fallback would have fired and still been bad:**

    video path       3 marks:    0 of 25 hit,   3 extra
    audio@0.5      133 marks:   20 of 25 hit, 113 extra

The shots are in the audio, but they can only be had with a hundred and thirteen extra marks
on a 47-second video. Deleting those by hand is worse than fixing three.

**What stayed true after the measurement.** On such input the answer IS in the audio, and the video stage
loses it. What's useful is not substituting one stage for the other but two other directions, both
to be measured separately: recognising such input (a broadcast, the counter unreadable, flashes
hidden by smoke) and telling the person about it; or using audio as a hint INSIDE the
video stage, not instead of it.

The clip is deliberately left in the corpus with `complete: false`: the labels were placed by ear
and by frames, the precision of hitting the shot moment is tenths of a second, while the metric is computed
with a 50 ms tolerance. `loadAllFixtures` skips incomplete clips, so it doesn't spoil the corpus numbers,
but it remains material for analysis.

---

## Rhythm fill removed

`fillRhythm.ts` filled gaps inside a burst along the weapon's fire-rate grid
and extended the boundaries outward. By the metric this looked like a big win. It was removed after
listening: on pistol clips the fill turned separate shots
into a continuous spray. On `deagle` two single shots 333 ms apart were
taken for a burst, the gap was split by the period of a DIFFERENT weapon (170 ms, 352 rounds
per minute), and the result was extended by another five nodes — eight marks where there were two
shots.

**The metric didn't see it.** The old rule forgave any group of marks
that overlapped a labeled event. Caught by ear, not by measurement — and it was the third
such case in the session.

Filling WITHOUT extending the boundaries won on every axis at once under the metric of the time,
and the question stayed open. It was closed by an analysis of failures: of 78 failed bursts
not one failed ONLY because of the middle — all 23 "too few inside" cases came paired
with a miss at an edge. On its own, filling didn't add a single burst.

## The event metric corrected by ear

The previous version demanded exact boundaries for every burst and declared defects
that a human doesn't hear. The check: the user went through all 33 clips with bursts
and gave a verdict on each.

| ear verdict | clips | events | credited by old | credited by current |
|---|---|---|---|---|
| good | 19 | 67 | 47% | **98.5%** |
| almost | 5 | 14 | 29% | 57% |
| to review | 3 | 22 | 27% | 59% |
| suppressor | 5 | 22 | **0%** | **22.7%** |

The previous metric wasn't broken entirely: on suppressors it and the ear agreed from the very
start. It overstated strictness wherever a defect is inaudible — and so it steered
development towards fixing burst boundaries that nobody hears.

### What a human actually hears

**Fast fire (period up to 140 ms, 4 shots or more) is one continuous sound.** Neither gaps
inside nor a miss at an edge are audible. `bizon`: 18 marks for 26 shots, verdict —
"all the gaps drown in the sound replacement". Only a hole longer than half a second is audible.

**Slow fire — the ear counts the pops, and what decides is the NUMBER of marks, not their precision.**
`galil`: three shots 179 ms apart, three marks, the last one off by 100 ms — "good".
`neityu`: two or three shots, one mark — a defect. The pair `tec9` (two imprecise marks for
two shots — "good") vs `p250` (one mark for two shots — a defect) settled the
question: precision doesn't matter, the count does.

**A constant per-clip offset isn't a defect** — the silence-trim slider corrects it.
`scar20`: all marks 102 ms late, verdict "all good", while the old metric
failed all four bursts there. The offset is removed before scoring.

**Extra marks in silence are always audible.** They stayed strict.

### A flashbang is a blind spot for both sensors

A flashbang blinds the player and deafens them: a shot can be found neither by the muzzle flash (the screen
is whited out) nor by sound — and the player doesn't hear it either. Such windows drop out of scoring
entirely, together with their marks.

Found by analysis, not by reasoning: on `mp5sd` at 38.5 s there is one mark for seven
shots, and the verdict was "good" — "there's a spray there, but after the first shot a flashbang
goes off". The same answer for `ump45`.

The windows are found by `python/tools/flashbangs.py` from full-frame brightness, the result
is in `eval/flashbangs.json`. The signature is three conditions at once: a sharp rise (rules out smoke),
a plateau (rules out the muzzle flash, which lives one or two frames) and a RETURN to the previous
level (rules out an edit cut — it gives the same instant jump, but the brightness
stays at the new level afterwards). Without the return condition the detector flagged a quarter
of the corpus as flashbangs.

The detector is the weakest link of the whole construction: there are only two confirmed cases.
In its favour, it explained the disagreements on `tec9` and `mp9`, which it
wasn't tuned for: there, three events of four and five of seven lie inside the found windows,
and those are exactly the weak ones.

### The product under the new metric

```
СОБЫТИЯ  F1 82.7  точность 91.0  полнота 75.8   (нашли 141, лишних 14, пропущено 45)
  одиночные 59/82 (72%)   очереди 82/104 (79%)
```

(This is verbatim `pnpm eval` output: events F1, precision, recall; found, extra, missed;
singles and bursts.)

The product didn't change by a single line in the process. This is the difference between what we measured
and what a human hears. **These numbers are not comparable with the per-shot numbers from `pnpm eval` or with
the previous version of the event metric.**

### Overfitting risk

Five thresholds were fitted against 33 verdicts. Three things hold it back: the suppressor clips
stayed at the bottom at every step and never once surfaced; the 0.40 s event gap coincided
with the constant `BURST_GAP_S` that already existed in the project; every relaxation rested
on a mechanism named by the human, not on fitting. The real check is the next
labeled clips.

---

## Clips without a video hint: what is closed by measurement

Five clips in the corpus can't be read by the video path at all: the ammo counter isn't visible, and the muzzle flash
of a suppressed weapon is tiny and rare. The user rejected them by ear, and this is the
only class where the ear and the metric agreed from the very start (13-23% of events vs
98.5% on approved clips).

### There is no separate "suppressor problem"

| | shots | audio finds | median confidence |
|---|---|---|---|
| suppressor, 5 clips | 157 | **154 (98%)** | 0.92 |
| the rest, 28 clips | 771 | 747 (97%) | 0.94 |

No dip: `shotNet` doesn't register the suppressor as a problem, even at threshold 0.5 it finds
97% of muffled shots. The stereo feature "own shot without inter-channel delay" also
survives the suppressor — 94% vs 92%; it is SPATIAL, and a suppressor changes loudness
and timbre, but not the position of the source.

The counter, meanwhile, is dead on four clips of five (the only exception is `zywoo`, 79%,
and that's its AWP half, which works anyway).

So the class is called not "suppressor" but **"clips without a video hint"**, and the problem in them
is shared: audio gives 88-92% of the needed shots at 24-33% precision, and there's nothing to filter the junk with.
The earlier negative result about "a suppressor classifier with its own thresholds" (oracle +1.2,
real rule −1.6) still holds, but it answered a different question.

### Recall is more than enough; precision is lacking

Audio with stereo under the event metric on these five clips: **21 events of 22** vs
5 of 22 for the product. At the cost of 37 groups of extra marks — junk roughly every two seconds,
unlistenable. Of all the junk, 68% lies IN SILENCE (audible), 32% inside bursts
(the metric forgives it, the ear doesn't notice).

### Four closed directions

**Timbre self-similarity.** Hypothesis: your own weapon sounds the same from shot to shot,
footsteps and music don't, so the correct candidates form a dense cluster. Density in
timbre space gave **AUC 0.526**. The reason is apparently that the candidates are already
homogeneous: `shotNet` itself selected impulsive, gunshot-like sounds, and the separation
was measured inside an already sifted set.

**Simple acoustic features.** Loudness 0.649, spectral centroid 0.640, HF/LF
0.637, sound tail 0.572, decay time 0.495, attack sharpness 0.511. For comparison — stereo
gives 0.780. The problem isn't solved by the candidate's own sound properties.

**Rhythm as a filter.** Rejected without measurement, on the user's objection: a single shot
fits no grid by definition, and the filter would throw away exactly what we're looking for.
The measurement below showed that what it would throw away is unreachable anyway — but the objection itself is right.

**Barrel glare around the candidate.** The weapon box is tracked on all five clips
(68-110% of frames), so there was somewhere to look. The rise of "box − scene" in a ±3 frame window:

| | singles / junk | in a burst / junk |
|---|---|---|
| without a video hint | 0.518 | **0.467** |
| control, ordinary weapons | 0.708 | 0.642 |

The control confirms the method works — where there is a flash, the feature sees it.
A suppressed weapon simply has nothing to light up. The 0.467 over 142 candidates inside
bursts is more reliable than 0.518 over 14 singles, and it means there's no signal.

### The main point: single shots are unreachable without video

Singles vs junk in silence, all features together, honest by-clip fold validation —
**AUC 0.721**. What kills it isn't feature quality but class imbalance: **43 real singles
vs 1034 junk**, one to twenty-four.

| keep singles | junk remaining |
|---|---|
| 90% | 716 (69%) |
| 70% | 384 (37%) |
| 50% | 199 (19%) |

Even after throwing away half the real shots we get 21 correct marks against 199 junk ones —
10% precision. With such imbalance even a classifier with AUC 0.9 wouldn't help.

And on these clips singles are **62% of all events** (16 of 26). So what's lost isn't the edge
of the problem but most of it.

A side finding: isolation among CANDIDATES turned out to be a strong negative feature —
of 91 candidates with no other within 0.4 s, exactly ONE was correct.
Junk in silence itself comes in batches: footsteps are a series too.

### What remains

Bursts on such clips are reachable, singles aren't. So the ceiling is 38% of events vs
the current ~20%, plus an honest note in the editor that the audio was only partly read.
