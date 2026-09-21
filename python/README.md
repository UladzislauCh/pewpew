# Ammo counter: a direct signal instead of indirect ones

Everything the project did before inferred shots from INDIRECT cues: timbre, attack shape,
camera motion. Yet the frame contains the direct answer: the CS2 ammo counter drops by
exactly one on every one of the player's OWN shots and doesn't react to anyone else's.

## Why the previous attempt failed and what is different here

The counter was already tried, see `docs/RESEARCH-journal.md`. The signal turned out excellent
(AUC 0.982, 33 of 33 own shots produced a change), but finding the region failed: **health and
armour are structurally indistinguishable from ammo**: same font, same size, same recurrence.
The number of events matched the number of shots in one clip out of 49.

The reason is that the previous approach COUNTED CHANGES, and a change looks the same for ammo
and for health. Here the VALUES are read, and then the difference is obvious:

| | behaviour |
|---|---|
| ammo | drops by exactly 1 per shot, jumps back to the magazine size |
| health | drops by any amount (5..40), never returns to the maximum |
| armour | same as health |
| round timer | also drops by 1, but EXACTLY once per second |

Identification works from how the series behaves, not from its position on screen or its
appearance. The position can't be a constant: there are at least three layouts: the native HUD,
a tournament broadcast with its own overlay, and a cropped frame.

## Layout

```
ammo/glyphs.py      threshold, connected components, gluing glyphs into numbers
ammo/scan.py        pass over the clip, stable number positions ("slots")
ammo/reader.py      glyph -> digit via prototypes, slot -> series of values
ammo/identify.py    which slot is the ammo, judged by how its values behave
ammo/events.py      counter decrements -> shot moments
ammo/align.py       moment refined by audio, track desync corrected
ammo/pipeline.py    everything together
ammo/prototypes.json  digit prototypes collected from real frames
```

## Running

```bash
pnpm exec tsx eval/frameTimes.ts            # real frame timestamps (one-off)
pnpm exec tsx eval/videoStart.ts            # the same, shorter, if only offsets are needed
pnpm exec tsx eval/audioCandidates.ts       # ShotNet audio candidates (one-off)
python3 python/tools/run_clips.py     # all labelled clips -> python/out/clips.json
pnpm exec tsx eval/ammoScore.ts             # metric via the real scoreDetections
```

The first two steps are mandatory. Without `frameTimes.json` frame time is computed as
`index/fps` and loses the track's start offset; without `audioCandidates.json` the moments
stay frame-quantised and the desync isn't corrected. Both runs say so if the file is missing.

## The counter knows HOW MANY, the audio knows WHEN

Video can't be more precise than a frame: at 30 fps that's ±33 ms, while the metric uses a
±50 ms tolerance. Worse, in some clips the tracks have simply drifted apart.

Checked frame by frame on `xm1014`: the counter change from 7 to 6 and the muzzle flash sit on
the SAME frame (t=1.70), so the video is self-consistent, yet the transient in the waveform
comes 100 ms later. Same on `g3sg1` (+140 ms), `nova` (+70), `sawedoff` (+65), and in both
directions. The overall median discrepancy is 2 ms, so there's no systematic error in the
pipeline: individual files drift.

So `align.py` does two steps, both **without labels**:

1. **Per-clip global shift**, fitted to the audio candidates, the same ones the product uses.
   Zero is favoured: in a clip with three shots almost any shift will explain something.
2. **Snapping to a candidate** within a 100 ms window, strictly one-to-one and order-preserving.
   Without that, two shots of a burst would collapse onto one candidate, which is exactly the
   way of losing recall that `eval/README.md` warns about.

### Limit of the method: on dense fire the shift is unidentifiable

This isn't unfinished work, it's a property of the problem. In a burst with a 90–100 ms step
both series, counter decrements and audio transients, are periodic with the same period, so a
shift by one shot is indistinguishable from the truth by ANY method that works from audio alone.

Checked on anchors where the answer is known from frames (muzzle flash plus counter change on
the same frame): for `m4a4` the true shift is +70 ms, for `xm1014` +100 ms.

What was tried and rejected by measurement:

| shift estimator | on covered clips | on sparse | result on the m4a4 anchor |
|---|---|---|---|
| from candidates (in use) | **68.7 / 75.4** | **58.9** | 0 ms |
| from the ShotNet probability curve | 65.8 / 72.1 | 54.0 | +195 ms |
| candidates narrow, curve chooses | 66.0 / 72.3 | 54.0 | +195 ms |
| first shots of bursts only | — | — | +215 ms |

