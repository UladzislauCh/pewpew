# Handoff: shot detection

A document for a new chat. Read it in full before the first code change.

State as of 24 August 2026 (49 labeled clips, 76 tests at the time); the header was brought
up to date on 21 September 2026.

**This scheme no longer ships.** Since 31 August the video stage is the muzzle flash, and since
3 September the wizard runs `detectByFlash`: ammo counter where it is found, flash otherwise.
Current quality numbers are in `docs/HANDOFF-flash.md` ("Current numbers") and
`docs/HANDOFF-ammo.md`. The motion stage stays in the code; everything below describes it as it
was on 24 August.

Today's state of the checks (21 September): 50 fully labeled clips, 1006 own shots;
`pnpm test` 212 of 212; `docs/RESEARCH-journal.md` is ~1780 lines. `pnpm eval` (still the
motion scheme) gives F1 57.5 (P 46.2, R 76.0, sparse 33.6, dense 71.4) on 50 clips, but five
clips have no motion cache and are scored on audio alone, so this is NOT comparable with the
64.8 below.

**The main thing to know before reading the rest: twice in its history this project's numbers
described something other than what ships.** Both cases were found and fixed, but the habit of
checking remains mandatory — the "About the numbers" and "Rules" sections below are not
decoration.

---

## What shipped on 24 August (superseded, see the header)

Two stages, both mandatory.

1. **Audio** — the ShotNet convolutional network produces candidates
   (`src/domain/detection/shotNet/`, weights `public/models/shotNet.json`, threshold 0.3 from
   `MOTION_PARAMS.candidateThreshold`).
2. **Video** — the motion model decides whether the shot is the player's OWN
   (`src/domain/detection/motion/`). Audio cannot tell own from someone else's: AUC 0.546,
   almost a coin flip.

The weapon region is found by a **block classifier** (`src/domain/detection/motion/blockMotion.ts`,
weights `public/models/blockModel.json`): the frame is cut into a 16×16 grid, and the region
becomes the twelve blocks with the highest probability. Motion features in this region are
scored with the weights in `public/models/motionModel.blocks.json`.

The previous scheme — the p10..p45 variability band — remains as a fallback
(`motionModel.json`) in case either of the two new models is unavailable or the block analysis
fails.

**There is one pass over the video.** 256×256 frames are accumulated in the same pass as camera
motion, and everything else is computed from them. The cost is **0.27× real time**: a
one-minute video takes about 17 seconds.

---

## About the numbers (as of 24 August, 49 clips): two different ways to measure

| | F1 | precision | recall | sparse | dense |
|---|---|---|---|---|---|
| `pnpm eval` (how the project measures) | 64.8 | 56.1 | 76.7 | 42.6 | 72.8 |
| honest check with folds by clip | **62.3** | 54.2 | 73.3 | **39.1** | 70.7 |

**The first row is inflated by about 4 points.** The motion model is trained on all 49 clips
without a held-out set, and `pnpm eval` tests it on the same clips. This is proven by a
control: the same training without a held-out set gives 63.8, with honest folds — 59.7.

The first row is only good for watching for regressions. Quality can only be claimed from the
second: it is computed by `pnpm exec tsx eval/trainMotionModel.ts`.

For comparison, the same with honest folds before this session: **59.7**, sparse **35.1**.

---

## What changed in the 21–24 August session

**Five bugs, and none of them showed up as an error.** Three lived in the project before the
session:

- `pnpm eval` measured the OLD spectral flux, not the product scheme. For weeks on end there was
  no way to verify any improvement;
- a stub wrote 22 NaNs where there are actually 16 weapon features — the whole second stage
  fell back to bare audio every time the mask failed to fill;
- the `AudioContext` sample rate was taken from the user's sound card: at 48000 the network
  produces 4518 candidates, at 44100 — 4808. Two people with the same video got different
  marks.

Two were born when moving the block-based region into production and were found by
cross-checking the two paths:

- weapon features were silently zeroed — the frame buffer was released before the object was
  assembled, `frames` got zero, all 16 features went to NaN, and the product path computed
  from the camera alone;
- mean instead of median, quantising differences to a byte, and an unweighted offset search —
  three divergences of the port from what had been measured.

**Spectral flux** (the wizard's fallback and the labeler's autofill) was fixed separately:
duplicate merging was turned off in the default profile, and every shot was found twice.
Precision 54.5 → 58.4, corrections 1075 → 1013.

**Human labeling.** The weapon region is labeled on all 49 clips (`eval/weaponRegions.json`,
46 boxes and 3 "no weapon"). The previous heuristic barely overlaps with them: median IoU
0.065, 31 clips out of 46 below 0.2. This is a reference that did not exist before.

---

## Where the ceiling is

**Recall above 85.5% is unreachable with any filter.** Out of 1163 own shots, 1103 (94.8%) have
a candidate, but only 994 get THEIR OWN candidate: in a dense burst several shots share one
nearest candidate.

