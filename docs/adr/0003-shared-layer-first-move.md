# 0003. First move: the shared layer

Date: 2026-09-17
Status: accepted

## Context

ADR 0001 recorded the feature-based layout, ADR 0002 — automatic import checking.
But `src/` had not a single folder of the new layout: all eight rules of
`.dependency-cruiser.cjs` were checking emptiness, and the move had not started.

A first step was needed: small enough to keep the risk low, and real enough
for the rules to start working on live files.

## Options

1. **Start with `domain/detection`** — the biggest win, `lib/` stops being a dumping ground.
   But that's ~35 files, ~15 importers in `eval/` and 18 documents in one go.
2. **Start with the `app`/`pages` skeleton** — sets the shape from the top, but the upper layers
   are the most coupled, and the "feature only through index.ts" rule immediately runs into
   features not yet moved.
3. **Start with `shared`** — utilities without imports (`fft`, `resample`), i18n and three shared
   UI elements. Few importers, contents don't change, the dependency direction
   is guaranteed not to be violated: `shared` looks nowhere.

## Decision

Option 3. Moved into `src/shared/`:

| before | after |
|---|---|
| `src/lib/fft.ts` | `src/shared/lib/fft.ts` |
| `src/lib/resample.ts` | `src/shared/lib/resample.ts` |
| `src/i18n/index.ts` | `src/shared/i18n/index.ts` |
| `src/i18n/locales/` | `src/shared/i18n/locales/` |
| `src/components/ErrorBoundary.tsx` | `src/shared/ui/ErrorBoundary.tsx` |
| `src/components/LanguageSwitcher.tsx` + `.css` | `src/shared/ui/LanguageSwitcher.tsx` + `.css` |
| `src/components/Dropzone.css` | `src/shared/ui/Dropzone.css` |

All candidates were checked for purity: `fft` and `resample` import nothing,
`ErrorBoundary` — only React, `LanguageSwitcher` — `react-i18next` and its own `i18n`,
`i18n` — packages and locales. No content edits were needed, only import lines.

Order of further moves — one plan per step, bottom up:
`domain/detection` → `domain/audio` and `domain/video` → `features/feedback` →
`features/wizard` → `features/export` and `features/labeler` → `app`.

## Consequences

- `src/shared/` exists, the ADR 0002 rules check real files:
  `check:deps` — 151 modules, 342 dependencies, no violations.
- `src/i18n/` and `src/lib/fft.ts`, `src/lib/resample.ts` are gone; `src/components/`
  remains, three files left it.
- `src/lib/*` temporarily imports `../shared/i18n`. When these files become `domain`,
  the dependency on i18n will have to be reconsidered: `domain` is logic without React, while
  `shared/i18n` transitively pulls in `react-i18next`. The rule doesn't catch this now (only direct
  dependencies are checked), but at the `domain/audio` step the question will come up — for the
  `utils` zone to decide.
- Three forks remain open and await the user's decision: `feedbackSlice` in the shared
  `siteStore` pulls in `feedback/form` and after the move will violate `shared-imports-only-shared`;
  `src/types.ts`, `src/data/weaponTemplates.json` and `src/hooks/useVideoReplacementAudio.ts`
  don't obviously fit a layer; `src/shared/lib/fft.ts` and `src/lib/shotNet/fft.ts` are duplicates,
  whether to merge them is for the `detection` zone to decide.
