# 0005. Audio, video and export: the move and the question of translations in the domain

Date: 2026-09-17
Status: accepted

## Context

After ADR 0004, 14 files remained in `src/lib/`: audio, media and export. The move ran into
one question: four of them import `shared/i18n`, which pulls in `react-i18next`.
Per ADR 0001 the domain is logic without React, so they can't be moved "as is".

Analysis showed the question is narrower than it seemed. Translations serve three different things:

| file | why i18n | is it domain |
|---|---|---|
| `videoExport.ts`, `exportWithOutro.ts` | export error messages | no, it's `features/export` |
| `mediaLimits.ts` | the whole file is UI text (`getMediaLimitCopy`) | no, it's UI copy |
| `mediaAnalysis.ts` | a single line `throw new Error(i18n.t(...))` | yes |

Features are allowed to import `shared/i18n`. So for three files out of four the layout itself
resolves the question, without a single code edit.

## Options

The fork remained only for `mediaAnalysis.ts`. It can't be tucked into `features/wizard`:
`analyzeMedia` is called by **two different features** — the wizard and the labeler
(`labeler/LabelerApp.tsx`), and a feature doesn't import a feature. So it must live lower.

1. **Error codes.** `MediaValidationError` carries a `code` instead of ready text, the UI translates
   at the boundary; the four `assert*` move down into `mediaKind.ts`, which already holds the numeric
   limits and has no i18n. Right in the spirit of ADR 0001, but requires editing types and the catch
   sites — the `utils` and `ui` zones.
2. **Allow `domain → shared/i18n`.** Zero edits, but the domain stops being portable
   beyond the browser UI: any script in `eval/` that pulls in `domain/video` will drag in
   i18next. Not worth blurring the rule for one line.
3. **Put `mediaAnalysis` into `shared/`.** Doesn't work: `shared` knows nothing about the product,
   and this is parsing an uploaded highlight.

## Decision

Option 1, but it's done in two steps, and the second step is not the architect's.

**Done now** (12 files, zero content edits):

| before | after |
|---|---|
| `audioContext.ts`, `audioSplicing.ts`, `silenceTrim.ts`, `spliceDefaults.ts`, `spliceReplacementAudio.ts`, `wavEncoder.ts`, `soundLibrary.ts`, `outroAudio.ts` | `src/domain/audio/` |
| `mediaTypes.ts`, `mediaKind.ts` | `src/domain/video/` |
| `videoExport.ts`, `exportWithOutro.ts` | `src/features/export/` |

`outroAudio.ts` went into `domain/audio` rather than the export feature: it's pure audio splicing
without i18n, and `eval/exportWithOutro.test.ts` would otherwise reach into the feature's internals.
`mediaKind.ts` went into `domain/video`, even though its limits cover audio as well.

The export feature got an `index.ts`: only the product path is exposed
(`exportVideoWithBrandedOutro`, `prefetchExportPipeline`, `extendAudioWithOutro`).
Lazy loading is preserved: `await import('./features/export')` in `WizardApp` yields the same
separate chunk (101.45 kB vs 101.46 kB before the move).

**Left for later**: `mediaAnalysis.ts` and `mediaLimits.ts` stay in `src/lib/` until
the error-codes task. After it, `mediaAnalysis.ts` goes to `domain/video/`,
and `mediaLimits.ts` — to `features/wizard/`.

## Consequences

- `src/lib/` — two files instead of thirty. The folder will disappear after the error-codes task.
- Checks: `tsc` clean, `check:deps` — 0 violations (151 modules, 344 dependencies),
  `build` passed, tests 197/198 (the pre-existing `submitToWeb3Forms` fails,
  it also fails on a clean HEAD).
- Found along the way: **nobody imports `videoExport.ts`**. It was moved to
  `features/export/` as is, but not exposed in `index.ts` — only the outro path
  is public. Whether to delete or revive it is for the `utils` zone to decide.
- Paths updated in `docs/AGENT_DETECTION.md`, `docs/AGENT_UI.md`,
  `docs/shot-detection/SUMMARY.md`. In `.claude/agents/detection.md` and
  `.claude/agents/utils.md` the "not moved yet" phrases were fixed — they described
  the state of the move and had become outdated. In `docs/RESEARCH-journal.md` the mentions of
  `src/lib/detection/` were not touched: that directory never existed, it's the history of the entries.
