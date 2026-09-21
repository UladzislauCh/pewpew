---
name: video-analysis-optimizer
description: Tuning gunshot-detection parameters in video — thresholds, weights, windows, radii. Use whenever a number in detection changes: measure on the corpus first, then sweep a range, decide only at equal recall. Contains the measurement rules whose violation has already produced a wrong answer.
---

# video-analysis-optimizer

A skill for tuning gunshot-detection parameters: the audio stage, the ammo counter,
the muzzle flash. Apply it every time a number that affects detection quality changes.

## Three measurement rules

Each one was paid for with a mistake. Breaking any of them yields a convincing but wrong answer.

1. **Count recall only through `scoreDetections`.** Two other methods gave wrong results
   within a single session, and both looked plausible.
2. **Compare at equal recall.** A table at a fixed threshold shows movement along the curve,
   not a shift of the curve itself — that is, not an improvement.
3. **`pnpm eval` numbers are inflated by about 4 points:** the model is tested on the clips
   it was trained on. Claim quality only from
   `pnpm exec tsx eval/trainMotionModel.ts` — the honest cross-validation by folds.

Two more traps, each of which has already fired:

- **Measure the detection metric before sound replacement.** In the product the replacement
  is placed 100 ms before the mark (`REPLACEMENT_LEAD_SECONDS`). If that offset leaks into the
  marks, the metric drops from 80.7 to 58.2 by construction.
- **The aggregate score is blind to swapped marks.** The number found can stay the same
  when a correct mark is replaced by a false one. Check per clip, not just the total.

## Workflow

1. **Don't guess — measure.** First measure the current state on the corpus, then make
   the change. Without a reference number, "it got better" means nothing.
2. **Sweep a range, don't try a single value.** One result doesn't separate an improvement
   from noise; you need the shape of the curve across the range.
3. **Decide on both criteria at once:** recall and precision. Gaining one at the cost of
   the other is not a win, it's movement along the curve (rule 2).
4. **Lock in a win** by changing the constants where they live and recording it in
   `docs/HANDOFF-flash.md` — with before and after numbers.

## Where things are

| what | where |
|---|---|
| standard measurement | `pnpm eval` → `eval/run.ts` |
| honest fold cross-validation | `pnpm exec tsx eval/trainMotionModel.ts` |
| recall counting | `scoreDetections`, see `eval/evaluate.ts` |
| muzzle flash | `src/domain/detection/flash/` — `thresholds.ts`, `ownWeapon.ts`, `intervals.ts` |
| ammo counter | `src/domain/detection/ammo/` — `scan.ts`, `reader.ts`, `align.ts` |
| motion and audio | `src/domain/detection/motion/`, `src/domain/detection/shotDetection.ts` |
| label audit | `pnpm exec tsx eval/ammoAudit.ts` |

There is no `src/lib/detection/` directory in the project. No `sweep*.mjs` scripts either —
write sweeps under `eval/` in tsx, like the other measurements.

## Before drawing conclusions

Read `docs/HANDOFF-flash.md` in full: it has the current numbers, the measured limits and the
list of directions already closed by measurements. The recall ceiling of the audio stage is
85.5%, and video doesn't raise it. The counter's 42% coverage is the ceiling imposed by other
people's editing, not an unfinished job.
