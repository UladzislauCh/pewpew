/**
 * Scoring the shots found by the ammo counter (Python) with the product's REAL metric.
 *
 * Python deliberately does not compute the metric itself. Project rule: a computation lives in
 * one place, and where duplication cannot be avoided, it is cross-checked. Here there is simply
 * no duplication: Python returns shot moments, the metric is computed by `scoreDetections` from
 * `src/lib`, the very same one the product is measured with.
 *
 *   python3 python/tools/run_clips.py
 *   pnpm exec tsx eval/ammoScore.ts
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scoreDetections } from '../src/domain/detection/detectionMetrics'
import { parseClipLabels } from '../src/domain/detection/labels'
import { PROJECT_ROOT, LABELS_DIR } from './fixtures'

/** ±50 ms, MIREX. The same tolerance as `pnpm eval`. */
const TOLERANCE_S = 0.05
/** The sparse / dense boundary — as in eval/sparseVsDense.ts. */
const SPARSE_MAX_OWN = 20

interface ClipRun {
  slug: string
  covered: boolean
  shots: number[]
  reloads?: number[]
  error?: string
  score?: { score: number; magazine: number | null; descents: number; reason: string }
  slot?: { x: number; y: number; readRate: number }
  slotsExamined?: number
}

interface Row {
  slug: string
  covered: boolean
  own: number
  tp: number
  fp: number
  fn: number
  sparse: boolean
  note: string
}

async function main(): Promise<void> {
  const path = process.argv[2] ?? join(PROJECT_ROOT, 'python/out/clips.json')
  const runs: ClipRun[] = JSON.parse(await readFile(path, 'utf8'))

  const rows: Row[] = []
  for (const run of runs) {
    const raw: unknown = JSON.parse(await readFile(join(LABELS_DIR, `${run.slug}.json`), 'utf8'))
    const labels = parseClipLabels(raw, `labels/${run.slug}.json`)
    if (!labels.complete) continue

    const own = labels.shots.filter((s) => s.source === 'own').map((s) => s.time).sort((a, b) => a - b)
    // An uncovered clip has no predictions: the counter there was either not found or rejected
    // by the sound-agreement check. Counting its labels means measuring what the product
    // will not show.
    const predicted = run.covered ? [...(run.shots ?? [])].sort((a, b) => a - b) : []
    // ignored is empty — as in eval/evaluate.ts: hitting an enemy shot is an extra label,
    // the user has to remove it anyway.
    const s = scoreDetections(own, predicted, TOLERANCE_S, [])

    rows.push({
      slug: run.slug,
      covered: run.covered,
      own: own.length,
      tp: s.truePositives,
      fp: s.falsePositives,
      fn: s.falseNegatives,
      sparse: own.length <= SPARSE_MAX_OWN,
      note: run.error ?? run.score?.reason ?? '',
    })
  }

  const f1 = (tp: number, fp: number, fn: number) => {
    const p = tp + fp === 0 ? 0 : tp / (tp + fp)
    const r = tp + fn === 0 ? 0 : tp / (tp + fn)
    return { p: p * 100, r: r * 100, f1: p + r === 0 ? 0 : (200 * p * r) / (p + r) }
  }

  const report = (name: string, group: Row[]) => {
    if (!group.length) return
    const tp = group.reduce((a, r) => a + r.tp, 0)
    const fp = group.reduce((a, r) => a + r.fp, 0)
    const fn = group.reduce((a, r) => a + r.fn, 0)
    const own = group.reduce((a, r) => a + r.own, 0)
    const m = f1(tp, fp, fn)
    console.log(
      `${name.padEnd(26)} клипов ${String(group.length).padStart(2)}  своих ${String(own).padStart(4)}  ` +
        `полнота ${m.r.toFixed(1).padStart(5)}  точность ${m.p.toFixed(1).padStart(5)}  F1 ${m.f1.toFixed(1).padStart(5)}`,
    )
  }

  const covered = rows.filter((r) => r.covered)
  const missed = rows.filter((r) => !r.covered)

  // DIAGNOSTICS, NOT A PRODUCT NUMBER. The offset is fitted TO THE LABELS, i.e. it peeks at
  // the answer; it must not be presented as quality. It answers one question: what share of
  // the loss is time desync and what share is real counter misses.
  const shifted: Row[] = []
  for (const run of runs) {
    if (!run.covered) continue
    const row = rows.find((r) => r.slug === run.slug)
    if (!row) continue
    const raw: unknown = JSON.parse(await readFile(join(LABELS_DIR, `${run.slug}.json`), 'utf8'))
    const labels = parseClipLabels(raw, `labels/${run.slug}.json`)
    const own = labels.shots.filter((s) => s.source === 'own').map((s) => s.time).sort((a, b) => a - b)
    let best = { tp: -1, fp: 0, fn: 0 }
    if (!run.covered) continue
    for (let off = -0.3; off <= 0.3; off += 0.005) {
      const moved = run.shots.map((t) => t + off).sort((a, b) => a - b)
      const s = scoreDetections(own, moved, TOLERANCE_S, [])
      if (s.truePositives > best.tp) best = { tp: s.truePositives, fp: s.falsePositives, fn: s.falseNegatives }
    }
    shifted.push({ ...row, tp: best.tp, fp: best.fp, fn: best.fn })
  }

  console.log('--- по клипам')
  for (const r of [...rows].sort((a, b) => Number(b.covered) - Number(a.covered) || a.slug.localeCompare(b.slug))) {
    const m = f1(r.tp, r.fp, r.fn)
    console.log(
      `${r.covered ? 'да ' : 'НЕТ'} ${r.slug.slice(0, 40).padEnd(40)} ${r.sparse ? 'разр' : 'плот'} ` +
        `своих ${String(r.own).padStart(3)}  TP ${String(r.tp).padStart(3)} FP ${String(r.fp).padStart(3)} FN ${String(r.fn).padStart(3)}  ` +
        `полнота ${m.r.toFixed(0).padStart(3)}%  ${r.note}`,
    )
  }

  console.log('\n--- итог')
  report('всё', rows)
  report('счётчик найден', covered)
  report('счётчик не найден', missed)
  report('найден, разреженные', covered.filter((r) => r.sparse))
  report('найден, плотные', covered.filter((r) => !r.sparse))

  console.log('\n--- диагностика: сколько потери это рассинхрон времени, а не промахи')
  console.log('    (сдвиг подобран ПО МЕТКАМ — как качество предъявлять нельзя)')
  report('найден, со сдвигом', shifted)

  const ownAll = rows.reduce((a, r) => a + r.own, 0)
  const ownCovered = covered.reduce((a, r) => a + r.own, 0)
  console.log(
    `\nПОКРЫТИЕ: клипов ${covered.length}/${rows.length} (${((100 * covered.length) / rows.length).toFixed(0)}%), ` +
      `выстрелов ${ownCovered}/${ownAll} (${((100 * ownCovered) / ownAll).toFixed(0)}%)`,
  )
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
