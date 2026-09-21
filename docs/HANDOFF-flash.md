# Muzzle flash: the YOLOv8 video stage

Written 31 August 2026, extended through 7 September; the header and the summary below were
brought up to date on 21 September 2026. Read together with `docs/HANDOFF-ammo.md` — that
covers the ammo counter, which is the first rung of the shipped ladder.

## Current numbers (checked 21 September 2026)

Shipped path: `detectByFlash` as called from `WizardApp.tsx` — one pass over EVERY frame,
the ammo counter where it is found and confirmed by the flash, the flash otherwise, then one
rigid clip-wide shift towards the audio (`alignToAudio`). Model `public/models/flashNet416.onnx`
(v3 weights, 416 square, since 7 September).

| what | value | source, date, corpus |
|---|---|---|
| **event metric, shipped path** | **F1 82.7**, P 91.0, R 75.8 (141 of 186 events, 14 extra) | `eval/eventScore.ts` on `/eval/speed.html` marks, 15 September, 50 clips |
| per-shot, ±50 ms, micro | F1 60.5, P 68.8, R 54.0 | `scoreDetections` on `speedMarks-flashNet416.json`, 9 September, 50 clips, 1006 own shots — BEFORE the 14 September clock fix, not re-run since |
| per-shot with a global shift sweep | F1 67.9, P 78.4, R 59.8 | `eval/flashScore.ts` (best of shifts 0–50 ms), 7 September, 50 clips — the shift sweep partly absorbed the one-frame clock error fixed later |
| speed | 0.577x real time, network 9.69 ms/frame | `eval/speed.ts`, 7 September, 50 clips, WebGPU |