But **this ceiling is not where it hurts**: 106 of these 109 losses are on dense clips, where F1
is already 72.8. On sparse clips, where the product falls apart, three shots are lost. The gap
for the lost ones is a median of 1.3 frames, i.e. video cannot bring them back in principle.

**The ideal filter's ceiling is 92.2, 94.3 on sparse clips.** The headroom is huge: 30 and 56
points.

**Extra marks are broken down:** 56% are duplicates on already-found shots (median 57 ms),
7% are misses outside the tolerance, and only 36% are real noise.

---

## What is closed by measurement

| direction | result |
|---|---|
| more labeled clips | +5.3 points on a sevenfold increase, spread ±5–8 |
| more model capacity | HURTS: 62.1 → 56.8 → 52.7 at 8/16/32 hidden |
| a correct weapon region | squeezed dry: human 62.9 versus auto-search 62.3 |
| pixels instead of summaries | +0.5 overall, +0.9 on sparse, plateau in resolution |
| lowering `minGapMs` | worse at equal recall: duplicates, not new shots |
| merging duplicates by time | destroys recall, checked three ways |
| "the viewmodel does not move with the camera" | AUC 0.528, a coin flip |
| soft block weights | worse than a hard top-12 selection |
| offset compensation | does not pay off: 0.771 versus 0.774 |
| stereo-width gate | hurts at any threshold |

Plus nine directions closed before the session — see `docs/RESEARCH-journal.md`.

**The common denominator of all failures is transfer between clips.** Forty-nine videos from
different people, with different editing, webcams and overlays; the model learns videos, not
shots.

---

## What to do next

1. **Demos** (`docs/DEMO-recording.md`). Not as "more data" but as data of a different kind:
   frame-accurate ground truth and, most importantly, labeled NON-shots — running, jumping,
   reloading, weapon switches. The corpus has none of them at all, and they are a third of
   the extra marks. Pilot — Glock and Deagle, NOT AK-47: the failure sits in sparse clips, and
   those consist of pistols and snipers.
2. **Python as an oracle** (`docs/PYTHON-track.md`). Measuring the upper bound with the browser
   constraints removed — it answers how much of the headroom up to 92.2 is reachable, before
   paying for the infrastructure.
3. The motion threshold of 0.5 is not F1-optimal (0.65 gives 63.0 and 24% fewer extra marks at
   the cost of 7.5 points of recall). This is a product decision, not a metric one — change it
   deliberately.

What NOT to do: keep improving the weapon region, or look for shots in video where audio did
not find them. Both are closed by the measurements above.

---

## Rules whose violation breaks measurements

**Count recall only with `scoreDetections`** — strict one-to-one matching. In a single session
two other methods gave a wrong answer, and both looked convincing: counting by candidates is
not allowed (1301 candidates for 1163 shots, "100%" comes out against a ceiling of 94.8%), and
not counting duplicates is not allowed either (it systematically flatters small `minGapMs`,
which is why a closed direction first looked like a win).

**Compare at EQUAL recall.** A table at a fixed threshold shows movement along the curve, not a
shift of the curve. Because of this we nearly closed a working direction and nearly opened a
dead one.

**Measure along two independent paths and cross-check.** The session's five bugs were found
only this way. Each path on its own gave a plausible number — 64.8 and 66.0 — and both looked
like success. The six-rule cross-check protocol is in `docs/PYTHON-track.md`.

**Look at sparse and dense clips separately.** The aggregate number is weighted towards dense
fire (902 own shots out of 1163) and describes no real video: 42.6 versus 72.8.

---

## State of the checks (as of 24 August; today's state is in the header)

- `pnpm exec tsc -b` — clean.
- `pnpm build` — passes.
- `pnpm exec vitest run` — **76 of 76**. At the start of the session 8 of 75 were failing; all
  fixed in substance, not by adjusting expectations.
- `pnpm eval` — F1 64.8, block scheme, no regression against the baseline.

Running the app: `pnpm dev`, port 5173 (config `.claude/launch.json`, name `pewpew`).

Caches in `eval/.cache/` (not in git, about 600 MB): zone motion, per-block differences, frame
stacks, region signals. Without them `pnpm eval` falls back to the previous scheme and says so.
How to recompute them is in `eval/README.md`.

---

## Where to find the reasoning

`eval/README.md` — all of this session's measurements with tables, including negative results
and warnings about how NOT to measure.

`docs/RESEARCH-journal.md` — a research journal (~1500 lines on 24 August, ~1780 now), moved over from `pewpew_c`. It
has nine directions closed before this session, and there are more of them there than
confirmed ones.

`docs/DEMO-recording.md` — the demo recording spec.
`docs/PYTHON-track.md` — the Python pipeline and the protocol for cross-checking two
implementations.

A rule from there worth carrying over: **check by measurement, not by reasoning**, and look not
only at "does the feature discriminate" but also at "what SHARE of the errors does it address".
