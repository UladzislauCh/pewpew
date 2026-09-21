/**
 * Metric for the PRODUCTION path result (eval/.cache/ammoBrowser.json).
 *
 * Separate from `eval/ammoScore.ts`, which measures the Python pipeline: their numbers diverged,
 * and putting them in one table is a sure way to confuse what was measured.
 *
 *   pnpm exec tsx eval/ammoScoreBrowser.ts
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scoreDetections } from '../src/domain/detection/detectionMetrics'
import { parseClipLabels } from '../src/domain/detection/labels'
import { PROJECT_ROOT, LABELS_DIR } from './fixtures'

/**
 * Tolerance. 50 ms by default — the MIREX standard and what all previous project measurements
 * use; it must not change in the main number, otherwise there is nothing to compare with.
 *
 * The second argument lets you look at 100 ms. This is not "a more convenient metric" but a
 * different question: a sound replacement 80 ms from the shot sounds right, while the metric counts
 * it as both a miss and an extra label. Checked by the user by ear: their rating of the clips
 * matched the "within 100 ms" column, not recall at 50 ms.
 */
const TOLERANCE_S = Number(process.argv[3] ?? 0.05)
const SPARSE_MAX_OWN = 20

interface Row {
  slug: string
  covered: boolean
  reason: string | null
  times: number[]
  seconds: number
}

async function main(): Promise<void> {
  const path = process.argv[2] ?? join(PROJECT_ROOT, 'eval/.cache/ammoBrowser.json')
  const rows: Row[] = JSON.parse(await readFile(path, 'utf8'))

  const stats: { slug: string; own: number; tp: number; fp: number; fn: number; sparse: boolean; covered: boolean }[] = []
  for (const row of rows) {
    const raw: unknown = JSON.parse(await readFile(join(LABELS_DIR, `${row.slug}.json`), 'utf8'))
    const labels = parseClipLabels(raw, `labels/${row.slug}.json`)
    if (!labels.complete) continue
    const own = labels.shots.filter((s) => s.source === 'own').map((s) => s.time).sort((a, b) => a - b)
    const predicted = row.covered ? [...row.times].sort((a, b) => a - b) : []
    const s = scoreDetections(own, predicted, TOLERANCE_S, [])
    stats.push({
      slug: row.slug,
      own: own.length,
      tp: s.truePositives,
      fp: s.falsePositives,
      fn: s.falseNegatives,
      sparse: own.length <= SPARSE_MAX_OWN,
      covered: row.covered,
    })
  }

  const report = (name: string, group: typeof stats) => {
    if (!group.length) return
    const tp = group.reduce((a, r) => a + r.tp, 0)
    const fp = group.reduce((a, r) => a + r.fp, 0)
    const fn = group.reduce((a, r) => a + r.fn, 0)
    const own = group.reduce((a, r) => a + r.own, 0)
    const p = tp + fp ? (100 * tp) / (tp + fp) : 0
    const r = tp + fn ? (100 * tp) / (tp + fn) : 0
    const f1 = p + r ? (2 * p * r) / (p + r) : 0
    console.log(
      `${name.padEnd(24)} клипов ${String(group.length).padStart(2)}  своих ${String(own).padStart(4)}  ` +
        `полнота ${r.toFixed(1).padStart(5)}  точность ${p.toFixed(1).padStart(5)}  F1 ${f1.toFixed(1).padStart(5)}`,
    )
  }

  console.log('--- по клипам со счётчиком')
  for (const s of stats.filter((x) => x.covered)) {
    const recall = s.tp + s.fn ? (100 * s.tp) / (s.tp + s.fn) : 0
    console.log(
      `${s.slug.slice(0, 40).padEnd(40)} ${s.sparse ? 'разр' : 'плот'} своих ${String(s.own).padStart(3)}  ` +
        `TP ${String(s.tp).padStart(3)} FP ${String(s.fp).padStart(3)} FN ${String(s.fn).padStart(3)}  полнота ${recall.toFixed(0).padStart(3)}%`,
    )
  }

  const covered = stats.filter((s) => s.covered)
  console.log('\n--- итог')
  report('счётчик найден', covered)
  report('— разреженные', covered.filter((s) => s.sparse))
  report('— плотные', covered.filter((s) => !s.sparse))
  const ownAll = stats.reduce((a, s) => a + s.own, 0)
  const ownCovered = covered.reduce((a, s) => a + s.own, 0)
  console.log(
    `\nПОКРЫТИЕ: клипов ${covered.length}/${stats.length}, выстрелов ${ownCovered}/${ownAll} ` +
      `(${((100 * ownCovered) / ownAll).toFixed(0)}%)`,
  )
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
