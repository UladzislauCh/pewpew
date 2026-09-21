# 0010. The weapon-samples folder is removed

Date: 2026-09-21
Status: accepted

## Context

`weapon-samples/` held 33 MB of raw CS2 gunshot recordings — one subfolder per weapon.
They never made it into git: `.gitignore` let through only `weapon-samples/README.md`,
because these are third-party game assets.

The samples were needed for exactly one thing: a one-off run of `pnpm gen:weapon-templates`
(`scripts/generateWeaponTemplates.ts`), which folds them into numeric fingerprints
`src/domain/detection/weaponTemplates.json` (80 KB, tracked). The app reads
only this JSON — via `hasWeaponTemplates`/`matchWeaponFingerprint`
in `src/domain/detection/shotDetection.ts`.

The occasion was preparing the repository to go public: a folder of third-party audio sat inside
the project tree, where it's easy to catch with `git add -f` or an archive.

## Options

1. **Leave it as is.** Nothing breaks, but 33 MB of third-party assets remain inside
   the folder being published.
2. **Move it outside the project** (`~/pewpew-assets/`), keep the README as a pointer.
   Regeneration stays possible at the cost of wiring the paths by hand.
3. **Delete the folder along with its README.** Regeneration becomes impossible without recording
   the samples again; everything else works, since the JSON is self-contained.

## Decision

Option 3, by the user's choice. Removed: the folder itself and the tracked
`weapon-samples/README.md`.

The derived `weaponTemplates.json`, `scripts/generateWeaponTemplates.ts` and the
timbre matching code were not touched: they live independently of the source recordings.

## Consequences

- `pnpm gen:weapon-templates` has nothing to run on anymore: the script will hit the
  missing `SAMPLES_DIR`. Regeneration will require recording the samples again.
  The risk is small — the "match candidates against weapon timbres" direction was closed by measurements
  (`docs/RESEARCH-journal.md`, "doesn't separate").
- `tsc`, `check:deps` and `build` pass. In `pnpm test`,
  `eval/clips.test.ts` fails — it failed before the removal too, on a clean tree: the
  `examples/` clips aren't available locally. Unrelated to this change.
- Tails remain outside the architect zone:
  - `.gitignore`, lines 32–33, and the `generateWeaponTemplates.ts` script — the `utils` zone;
  - the decision whether the timbre matching path is alive in the product at all, and whether
    `weaponTemplates.json` should be deleted together with the script — the `detection` zone;
  - mentions of the folder in `docs/shot-detection/*` and `docs/RESEARCH-journal.md` — these
    describe past measurements, they don't need to be touched.