Event and per-shot numbers are NOT comparable (`eval/README.md`, "The event metric corrected
by ear"). A per-shot number for the current path can only be settled in the browser:
`pnpm dev` -> `/eval/speed.html`, then
`pnpm exec tsx eval/flashScore.ts 0.05 eval/.cache/speedMarks.json` and
`pnpm exec tsx eval/eventScore.ts eval/.cache/speedMarks.json`.

All of these are optimistic: the flash model was trained on frames of the same clips. The
"about 4 points" of inflation quoted below was measured for the MOTION model; for the flash
model it has not been measured.

Everything below this section is history unless it says otherwise.

---

## What shipped on 31 August (superseded)

As of 31 August — superseded on 2–3 September by the pure video path with the counter ladder
(see "Current numbers" above and "Manual review of all 50 clips" below):

```
video -> audio (ShotNet) -> candidates -> flash in frame -> marks -> editor
```

The model ran ONLY around candidates, one frame on each side. The mark's time came from
the audio; the flash answered "yes or no". `scoreShotsByFlash` is still in the code but is not
called from the wizard.

| file | what it does |
|---|---|
| `src/domain/detection/flash/detectByFlash.ts` | product stage (since September): every frame, counter ladder, audio alignment |
| `src/domain/detection/flash/scoreShotsByFlash.ts` | the 31 August stage: confirming candidates; not called from the wizard |
| `src/domain/detection/flash/flashWorker.ts` | onnxruntime session in a worker, WebGPU with a wasm fallback |
| `src/domain/detection/flash/letterbox.ts` | frame -> model input, letterboxed rather than stretched |
| `src/domain/detection/flash/decode.ts` | parsing YOLOv8 output and non-maximum suppression |
| `src/domain/detection/flash/detectFlashes.ts` | pass over the whole video — research tool |
| `src/domain/detection/flash/drawBoxes.ts` | box drawing, not used by the product |
| `public/models/flashNet416.onnx` | the shipped model (v3, 416 square, 12.2 MB), four classes: `muzzle_flash`, `tracer`, `zoom_flash`, `zoom_tracer`. The 31 August `flashNet.onnx` (v1, two classes) was removed on 7 September |

---

## Numbers as of 31 August (superseded by "Current numbers" above). TWO DIFFERENT PIPELINES — do not mix them up

Candidate-window pipeline and model v1; the counter row is from 31 August, 45 clips.

| | clips | recall | precision | F1 |
|---|---|---|---|---|
| **browser, around candidates** (`eval/flashBrowser.html`) | 12 | 64.8 | 66.3 | **65.5** |
| same, 100 ms tolerance | 12 | 73.3 | 75.3 | 74.3 |
| python, pass over the whole video (`flash_curve.py`) | 22 (scored on 31 August; 34 curves in `python/out/flash/` by the end of that day, not re-scored) | 60.4 | 82.9 | 69.9 |
| previous motion-based scheme (`pnpm eval`, as of 24 August) | 45 | 76.4 | 52.2 | 62.0 |
| ammo counter, where it is readable | 19 | 81.1 | 82.9 | 82.0 |

The first two rows are the PRODUCT ones. The Python row runs the same model on OpenCV and the
CPU, with different decoding and a different choice of moments: it is a different pipeline,
and its numbers must not be combined with the browser ones.

---

## Speed: 0.699x -> 0.615x -> 0.577x, measured 7 September

The old note "0.19–0.38x, 0.28 on average" was about the MOTION SCHEME and has nothing to do
with the current model path. The reference was taken with `eval/speed.ts` on all 50 clips,
via the product path in the browser, WebGPU.

| state | ×real time | ms/frame |
|---|---|---|
| main before 7 September | 0.699 | 20.55 |
| reading only the letterboxed frame | 0.653 | 19.22 |
| + rectangular input for vertical video | 0.615 | 18.10 |
| v3 weights on a 416 square (shipped, commit `911a1d1`) | **0.577** | network 9.69 |

Recall 59.5, precision 78.0, F1 67.5 — identical in the first three states (`eval/flashScore.ts`,
best global shift). The 416 model gave 67.7, and 67.9 (P 78.4, R 59.8) with `minHotFrames = 2`
at 60 fps; at equal shift it is level with 67.5, so only the speed gain is claimed.

**Where a frame's time goes:** network 11.0–13.5 ms, tensor preparation 3.9, ammo counter
2.44, decoding about 1.0.

**Decoding is NOT the bottleneck** — 9% of the time, and part of it is hidden behind the model.
The comment in `detectByFlash` claiming the opposite is true for the motion scheme.

**3.44 ms/frame do not depend on the model at all** (counter plus decoding). That sets the
ceiling for any frame thinning: 0.17x even with a free model.

Six directions are closed by measurement — tables and explanations in `eval/README.md`:
thinning to 30 fps, skipping frames by brightness (six rules), frames only around audio
candidates, input built directly on the GPU, thinning in general, two passes through the
counter.

### Rectangular input: same weights, different export (superseded on 7 September)

Replaced the same day by the v3 weights on a 416 square; a rectangular export of v3 was
measured and rejected (-0.6% total time, commit `624c5da`). Kept as history.

`--imgsz 640 384` from `model/v2/best.pt`. A square letterboxes a 720x1280 short with padding
over 44% of the area, and the network runs convolutions over it: 8400 anchors versus 5040.
The rectangle removes the padding without touching the frame resolution — the flash stays
26x26 pixels as before. That is what distinguishes it from shrinking the square, which would
compress the flash to 21x21 along with the padding.

Choice by orientation in `detectByFlash`: `displayHeight > displayWidth` — rectangle,
otherwise square. Horizontal videos stay on the square and are NOT VERIFIED by anything: the
corpus is entirely vertical (48 clips 720x1280, one 640x640, one 480x852).

**Marks diverged on 8 clips out of 50**, even though the final metrics matched to a tenth. On
the quick ten-clip set everything matched bit for bit — so an identical total does not mean
identical behaviour, and these eight only show up on the full corpus.

### How to measure

```bash
pnpm dev  ->  /eval/speed.html            # whole corpus, 11 minutes
             ->  /eval/speed.html?set=quick  # ten clips, 2 minutes
pnpm exec tsx eval/flashScore.ts 0.05 eval/.cache/speedMarks.json
```

The reference lives in `eval/.cache/baseline/`. The quick set is good for HYPOTHESES: it
catches neither throttling on long videos nor divergences like those eight clips.

---

## The method's limit: suppressor and scope

Measured on the corpus, pass over the whole video:

| clip | recall | why |
|---|---|---|
| `ak47`, `glock` | 100% | ordinary barrel, large flash |
| `dual-berettas` | 93% | |
| `bizon` | 87% | |
| `m4a1s` | 23% | **suppressor** — there is physically no flash |
| `aug` | 4% | **the scope** covers it |
| `g3sg1` | 0% | **the scope** |

This is not a model defect but the absence of a signal. By the user's decision there is no
fallback path for such clips: the editor opens empty. Falling back to motion is a one-line
change in `WizardApp`; the stage code is intact.

---

## Checked and REJECTED by measurement

**Merging neighbouring marks** (candidate-window pipeline, 12 clips, 31 August). The idea: audio places several candidates per shot, they see
the same flash frame and get confirmed together. It turned out such pairs do not exist — the
audio stage itself keeps a gap of at least 46 ms (minimum over 1034 gaps on the corpus).
Merging at 50 ms cuts legitimately distinct candidates (22% of gaps lie between 46 and 50 ms)
and costs 6.7 points of recall for 3.8 of precision: **F1 65.5 -> 63.6**. Values from 0 to
45 ms change nothing at all.

---

## Two traps that easily cost an hour

**1. Do not put the onnxruntime runtime in `public/` and do not set `ort.env.wasm.wasmPaths`.**
The runtime loads its `.mjs` through a dynamic import, and Vite refuses to import from
`public/`: "this file is in /public ... should not be imported from source code". On the
outside this surfaces as `no available backend found`, which hints at nothing. Without the
override the bundler resolves the URLs itself, and both files ship in the distribution as
ordinary assets.

**2. Do not drop `ort-wasm-*.wasm` from the build as a "duplicate".** There is only one and it
is needed. 25 MB is the price of onnxruntime-web, not a bundler oversight.

Both mistakes were made and neither IS CAUGHT by types or the build: `tsc` is clean,
`pnpm build` passes, the app only fails in the browser. Check this stage with the
`eval/flashBrowser.html` page, not with the build.

---

## How to run all of this

```bash
# export the model from best.pt (needs pip install ultralytics onnx onnxruntime)
python3 python/tools/export_yolo.py --weights model/best.pt --imgsz 640

# check the product code in a real browser
pnpm dev            # -> /eval/flashBrowser.html?limit=12
pnpm exec tsx eval/flashScoreBrowser.ts        # metric and threshold sweep, no pass over the video

# research: pass over the whole video, not the product path
python3 python/tools/flash_curve.py --clips ak47,m4a4
pnpm exec tsx eval/flashScore.ts
```

---

## Manual review of all 50 clips, 2 September 2026

The user watched the whole corpus by eye on the PURE VIDEO PATH (branch `flash-only`: no
audio, the model looks at every frame, the reference for the own flash is derived from the
video). Overall verdict: "the result is good, much better than what is in production now".

The remarks are grouped by MECHANISM, not by clip: the cases repeat, and they are cured by
different things.

### Misses inside bursts — the most common problem, 11 cases out of 16

  dual-berettas   25-26 s: 2 marks for 5 shots; after 29 s a shot is not counted;
                  at the end 1 mark for 3 shots
  kscerato        burst at 18 s missed
  neityu          1 mark at the end, there are more shots
  ump45           burst from 7 s breaks off in the middle
  nova            shot at 15 s missed
  p250            shot right after the first one missed
  xm1014          shot around 15 s missed
  p2000, torzsi   a couple of misses each
  sawedoff        many missed

The cause is known and measured: at 30 fps a flash lives 10-20 ms, a frame lasts 33 ms, and
roughly every third shot falls into no frame at all. By removing audio we also removed the
rhythm-based fill-in that closed these holes.

### The flash is drowned by other light — NEW, not measured

On `ump45` the burst breaks off exactly where a flashbang goes off: the frame is blown out
entirely, and the model stops seeing the flash although the shooting continues. `kyousuke`
is the opposite case — the model takes FIRE (a molotov) for a flash.

Both cases are about contrast: the flash is recognised as a bright spot, and when the
background is itself bright or on fire, the cue breaks. Never checked before.

### A weapon switch breaks the reference — predicted and confirmed

On `mac10` the spray of the main weapon is marked correctly, but after switching to the
M4A1-S there is not a single mark. The reference was built from the large MAC-10 flash, while
the suppressed barrel's flash is smaller and does not fit it. The code has ONE reference per
video and allows one cluster.

### Other players' fire still leaks through — 5 cases

  naked king      4 extra at 10-11 s, 1 at 17 s
  donk-4k-awp     two marks at 10 s, the first is extra
  dual-berettas   3 marks from 24 s, there is no muzzle flash there
  neymar          another player's flash while shooting SCOPED IN taken as own
  kyousuke        fire taken for a flash

Filtering by the reference removed the crude cases (checked on `donk-blast`), but not all.
`neymar` is telling: when scoped in, the own flash itself becomes smaller and closer to the
centre, the reference blurs, and the other player's flash gets through.

### Out of scope by the user's decision

`g3sg1`, `m4a1s`, `mp5sd`, `usp-0` and the start of `my-skills` — suppressor and scope, not
labeled. `scar20` confirmed exactly that: shots while scoped in are missed, outside the scope
they are found correctly.

---

## Anchor of the own flash: chosen by scale, 3 September 2026

During manual review the user found nine marks instead of four on `cs2-m0nesy-donk`. The
breakdown (`/eval/flashWhy.html?only=donk-highlights`) showed that the model gave all nine as
class `muzzle_flash`, but the boxes split in two: the own barrel at 2.5–3.1% of the frame at
0.63,0.54 (4 detections) and a ghost at 0.19–0.41% at 0.72,0.58 (11 detections).

**The old rule chose the anchor by the NUMBER of detections and therefore took the ghost.**
Frequency is backed by nothing: the shooter pulls the trigger a few times, a firefight in the
background can flicker any number of times. Scale is backed — the own weapon is closer to the
camera than anything else: a 10× gap on `donk`, 8× on `neymar`, 35× on the previously
analysed `awp`.

**The work is done by comparable sizes, NOT by a narrow radius.** This was worth checking
separately and is pinned by a test: the ghost does not join the barrel's group even at the
old radius of 0.12, because it differs tenfold. The radius stays as insurance against a nearby
foreign flash, but no analysed clip is fixed by it.

**Several anchors per video means tolerance to weapon switches.** Checked on `dual-berettas`:
there are two barrels there, 13.45% at 0.47,0.57 and 7.18% at 0.73,0.56. The old radius of
0.12 merged them into one anchor and threw away the right pistol's flashes — eight marks. The
scale, meanwhile, is one per video: an anchor smaller than a third of the main one is no
longer the own weapon, and that is what keeps the ghost out when several anchors are allowed.

### Sweep over the corpus

`pnpm exec tsx eval/ownFlashSweep.ts` over the `flashWhySweep.json` dump (50 clips, an hour of
decoding, after which any rule is checked in seconds). **Measuring against labels is not
allowed here** — the labels on some clips are dirty; what is counted is how many marks the
rule removes and on how many clips it removes EVERYTHING.

| rule | marks | removed | clips zeroed |
|---|---|---|---|
| old | 605 | — | — |
| minimum 1 member | 597 | 8 | 0 |
| **minimum 2 (accepted)** | **589** | **16** | **0** |
| minimum 3 members | 584 | 21 | 0 |
| radius 0.12, minimum 2 | 593 | 12 | 0 |
| single anchor, minimum 2 | 550 | 55 | 0 |

No rule zeroes a single clip — the risk "one large false box sets the scale and kills the
video" does not show up on this corpus.

Accepted after TWO manual reviews: cluster 0.05, acceptance 0.15, minimum two members, up to
four anchors.

### Narrow cluster, wide acceptance — THESE ARE TWO DIFFERENT DISTANCES

The first version of the change cut correct shots, and it was the manual review that found
it, not the sweep. With a single radius of 0.05, two single shots at the end of `galil`
disappeared (they sat 0.06 from the anchor), as did the first of two AWP shots on
`this-isn-t-legal` (0.149) — even though it was the LARGEST flash in the clip, 6.03%, and only
the distance killed it.

One number was solving two tasks with opposite requirements:

- **the cluster is searched narrowly (0.05)**, otherwise two barrels merge into one.
  `dual-berettas` with a wide radius gives one anchor instead of three, and the right pistol's
  flashes disappear;
- **acceptance is wide (0.15)**, because one barrel's flash wanders with recoil, the scope and
  crop changes between cuts in someone else's edit.

The wide acceptance does not bring the ghost back: on `donk` it is removed by scale, not by
distance.

### Checked by eye, 3 September

Eight clips whose marks changed on the visible path (on the rest the counter answers).

| clip | verdict |
|---|---|
| `donk-highlights` | 9 → 4, "all great" |
| `biguzera-backstabs` | "all great" |
| `galil` | after separating the radii both single shots are in place |
| `this-isn-t-legal` | after separating the radii both shots are in place |
| `tec9` | misses inside dense fire, "fine overall" |
| `p2000` | "90% right" |
| `biguzera-stops` | "fine" |
| `kscerato` | AWP kept correctly, all the suppressed M4 fire cut |

### What this does NOT prove

That the rule is correct outside these eight. The other forty-two rest on the fact that no
clip was zeroed.

`neymar` is NOT fixed by this change: three detections are scattered wider than any cluster,
no anchor is built, the filter does not apply, the foreign flash stays. It is cured by
`minMembers: 1` — then the largest single box sets the scale and the foreign one at 0.41%
against the own 3.14% dies. Not accepted: on seven clips this rule adds a mark each, and the
gain is one.

### Open question: the suppressor

On `kscerato` all the fire from the suppressed M4 is cut — 0.08–0.20% of the frame against an
AWP anchor of 0.70%. The position, however, is THE SAME: 0.60,0.44 versus 0.59,0.43, distance
0.014.

Hence a possible rule: an anchor may be much smaller than the main one if it sits practically
on top of it — the same barrel in frame, a different weapon. The ghost on `donk` does not fit
it; it is 0.098 away from the barrel, not on it.

But the rule is invented for one clip, and there is nothing to check it on: `m4a1s`, `usp-0`,
`mp5sd` are listed as outside the method's scope, "there is physically no flash". `kscerato`
shows this is wrong — the flash is there, just small. Perhaps what needs fixing is not the
threshold but the decision itself to treat the suppressor as out of scope.

### Not fixed by this at all

`m0nesy-awp-flicks`: the flash worked cleanly (three clear AWP detections 0.86–0.92 at one
point 0.72,0.57), but the answer was taken by the COUNTER, which recognised as a counter a row
near the top edge of the frame (y = 0.16) with values `5 3 2 3 2`. The row grows twice — a
magazine between reloads does not do that. This is a separate breakage: the counter has
unconditional priority, and here it cost three correct marks.

## What to do next

0. **Done 7 September: model on a 416 square shipped** (0.577x, F1 67.9 by `flashScore.ts`).
   The original item, kept as history: the user is fine-tuning `model/v2/best.pt` on the same dataset,
   70 epochs. Compare against TWO baselines: the 640 square (0.699x, F1 67.5) and the 384x640
   rectangle (0.615x, same F1). The dataset is the same, so both models are inflated equally
   and the difference between them is real — but the absolute numbers are still inflated by
   about 4 points.
1. **Finish the corpus.** The Python pass stopped at 34 clips out of 45 (curves in
   `python/out/flash/*.npz`, all dated 31 August; the table above scored the first 22). The
   browser measurement of the SHIPPED path has since covered all 50 clips (`/eval/speed.html`).
2. **An honest threshold.** The current 0.4 was chosen on the same table we measure on, so the
   number is optimistic. Folds by clip are needed.
3. **Scope and suppressor.** A separate class of problems, postponed by the user.
4. **Compare with the counter at equal recall** where both are readable.
