# Python in the pipeline: what lives where, and how not to end up with two truths

This document answers one question: how to take the ecosystem and pretrained models from
Python without paying for it with what ate the 21–24 August 2026 session — **five bugs, none
of which showed up as an error**, and all five born while porting the same computation between
two contexts.

---

## Principle

**One computation must live in one place.** Where duplication cannot be avoided, it is checked
automatically, on one dataset, by DECISIONS rather than by intermediate series.

Everything else in this document follows from this.

---

## Step 0: Python as an ORACLE, not as a product

The first thing worth doing in Python is not a service but **measuring the upper bound**.

The question it answers: *if all browser constraints are lifted — full resolution, optical flow,
a pretrained backbone, proper training on a GPU — how much better can we do at all on these 49
clips?*

Why exactly this. Four hypotheses are closed today (more clips, more capacity, a correct
region, pixels instead of summaries), and the ideal filter's ceiling is 92.2 against the
current 62.1. The headroom is there, but no lever testable in the browser unlocks it. A Python
oracle answers how much of this headroom is reachable at all, **before** paying for the
infrastructure.

What to feed it: the same candidates (`eval/.cache/blockSignals.json` and the manifests already
exist), the same 49 clips, the same check with **folds by clip**, the same `scoreDetections`
metric. Otherwise the result is comparable with nothing.

**The fork depending on the result:**

| the oracle gives | conclusion |
|---|---|
| does not noticeably beat 62.3 | no server needed, the question is closed cheaply |
| beats it, but the model fits in the browser | path A below: Python trains, the browser computes |
| beats it, and only with a large model | path B, and now the size of the prize is known |

This is the only step worth doing unconditionally: it is cheap and it alone can close the
whole question.

---

## Path A: Python trains, the browser computes

The product does not change: free, offline, instant. Python lives separately and hands over
only weights — exactly as already done with ShotNet.

**The key detail: Python does NOT rewrite feature extraction.**

The browser dumps tensors to a cache, Python reads the file. This technique was already worked
out in the session and paid off instantly:

| cache | what is inside | size |
|---|---|---|
| `blockDiffs.bin` | per-frame differences over 256 blocks | 8 MB |
| `stacks.bin` | frame stacks of the weapon region | 60–300 MB |
| `blockSignals.json` | region offset series | 0.6 MB |

After one decoding pass, sweeping representations runs locally in seconds — fourteen weighting
schemes took seconds instead of an hour.

This way there is no duplication of extraction at all: the only implementation is the one in
production.

Only weights travel back, as `public/models/*.json`. There is one requirement for the model:
it must fit in the browser and run in fractions of a second per candidate.

---

## Path B: inference on a server

Opens up any model, but the price is high, and it must be known in advance:

- **waiting will grow.** A one-minute video is 50–150 MB. Uploading over a home connection
  takes from twenty seconds to a minute, against the current 17 seconds of full local
  analysis;
- **money for every user** — traffic, compute, storage;
- **other people's game recordings on your disk** — a separate conversation, not a technical
  one;
- **no more offline.**

Go here only after the oracle has shown the size of the prize, and only if the prize justifies
these costs.

---

## What lives where

```
pewpew/                      product, TypeScript, the single truth about extraction
  src/domain/detection/motion/            motion features and the weapon region
  src/domain/detection/shotNet/           audio stage
  public/models/*.json       weights, the only thing that arrives from Python
  eval/                      measurements, browser pages that dump caches
  eval/.cache/               tensor caches — input for Python (not in git)

pewpew-research/             separate repository, Python
  data/                      symlinks to eval/.cache and labels/
  train/                     training, experiments
  export/                    exporting weights to the public/models/ format
  verify/                    cross-check against the product (see below)
```

The split into repositories is deliberate: Python has its own dependencies and its own rhythm,
and it must not end up in the product build. The link between them is two files: the tensor
cache goes there, weights come back.

---

## How to cross-check the two sides

The protocol is derived from a session where each point was paid for with a separate bug.

**1. Cross-check DECISIONS, not series.** Pixels from two decoders are different by
definition, and per-offset series will necessarily diverge. What to look at is whether the
marks the user will see change. The established noise band: 0.1–0.3 points of F1 and 98–99%
of decisions matching.

**2. Cross-check PER CANDIDATE, not by summaries.** Summaries hide breakage behind plausible
numbers: the product path computed from the camera alone (all 16 weapon features were NaN) and
gave F1 66.0 — higher than the reference 64.8. It looked like success.

**3. Isolate one factor.** The first version of the cross-check changed both the frame source
and the block selection scheme at once, and gave a 0.3-point divergence that meant nothing.

**4. Keep a hook for intermediate values.** The region, camera motion, offset and scores live
inside one function; without exporting them, a divergence is localised by guesswork. In
production these are `onMotionTrace` and `onRegionPicked`.

**5. Look at the sign per clip, not at the mean.** "The browser is better on 10, worse on 12,
the same on 24" is noise. "Worse on 30 out of 46" is a loss, even if the mean moved by a tenth.

**6. Count recall only with `scoreDetections`.** Strict one-to-one matching. Counting by
candidates is not allowed (1301 candidates for 1163 shots, "100%" comes out against a ceiling
of 94.8%), and not counting duplicates is not allowed either (the method systematically
flatters small `minGapMs`). Both methods gave a wrong answer in a single session, and both
looked convincing.

---

## What not to do

**Do not rewrite feature extraction in Python "because it is more convenient".** That is
exactly the step that produces two truths. If Python needs an input the browser cannot provide
(optical flow, full resolution), then this is already path B, and that is what needs deciding,
rather than quietly starting a second implementation.

**Do not start with a service.** Start with the oracle. A service without a measurement is
infrastructure for an unknown prize.

**Do not change the metric.** Folds by clip, `scoreDetections`, sparse and dense separately.
Otherwise the numbers from Python are not comparable with the seventeen commits of
measurements that already exist.
