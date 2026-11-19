# 0014. The shared/analytics module for event tracking

Date: 2026-11-19
Status: accepted

## Context

Since ADR 0011 Google Analytics is no longer loaded from `index.html`: `src/app/analytics.ts`
injects the gtag.js script by hand and only when `VITE_GA_ID` is non-empty. That covers page
views and nothing else — the project sends no events of its own.

Two facts are worth sending, and they become known in two different places:

- a person successfully supplied a clip — in `src/features/wizard/components/VideoDropzone.tsx`;
- a clip was rejected — in `src/features/wizard/store/projectSlice.ts`, where the reason is decided.

Both sit in `features/wizard`, and the import rule `features-no-upper-layers` (ADR 0002)
forbids a feature from importing `app`. So the primitive that pushes into `window.dataLayer`
cannot live next to the setup code in `app/analytics.ts`, even though the two belong to the
same vendor integration.

The `dataLayer` queue also has a trap of its own: gtag.js reads `arguments` from the pushed
object, so `dataLayer.push({ ...args })` or a pushed array silently produces hits that GA
never interprets. That requirement has to be written down in one place, not rediscovered.

## Options

1. **Export a `track` function from `src/app/analytics.ts`** and call it from the wizard.
   One file for the whole integration, but it inverts the dependency direction: a feature
   would import `app`, which `pnpm check:deps` rejects. Relaxing the rule for a single helper
   would cost an amendment to ADR 0002 and open the layer for everything else.
2. **Put the primitive in `src/shared/lib/`**, next to `fft` and `resample`. The layer is
   reachable from both `app` and `features`, but `lib` is pure, testable computation with no
   globals — a `window.dataLayer` queue is a vendor-integration side effect, and mixing the
   two makes the folder stop meaning anything.
3. **A new top-level `src/shared/analytics/track.ts`.** One concern, one file, no barrel,
   imported by direct path from both `app` and the feature — the same shape as
   `shared/config` (ADR 0011) and `shared/feedback`.

## Decision

Option 3. `src/shared/analytics/` is created with `track.ts`.

Responsibility splits along the line of "what the layer is allowed to know":

- `src/app/analytics.ts` keeps script injection and the `VITE_GA_ID` decision — the only place
  that knows whether analytics exists at all;
- `src/shared/analytics/track.ts` holds the queue primitive, the `arguments` contract and the
  event-sending functions.

The import rule doesn't change: `shared` still depends only on `shared`, and
`.dependency-cruiser.cjs` is untouched, so ADR 0002 needs no amendment.

This does establish a new allowed edge: a feature's store slice may call a shared side-effect
helper. The precedent is `shared/feedback/web3forms.ts`, called from the feedback feature — a
slice already reaches a shared module that talks to the outside world.

### Rules this ADR exists to protect

- **One owner of the global.** The `arguments` requirement is documented in exactly one file,
  `track.ts`. There must never be a second `declare global { interface Window { dataLayer } }`
  anywhere in `src/` — two declarations of the same global drift apart, and the one without the
  comment is the one that gets copied.
- **`track.ts` reads no env and never creates `dataLayer`.** Only the setup path creates the
  queue. With an empty `VITE_GA_ID` a self-creating queue would accumulate events nobody
  drains, and a late-arriving gtag.js could then flush stale hits. No queue means a silent
  no-op, which is the correct behaviour when analytics was never switched on.
- **Rejection tracking has a single funnel inside the project slice.** `rejectVideo` looks like
  that funnel and is not: it covers only `type` and `size`. The reasons `duration`, `tooLarge`,
  `audioTooHeavy`, `noAudio` and `analysis` are written by separate direct
  `set({ analysisProblem })` calls inside `analyzeProject`. Instrumenting the obvious-looking
  place would silently under-report exactly the interesting failures, so the send has to sit
  where every reason passes.
- **`video_upload` is sent from the component, not from `setVideoFile`.** That setter is also
  the clip-replaced and clip-cleared path, so it isn't a 1:1 stand-in for "a person
  successfully supplied a clip". The resulting asymmetry — one event from a component, one from
  the store — is deliberate: each send sits where the fact first becomes known.

### Event taxonomy

| event | parameters |
|---|---|
| `video_upload` | clip size in megabytes |
| `video_rejected` | `reason` |

`reason` carries `ProjectProblem` values rendered in snake_case (`too_large`,
`audio_too_heavy`, `no_audio`) to follow GA4's naming convention. The TS union and the GA
parameter are deliberately not spelled the same, so there must be an explicit mapping rather
than a raw interpolation of the union value.

## Consequences

- `src/shared/` gains a fifth non-UI concern folder. The pattern is now established: one
  concern, one file, no barrel, direct-path import — not a dumping ground under `lib`.
- A feature store slice calling a shared side-effect helper is a precedent future code will
  follow. It stays acceptable only while the helper is a leaf: no React, no store, no env.
- Nothing is tracked at all when `VITE_GA_ID` is empty, which is every local dev session.
  These events therefore cannot be verified by running the app locally — GA4 DebugView on
  production is the only check.
- Content edits are not the architect zone:
  - `src/shared/analytics/track.ts` and `src/app/analytics.ts` — `utils`;
  - the two call sites in `src/features/wizard/` (the drop zone component and the project
    slice) — `ui`.
