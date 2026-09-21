# 0007. Feedback: logic in shared, dialog in the feature

Date: 2026-09-17
Status: accepted

## Context

Feedback was smeared around: form logic in `src/feedback/`, the slice in `src/store/`,
the dialog and the topic dropdown in `src/components/`. The move ran into the
`shared-imports-only-shared` rule: `siteStore` assembles `feedbackSlice`, which imports
`feedback/form` for `EMPTY_DRAFT` and the draft types.

A different observation turned out to be decisive: **`openFeedback` is called from five places** —
the header, the footer, `FaqPage`, `StatusPage` and the wizard step `EditShotsStep`. The last one
closes the obvious path: if feedback had its own store inside the feature, `features/wizard` would
pull in `features/feedback`, and a feature doesn't import a feature.

Meanwhile ADR 0001 had already assigned `shared/store` to "the shared `siteStore` and its slices" — that is,
`feedbackSlice` by design already lives in `shared`. The question came down to where to put
`form.ts`.

## Options

1. **All the form logic in `shared`, only the dialog stays in the feature.** Zero content
   edits, `form.test.ts` stays next to `form.ts` and isn't split between layers.
2. **Split `form.ts`**: the draft types in `shared`, validation and `buildPayload`
   in the feature. Cleaner in meaning — `shared` would hold exactly what the slice needs. But it's a
   content edit (the `ui` zone), and the test would have to be split between layers (the `tests` zone).
3. **Postpone until `app/` is moved.** Solves nothing.

## Decision

Option 1.

| before | after |
|---|---|
| `src/feedback/form.ts`, `form.test.ts`, `web3forms.ts` | `src/shared/feedback/` |
| `src/store/siteStore.ts`, `menuSlice.ts`, `feedbackSlice.ts` | `src/shared/store/` |
| `src/components/FeedbackDialog.tsx` + `.css`, `TopicSelect.tsx` | `src/features/feedback/` |

The `shared/feedback/` folder extends the ADR 0001 list, where `shared` had only `ui/`,
`lib/`, `store/`, `i18n/`. The name was chosen by the user. Rationale: it's a coherent piece
of subject logic without React, not a utility on the level of `fft`; `domain/feedback` doesn't fit
because `shared/store` can't import `domain`.

The feature is exposed through `index.ts` and exports only `FeedbackDialog`. The dialog
is opened via `openFeedback` from `shared/store/siteStore` — so neither `pages` nor
`features/wizard` know about the `feedback` feature.

## Consequences

- `src/store/` and `src/feedback/` are gone. `src/components/` still has `SiteHeader`,
  `SiteFooter` (the skeleton, will go to `app/`) and `OnsetCurveView` (waiting for the `ui` zone).
- Checks: `tsc` clean, `check:deps` — 0 violations (152 modules, 344 dependencies),
  `build` passed, tests 197/198 — the pre-existing `submitToWeb3Forms` fails,
  now at `src/shared/feedback/form.test.ts`.
- `shared/feedback` is the first case where `shared` holds subject logic rather than
  a utility. If more such pieces appear, it's worth returning to the question of a separate layer
  between `shared` and `domain`.
