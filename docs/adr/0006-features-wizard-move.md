# 0006. Moving the wizard, and export inside it

Date: 2026-09-17
Status: accepted

## Context

The wizard was smeared across five folders: `src/wizard/`, `src/WizardApp.tsx`, seven slices
in `src/store/`, ten components in `src/components/`, a hook in `src/hooks/`. Everything was
organized by file type, nothing by scenario. It's the most coupled node in the project and the last
big one after ADR 0003–0005.

## Options

1. **Move the wizard whole, leave shared components in place.** `OnsetCurveView`
   is needed by both the wizard and the labeler, but it can't go into `shared/ui`: it pulls the types
   `AudioLike` and `OnsetAnalysis` from `domain`, and `shared` imports only `shared`
   (and `tsPreCompilationDeps` counts `import type` too).
2. **First make `OnsetCurveView` "dumb"** (accepting a `Float32Array` and a ready-made
   curve), then move. More correct in essence, but it's a content edit — the `ui` zone,
   and it would block the move.
3. **Allow `shared/ui → domain`** by editing `.dependency-cruiser.cjs`. Blurs the meaning
   of the layer for the sake of one component.

## Decision

Option 1. 45 files moved:

```
src/features/wizard/
  index.tsx    public API: WizardApp, resetWizard, useWizardStore, layout styles
  WizardApp.tsx  WizardLayout.tsx/.css  StepsBar.tsx
  steps/       11 files (formerly src/wizard/steps/)
  components/  17 files (formerly src/components/)
  store/       wizardStore + 6 slices (formerly src/store/)
  model/       navigation.ts, types.ts, analysisProgress.ts,
               useVideoReplacementAudio.ts (formerly src/hooks/),
               audioAsset.ts (formerly src/types.ts)
  export/      exportWithOutro.ts, videoExport.ts
```

`src/wizard/`, `src/hooks/`, `src/types.ts` became empty and were removed.

**Export moved inside the wizard — this refines ADR 0001.** There `features/export`
was listed as a separate feature, but a check showed: `exportWithOutro` is called only by
`WizardApp`, and under the `feature-not-other-feature` rule a feature can't import a feature.
Export is not a standalone scenario: it has neither its own screen nor its own entry point.
The alternatives are worse — `domain/export` would pull in `shared/i18n`, exactly what ADR 0005
rejected for `mediaAnalysis`; weakening the rule for a single case is even less worth it.

Two small things that came up during the move:

- The feature's `index` is `.tsx`, not `.ts`: it re-exports a component and imports css,
  which doesn't type-check with `.ts`. The `feature-only-via-index` rule allows both
  extensions.
- The slice tests in `eval/` import `features/wizard/store/wizardStore` directly,
  not through `index`: `eval` is built without jsx and can't pull in `.tsx`. `eval/` is not
  covered by `check:deps`, the rule is not violated.

`WizardLayout.css` is now loaded from the feature's `index.tsx`, not from `App.tsx`: from outside the
feature is visible only through `index`, and its layout should arrive together with it.

## Consequences

- `src/components/` — five files: `SiteHeader`, `SiteFooter` (the skeleton, will go to `app/`),
  `FeedbackDialog`, `TopicSelect` (the feedback feature) and `OnsetCurveView`.
  `src/store/` — `siteStore`, `menuSlice`, `feedbackSlice`.
- Checks: `tsc` clean, `check:deps` — 0 violations (151 modules, 343 dependencies),
  `build` passed, the export chunk stayed separate (101.45 kB), tests 197/198 —
  the pre-existing `submitToWeb3Forms` fails.
- Left for the `ui` zone: `OnsetCurveView` temporarily lives in `src/components/` and is pulled
  by the wizard from outside the feature. Until it becomes "dumb", it can't be moved down into `shared/ui`.
- Left for the `ui` zone: nobody imports `AudioPreview.tsx` and `VideoPreview.tsx` (+ css)
  — delete or revive. Moved to `features/wizard/components/` as is.
- The cascade order of the wizard's styles changed (css is loaded from `index.tsx`). The user
  checks it by eye; if the layout breaks — roll back.
