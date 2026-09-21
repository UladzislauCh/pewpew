/**
 * Metric for the temporal model (`python/out/temporalShots.json`).
 *
 * Python only returns MOMENTS; they are scored by the real `scoreDetections` from `src/lib`.
 * Python deliberately has no scorer of its own: two implementations of one metric are two truths.
 *
 *   npx tsx eval/temporalScore.ts [tolerance]
 *
 * THE THRESHOLD IS CHOSEN HONESTLY: for each fold the one that worked best on ITS TRAINING clips
 * is taken and applied to the held-out ones. Choosing the threshold from the final table is not
 * allowed — it would be fitted on the same set we measure on.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scoreDetections } from '../src/domain/detection/detectionMetrics'
import { parseClipLabels } from '../src/domain/detection/labels'
import { PROJECT_ROOT, LABELS_DIR } from './fixtures'

const TOLERANCE_S = Number(process.argv[2] ?? 0.05)
const SPARSE_MAX_OWN = 20

interface Dump {
  channels: string
  folds: Record<string, number>
  test: Record<string, Record<string, number[]>>
  train: Record<string, Record<string, Record<string, number[]>>>
}

type Tally = { tp: number; fp: number; fn: number }
const empty = (): Tally => ({ tp: 0, fp: 0, fn: 0 })
const f1 = (a: Tally): number => (200 * a.tp) / Math.max(1, 2 * a.tp + a.fp + a.fn)
const add = (a: Tally, s: { truePositives: number; falsePositives: number; falseNegatives: number }): void => {
  a.tp += s.truePositives
  a.fp += s.falsePositives
  a.fn += s.falseNegatives
}

async function main(): Promise<void> {
  const dump: Dump = JSON.parse(
    await readFile(join(PROJECT_ROOT, 'python/out/temporalShots.json'), 'utf8'),
  )
  const slugs = Object.keys(dump.test).sort()
  const thresholds = Object.keys(dump.test[slugs[0]])

  const own = new Map<string, number[]>()
  for (const slug of slugs) {
    const raw: unknown = JSON.parse(await readFile(join(LABELS_DIR, `${slug}.json`), 'utf8'))
    const labels = parseClipLabels(raw, `labels/${slug}.json`)
    own.set(slug, labels.shots.filter((s) => s.source === 'own').map((s) => s.time).sort((a, b) => a - b))
  }
  const shots = [...own.values()].reduce((a, v) => a + v.length, 0)
  console.log(`клипов ${slugs.length}, своих выстрелов ${shots}, каналы «${dump.channels}», допуск ${TOLERANCE_S * 1000} мс\n`)

  // Threshold for each fold — the best on ITS training clips.
  const chosen: Record<string, string> = {}
  for (const [fold, byClip] of Object.entries(dump.train)) {
    let best = thresholds[0]
    let bestF1 = -1
    for (const t of thresholds) {
      const acc = empty()
      for (const [slug, marks] of Object.entries(byClip)) {
        add(acc, scoreDetections(own.get(slug) ?? [], marks[t], TOLERANCE_S, []))
      }
      if (f1(acc) > bestF1) {
        bestF1 = f1(acc)
        best = t
      }
    }
    chosen[fold] = best
  }
  console.log(`порог по фолдам (выбран на обучающих клипах): ${JSON.stringify(chosen)}`)

  // The temporal model replaces not the counter but the PREVIOUS SCHEME — where there is no counter.
  // So the total is also split by counter coverage: the second column is exactly the case
  // this is all for.
  let covered = new Set<string>()
  try {
    const rows = JSON.parse(
      await readFile(join(PROJECT_ROOT, 'eval/.cache/ammoBrowser.json'), 'utf8'),
    ) as { slug: string; covered: boolean }[]
    covered = new Set(rows.filter((r) => r.covered).map((r) => r.slug))
  } catch {
    /* the ammo cache may be missing */
  }

  const acc = empty()
  const sparse = empty()
  const dense = empty()
  const withAmmo = empty()
  const noAmmo = empty()
  let marks = 0
  for (const slug of slugs) {
    const t = chosen[String(dump.folds[slug])] ?? '0.5'
    const truth = own.get(slug) ?? []
    const predicted = dump.test[slug][t]
    marks += predicted.length
    const s = scoreDetections(truth, predicted, TOLERANCE_S, [])
    add(acc, s)
    add(truth.length <= SPARSE_MAX_OWN ? sparse : dense, s)
    add(covered.has(slug) ? withAmmo : noAmmo, s)
  }
  const r = (100 * acc.tp) / Math.max(1, acc.tp + acc.fn)
  const p = (100 * acc.tp) / Math.max(1, acc.tp + acc.fp)
  console.log(`\nЧЕСТНО: полнота ${r.toFixed(1)}  точность ${p.toFixed(1)}  F1 ${f1(acc).toFixed(1)}  меток ${marks}`)
  console.log(`        разреженные ${f1(sparse).toFixed(1)} · плотные ${f1(dense).toFixed(1)}`)
  if (covered.size) {
    const rate = (a: Tally) => `${((100 * a.tp) / Math.max(1, a.tp + a.fn)).toFixed(1)} / ${((100 * a.tp) / Math.max(1, a.tp + a.fp)).toFixed(1)}`
    console.log(`        клипы СО счётчиком  F1 ${f1(withAmmo).toFixed(1)}  (${rate(withAmmo)})`)
    console.log(`        клипы БЕЗ счётчика  F1 ${f1(noAmmo).toFixed(1)}  (${rate(noAmmo)})  <- ради этого всё`)
  }

  console.log('\nкривая по порогам (СПРАВОЧНО — выбирать по ней нельзя):')
  console.log('  порог   полнота  точность      F1   меток')
  for (const t of thresholds) {
    const a = empty()
    let m = 0
    for (const slug of slugs) {
      add(a, scoreDetections(own.get(slug) ?? [], dump.test[slug][t], TOLERANCE_S, []))
      m += dump.test[slug][t].length
    }
    const rr = (100 * a.tp) / Math.max(1, a.tp + a.fn)
    const pp = (100 * a.tp) / Math.max(1, a.tp + a.fp)
    console.log(`  ${t.padStart(5)}   ${rr.toFixed(1).padStart(7)}  ${pp.toFixed(1).padStart(8)}  ${f1(a).toFixed(1).padStart(6)}  ${String(m).padStart(6)}`)
  }
}

void main()
