# 0004. Moving the detection domain

Date: 2026-09-17
Status: accepted

## Context

After ADR 0003, `src/shared/` held the first layer of the new layout, but the bulk of the code —
detection — remained in `src/lib/`, mixed with audio, video and export. From the file name
you couldn't tell whether it belonged to the domain or to output utilities.

Detection had, however, already been verified as pure: no file in `src/lib/` imports
React, zustand, the store or components. So the move is mechanical and requires
no content edits.

## Options

1. **Only `detection`, its companions stay in `lib/`.** The domain would reference
   `../../lib/audioTypes` and `../../lib/videoRegions`. The rules allow it, but the domain
   looks into the dumping ground, and the paths get fixed twice — now and at the next step.
2. **`detection` plus the three modules it pulls in.** Along with it, `audioTypes.ts` goes
   to `domain/audio/`, and `videoRegions.ts` with `videoFrameMetrics.ts` to `domain/video/`.
   All three have almost no dependencies. The domain becomes self-contained.
3. **All of `lib/` at once.** Contradicts ADR 0001 ("one feature or domain per plan")
   and mixes the domain with export in a single check.

## Decision

Option 2. 40 files moved:

| before | after |
|---|---|
| `src/lib/{motion,flash,ammo,shotNet}/` | `src/domain/detection/{motion,flash,ammo,shotNet}/` |
| `onsetDetection.ts`, `onsetTypes.ts` | `src/domain/detection/` |
| `shotDetection.ts`, `shotDetectionFusion.ts` | `src/domain/detection/` |
| `audioFingerprint.ts`, `videoShotVerification.ts` | `src/domain/detection/` |
| `weapons.ts`, `weaponTemplates.ts` | `src/domain/detection/` |
| `detectionMetrics.ts`, `labels.ts` | `src/domain/detection/` |
| `src/data/weaponTemplates.json` | `src/domain/detection/weaponTemplates.json` |
| `src/lib/audioTypes.ts` | `src/domain/audio/audioTypes.ts` |
| `src/lib/videoRegions.ts`, `videoFrameMetrics.ts` | `src/domain/video/` |

Two decisions were made separately:

- **`detectionMetrics.ts` and `labels.ts` — in `domain/detection`.** These are the metric and
  the labels, the `eval` zone, and ADR 0001 doesn't list them as part of detection. But both the
  product path and the measurements use them; there's no reason to create a separate layer for them.
- **`weaponTemplates.json` — next to the code that reads it.** The `src/data/` folder
  is gone: its only file is model data, and it belongs in the domain, not in a shared
  data dump.

## Consequences

- `src/lib/` shrank from 30 files and 4 subfolders to 14 files: audio, video
  and export remain. They move in the next plans.
- Imports fixed in ~77 files: 64 in `eval/` (including `legacy/*.mjs`), 4 in `scripts/`
  (including `_exportCandidates.mts`), the rest in `src/`.
- The flash worker moved without edits: `detectByFlash` calls
  `new Worker(new URL('./flashWorker.ts', import.meta.url))` — the path is relative.
  Model weights in `public/models/` were not touched.
- Besides import lines, three places were touched where the path to a moved file was hardcoded
  in text: the `OUTPUT_PATH` constant in `scripts/generateWeaponTemplates.ts` (otherwise the generator
  would write templates into the vanished `src/data/`) and path mentions in comments of
  `src/WizardApp.tsx` and `eval/prodRun.ts`. Wording was not changed, only paths.
- Checks: `tsc` clean, `check:deps` — 0 violations (150 modules, 342 dependencies),
  `build` passed, tests 197/198 — the pre-existing `submitToWeb3Forms` fails,
  it also fails on a clean HEAD.
- Paths updated in 22 documents, including `.claude/agents/detection.md`,
  `.claude/skills/video-analysis-optimizer/SKILL.md`, `eval/README.md`, `python/README.md`,
  `labels/README.md`. In ADRs the old paths are left as history.

Open questions carried over to the next plans:

- `src/lib/{mediaLimits,videoExport,exportWithOutro,mediaAnalysis}.ts` import
  `shared/i18n`, which pulls in `react-i18next`. When these files become `domain`, the dependency
  will have to be broken — for the `utils` zone to decide.
- `src/shared/lib/fft.ts` and `src/domain/detection/shotNet/fft.ts` are duplicates, whether to
  merge them is for the `detection` zone to decide.
- `feedbackSlice` in the shared `siteStore` pulls in `feedback/form`; at the `features/feedback`
  step this will run into the `shared-imports-only-shared` rule.
- `src/types.ts` and `src/hooks/useVideoReplacementAudio.ts` are not yet assigned to a layer.
