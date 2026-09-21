# 0009. The last tails: OnsetCurveView and media limits

Date: 2026-09-17
Status: accepted

## Context

After ADR 0008, three files remained outside the layers, and each hinged not on structure
but on contents:

- `src/components/OnsetCurveView.tsx` — needed by the wizard and the labeler, but pulled the domain
  types `AudioLike` and `OnsetAnalysis`, while `shared` may import only `shared`;
- `src/lib/mediaAnalysis.ts` — pulled in `i18n` for a single `throw`, while the domain must be
  free of React;
- `src/lib/mediaLimits.ts` — depended on `assert*`, which lived next to the i18n copy.

The `ui` and `utils` zones made these edits: `OnsetCurveView` no longer knows about the domain,
`MediaValidationError` got a `code` field, all four `assert*` moved down
into `domain/video/mediaKind.ts`, `mediaAnalysis.ts` stopped importing i18n.
The blockers are lifted, only the move remains.

## Options

There was one fork: `src/pages/HowItWorksPage.tsx` calls `getMediaLimitCopy`, while
`mediaLimits.ts` itself is interface copy and belongs in the wizard.

1. **Expose `getMediaLimitCopy` in the wizard's public API.** The page takes the texts
   from the wizard — from outside, a feature is visible only through `index`.
2. **Keep `mediaLimits` in `shared`.** Not possible: it imports `domain/video/mediaKind`,
   and `shared` can't pull in `domain`.
3. **Duplicate the list of limits on the page.** The two lists will diverge at the very first
   change of limits.

## Decision

Option 1.

| before | after |
|---|---|
| `src/components/OnsetCurveView.tsx` + `.css` | `src/shared/ui/` |
| `src/lib/mediaAnalysis.ts` | `src/domain/video/` |
| `src/lib/mediaLimits.ts` | `src/features/wizard/model/` |

`src/features/wizard/index.tsx` additionally exports `getMediaLimitCopy` — with a note
in a comment on why the public surface was widened: the "how it works" page
promises the same limits the wizard checks.

`OnsetCurveView` in `shared/ui` imports `react-i18next` — this is allowed, the
`shared-imports-only-shared` rule restricts paths inside `src/`, not packages; the neighboring
`LanguageSwitcher` lives there on the same terms.

## Consequences

- The `src/components/` and `src/lib/` folders are removed. Exactly five layers remain in `src/`:
  `app`, `pages`, `features`, `domain`, `shared`.
- Checks: `tsc` clean, `check:deps` — 0 violations (152 modules, 344 dependencies),
  `build` passed, **tests 212/212** — fully green for the first time: the pre-existing
  `submitToWeb3Forms` was fixed by the `ui` zone in commit `88eb6c8`.
- The feature-based layout (ADR 0001) is fully implemented. The only deviation from the original
  description is that export lives inside the wizard rather than as a separate feature (ADR 0006).
- One discrepancy remains, unrelated to the structure of `src/`: the rule "a test sits next
  to the file it tests" is not followed everywhere — 19 `*.test.ts` files live in `eval/` together
  with the measurement scripts. Only the `tests` zone may touch this, and whether the
  rule applies to `eval/` remains an open question.
