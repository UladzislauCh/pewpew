import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { evaluateAll } from './evaluate'
import { loadAllFixtures, PROJECT_ROOT } from './fixtures'
import { createProductionDetector } from './productionDetector'

/**
 * Regression guard over the real labeled clips. They live outside the repository (copyrighted game
 * footage), so this suite reports as skipped on a fresh checkout and only bites once someone has
 * labeled clips locally via `/labeler.html`.
 */
const { fixtures } = await loadAllFixtures()

/**
 * Measures the PRODUCT pipeline — the same one as `pnpm eval`, and the same baseline.
 *
 * This used to run `createDefaultDetector()`, i.e. the spectral pipeline, while the
 * baseline since August 20 describes the product pipeline. Comparing the two is
 * meaningless: the spectral pipeline gives F1 49.7 vs 64.3 for the product one, so
 * the test always failed.
 */
const production = fixtures.length > 0 ? await createProductionDetector(fixtures.map((f) => f.labels.slug)) : null

describe.skipIf(fixtures.length === 0)('labeled example clips', () => {
  const result = evaluateAll(fixtures, production!.detect)

  it('scores every labeled clip', () => {
    expect(result.clips).toHaveLength(fixtures.length)
    for (const clip of result.clips) {
      expect(clip.referenceCount).toBeGreaterThan(0)
    }
  })

  it('does not regress below the committed assistant baseline', async () => {
    let baseline: { aggregate?: { f1?: number }; clips?: Record<string, { truePositives: number; falsePositives: number; falseNegatives: number }> } | undefined
    try {
      baseline = JSON.parse(await readFile(join(PROJECT_ROOT, 'eval/baseline.json'), 'utf8'))
    } catch {
      // No baseline recorded yet — capture one with `pnpm eval --update-baseline`.
    }
    const recorded = baseline?.clips
    if (!recorded || baseline?.aggregate?.f1 === undefined) return

    // COMPARE ONLY OVER CLIPS PRESENT IN BOTH SETS.
    //
    // The test used to take the aggregate F1 as a whole, and any addition to the corpus
    // would drag it down without touching a single line of code: two added clips with
    // precision 8.7% and 21.3% pulled the average from 61.8 to 57.5, and the test stayed
    // red for a month, masking real regressions.
    //
    // The aggregate number depends on the corpus composition, so it can only guard
    // against regressions when the composition is unchanged. The intersection gives the
    // same comparison but an honest one: new clips simply don't participate until the
    // baseline is re-recorded.
    const shared = result.clips.filter((c) => recorded[c.slug])
    if (shared.length === 0) return

    const sum = (pick: (s: { truePositives: number; falsePositives: number; falseNegatives: number }) => number, from: 'now' | 'was') =>
      shared.reduce((n, c) => n + pick(from === 'now' ? c.loose : recorded[c.slug]), 0)
    const f1 = (from: 'now' | 'was') => {
      const tp = sum((s) => s.truePositives, from)
      const fp = sum((s) => s.falsePositives, from)
      const fn = sum((s) => s.falseNegatives, from)
      return 2 * tp + fp + fn === 0 ? 0 : (2 * tp) / (2 * tp + fp + fn)
    }

    // Assistant profile: guard F1 (balances adds and deletes for the user).
    expect(f1('now')).toBeGreaterThanOrEqual(f1('was') - 0.0005)
  })
})
