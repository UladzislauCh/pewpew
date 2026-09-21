# 0008. Entry point, site skeleton and the labeler

Date: 2026-09-17
Status: accepted

## Context

After ADR 0003–0007, what remained outside the layers was the entry point (`main.tsx`), the router
(`App.tsx`), the header and footer, global styles and the labeler — that is, the top and bottom of the app.
This is the last big step of the layout.

A peculiarity: the project has **two entry points** — `index.html` for the product and `labeler.html`
for the labeler. So `index.css` couldn't go into `app/`: `features/labeler`
can't import `app`.

## Options

There was one fork — where the global styles live.

1. **`shared/ui/index.css`.** The styles are common to both entry points, `shared` is available to all.
2. **`app/index.css`** and a copy for the labeler. Duplicated tokens — guaranteed
   divergence.
3. **Leave `src/index.css` in the root** as "outside the layers". Works, but then the root of `src/`
   forever keeps a file that belongs nowhere.

## Decision

Option 1.

| before | after |
|---|---|
| `src/main.tsx`, `src/App.tsx`, `src/App.css` | `src/app/` |
| `src/components/SiteHeader.tsx` + `.css`, `SiteFooter.tsx` + `.css` | `src/app/` |
| `src/index.css` | `src/shared/ui/index.css` |
| `src/labeler/` (6 files) | `src/features/labeler/` |

The header and footer were put directly into `src/app/`, without an intermediate `layout/`: there are
only two of them, and ADR 0001 assigns the root layout directly to `app`.

`features/labeler` has no `index.ts`: nobody imports anything from it, the only entry
is through `labeler.html` → `main.tsx`. The `feature-only-via-index` rule is not violated
because there are no external importers.

Entry point paths were updated in the markup: `index.html` → `/src/app/main.tsx`,
`labeler.html` → `/src/features/labeler/main.tsx`.

## Consequences

- Checks: `tsc` clean, `check:deps` — 0 violations (152 modules, 344 dependencies),
  `build` passed, tests 197/198 (the pre-existing `submitToWeb3Forms`).
- There is no `dist/labeler.html` in the build — and there wasn't before: `vite.config.ts` doesn't
  define a multi-page entry, the labeler lives only in `pnpm dev`. Not a regression of the move.
- Found along the way: **nobody imports `src/app/App.css`** — 119 lines of dead
  CSS. Moved as is; deleting or wiring it up is for the `ui` zone to decide. The third such find
  after `videoExport.ts` (ADR 0005) and `AudioPreview`/`VideoPreview` (ADR 0006).
- `features/labeler` pulls `OnsetCurveView` from `src/components/` and `analyzeMedia`
  from `src/lib/` — both outside the layers. The rules let this pass, but it will become a violation
  when `OnsetCurveView` goes to `shared/ui` and `mediaAnalysis` — to `domain/video`.
  Both transitions depend on the `ui` and `utils` zones.

## How the layout ended up

```
src/
  app/        main, App, SiteHeader, SiteFooter
  pages/      FaqPage, HowItWorksPage, StatusPage
  features/   wizard (+ export), feedback, labeler
  domain/     detection, audio, video
  shared/     ui, lib, store, feedback, i18n
  components/ OnsetCurveView — waiting for the ui zone
  lib/        mediaAnalysis, mediaLimits — waiting for the utils zone
```

The move is finished except for two tails, and both hinge on content edits, not
on structure. The layout order is enforced automatically: `check:deps` is part of
`pnpm build`.