By reasoning the curve looked more correct: it has amplitude, and it doesn't suffer from there
being four times more candidates than shots. The measurement said the opposite: it confidently
drifts to the neighbouring shot of a burst. The combined variant won on average only because it
shifted clips that provably must not be shifted.

On dense clips SNAPPING takes over the work of the global shift: it decides for each moment
separately and isn't fooled by periodicity. Hence the 100 ms window: it covers the desync
itself, not just frame imprecision. It can't be wider: candidates are on average 214 ms apart,
and a window larger than half that distance starts reaching the neighbouring transient.
Measured: going from 50 to 100 ms improved 7 clips out of 19 and worsened none.

A side benefit: the share of snapped events is a ready-made plausibility check for the slot.
The player's own shot is always audible, so for a real counter the share is high, while for
the timer, the score and money it isn't. On `mac10` it is 33% against 78–100% for the rest,
and the clip is honestly declared uncovered instead of passing someone else's series off as
shots.

## Measured on 45 of the 49 clips

The metric is the real `scoreDetections`, tolerance ±50 ms. The corpus has 49 clips, but four
(negev, p90, sg553, Torzsi) had their "fully labelled" flag removed because their labels are
unfinished, so scoring runs on the remaining 45.

| | recall | precision | F1 |
|---|---|---|---|
| on covered clips | **76.6** | **80.4** | **78.5** |
| — sparse | 64.2 | 60.3 | 62.2 |
| — dense | 80.7 | 88.1 | 84.2 |
| before audio alignment | 56.4 | 64.9 | 60.3 |

Coverage is 17 clips of those 45, 440 shots of 978 (45%).

The numbers rose for two reasons, and they're worth telling apart. Labels on 22 clips were
relabelled by a human against the counter, which raised F1 from 69.9 to 74.7 with the code
unchanged. Then a fix to event placement (the moment on a frame, not between frames) gave
74.7 -> 78.5, and on sparse clips 49.8 -> 62.2.

Uncovered clips are mostly ones where the HUD is NOT in the frame: the player's webcam over the
bottom of the frame, sponsor banners, third-person view. Not a shortcoming of the reader.

Dependencies: `numpy`, `opencv-python`, `scipy`. No torch and no off-the-shelf OCR here, and
there shouldn't be; see below.

## Port to the product

The reader has been ported to `src/domain/detection/ammo/` and runs inside the product's single
pass over the video frames, `src/domain/detection/flash/detectByFlash.ts`, alongside the muzzle
flash model. The wizard picks the source per clip: the counter if one is found, otherwise the
muzzle flash. The counter is dropped in favour of the flash when most confident flashes have no
counter decrement next to them (a foreign row such as a scoreboard). Audio (ShotNet candidates)
doesn't produce the timings: it helps select the counter slot, and the final marks get one rigid
clip-wide shift towards the sound. The motion stage (`src/domain/detection/motion/detectWithMotion.ts`)
stays in the code but is not called by the product.

Digit prototypes live in `public/models/ammoPrototypes.json`, i.e. they arrive from Python
exactly the same way as the `shotNet.json` weights. The motion-stage `blockModel.json` is no
longer a product model: it moved to `fixtures/models/blockModel.json` and is served only by the
dev server at `/__models/`, for research.

Cross-checking the two implementations: `pnpm exec tsx eval/ammoPortCheck.ts`. It feeds both
sides THE SAME value series from `python/out/seriesDump.json` and compares the decisions: slot
identification, shot extraction, alignment. On 20 clips the moments match bit for bit.

This isolates a single factor, the logic, not frame decoding. Project rule: the first
cross-check in its history changed the frame source and the selection scheme at once and
produced a discrepancy that meant nothing.

What the cross-check has already caught: on tied frequencies Python took the SMALLER magazine
value (argmax over sorted values), while the first port took the first one encountered. On
`sg553` that gave 19 versus 30.

End-to-end check in the browser: `eval/ammoBrowser.html`, 3–25 seconds per clip depending on
length, about nine minutes for the whole set. Analysing the result: `eval/ammoScoreBrowser.ts`
(the product metric) and `eval/ammoCompare.ts` (cross-check against Python).

THE NUMBERS OF THE TWO PIPELINES DIFFER, and they must not be combined:

| | recall | precision | F1 | coverage |
|---|---|---|---|---|
| product (browser) | **81.1** | **82.9** | **82.0** | 19 clips, 465 of 980 shots |
| Python (OpenCV) | 76.6 | 80.4 | 78.5 | 17 clips, 440 shots |

The cause of the discrepancy is fundamental: the browser decoder and OpenCV produce different
pixels, so the value series diverge slightly, and the decisions diverge with them. The product
number is what the user sees; the Python one serves as a guide during development.

Full state of the direction: `docs/HANDOFF-ammo.md`.

## Two rules that must not be broken

**1. No off-the-shelf OCR.** `easyocr`, `tesseract`, `PaddleOCR` would solve digit reading in an
evening and would never ship to the browser. The task doesn't need them: the alphabet is closed
(ten symbols), there's one font, and the size is constant within a clip. The classifier here is
nearest neighbour over a set of prototypes, which rewrites in TypeScript without libraries.

Same for inference: `scipy` and `sklearn` are fine for training and exploration, not in the
path that ships to the product.

**2. The metric is computed by TypeScript, not Python.** `eval/ammoScore.ts` reads shot moments
from JSON and scores them with the real `scoreDetections` from `src/domain/detection`. There is
deliberately no scorer in Python: two implementations of one metric are two truths, and the
project has already paid for that with five bugs in a single session (`docs/PYTHON-track.md`).

## Digit prototypes

They're collected from real frames, not rendered from a font: the HUD is semi-transparent, the
scene moves through the digit, and a synthetic glyph can't reproduce that. The project has
already caught such a signature in synthetic data: a "synthetic versus real" discriminator
reached AUC 0.974.

There are SEVERAL prototypes per digit, and that's not a defect but a consequence of the same
semi-transparency: one symbol comes in several renderings. The previous attempt fought this by
clustering into exactly ten groups and failed (the groups came out 429, 122, ..., 1). Here the
spread of renderings helps the classifier.

Rebuild:

```bash
python3 python/tools/cluster_glyphs.py examples/m4a4.mp4 python/out/clusters.png 0.796 0.790
# look at the image, write down the digits in cluster order, '-' for junk
python3 python/tools/make_prototypes.py examples/m4a4.mp4 0.796 0.790 "12603367094355212886"
```

## The counter is more accurate than human labels

Checked by pixels on `m4a4`, frames 98–112: the counter shows 30 → 29 (frame 101) →
28 (104) → 27 (107), i.e. three shots. The labels have two at that spot (3.46 and 3.66).
The 100 ms interval matches the M4A4 fire rate (666 rounds per minute = 90 ms), while the
labelled 200 ms doesn't.

The consequence for measurements: a disagreement with the labels does NOT equal a counter
error, and the table must be read with that correction. It's also the main value of the
direction: the counter works as a source of labels, not only as a detector.

---

## What label quality is worth: 37 F1 points (31 August 2026)

Measured on the temporal model (`python/tools/temporal_train.py`), honestly with per-clip folds, the
threshold chosen on each fold's training clips.

| labels | clips | own shots | F1 | recall | precision |
|---|---|---|---|---|---|
| **checked by a human against the counter** | 24 | 616 | **66.3** | 64.3 | 68.4 |
| same, trimmed to 18 clips | 18 | 471 | **66.6** | 63.5 | 70.0 |
| **manual, not checked against the counter** | 18 | 320 | **29.8** | 23.8 | 40.0 |

Group size doesn't explain the gap: the clean group trimmed to the same 18 clips gave the
same 66.6. In the dirty group the threshold drifts to 0.97–0.99: the model is poorly
calibrated there because the target jitters.

**The corpus must NOT be split by "counter is readable"**, tempting as it is, and one
measurement in this branch tripped over it. The sets don't coincide: nine readable clips
still had manual labels, and four relabelled clips aren't read by the counter at all.
Splitting by `covered` gave a 20-point gap instead of 37: the relabelled clips pulled the dirty
group up. The right criterion is edit history (`CHECKED_COMMITS` in `python/tools/temporal_train.py`),
because relabelling didn't update `labeledAt`.

Control on the same group, corrupting the TRAINING target while keeping the true validation
labels: 15 ms jitter costs 5 points, 30 ms costs 10, dropping 7% of labels costs 5.

Practical conclusion: **labels are the project's most expensive resource**, more expensive than
any feature or architecture tried here. A measurement on unchecked labels halves the apparent
quality and can reject a working direction.
