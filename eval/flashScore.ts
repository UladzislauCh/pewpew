/**
 * Metric for the YOLO flash detector (`python/out/flashShots.json`).
 *
 * Python only returns MOMENTS; they are scored by the real `scoreDetections` from `src/lib`.
 * Python deliberately has no scorer of its own: two implementations of one metric are two truths,
 * and the project already paid for that with five bugs in one session.
 *
 *   pnpm exec tsx eval/flashScore.ts [tolerance]
 *
 * WHAT MATTERS HERE. A flash is visible on ENEMY shots too, while the project's goal is own ones.
 * So the table shows two things separately: how many own shots were found and how many extra
 * labels there are per own shot. The latter is the real price of the direction.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scoreDetections } from '../src/domain/detection/detectionMetrics'
import { parseClipLabels } from '../src/domain/detection/labels'
import { LABELS_DIR, PROJECT_ROOT } from './fixtures'

const TOLERANCE_S = Number(process.argv[2] ?? 0.05)
const SPARSE_MAX_OWN = 20

/**
 * Systematic label lag relative to the flash. Measured: the hit peak is one frame EARLIER than
 * the label (ak47: 95% at -1 versus 70% at 0). It is not hard-coded here but swept
 * — a correction must not be introduced without showing what it costs.
 */
const SHIFTS_S = [0, 0.017, 0.033, 0.05]

type Tally = { tp: number; fp: number; fn: number }
const add = (t: Tally, s: { truePositives: number; falsePositives: number; falseNegatives: number }) => {
  t.tp += s.truePositives
  t.fp += s.falsePositives
  t.fn += s.falseNegatives
}
const f1 = (t: Tally) => (2 * t.tp + t.fp + t.fn ? (200 * t.tp) / (2 * t.tp + t.fp + t.fn) : 0)
const recall = (t: Tally) => (t.tp + t.fn ? (100 * t.tp) / (t.tp + t.fn) : 0)
const precision = (t: Tally) => (t.tp + t.fp ? (100 * t.tp) / (t.tp + t.fp) : 0)

async function main(): Promise<void> {
  const dump: Record<string, Record<string, number[]>> = JSON.parse(
    await readFile(join(PROJECT_ROOT, process.argv[3] ?? 'python/out/flashShots.json'), 'utf8'),
  )

  const clips: { slug: string; own: number[]; others: number[]; sparse: boolean }[] = []
  for (const slug of Object.keys(dump)) {
    const raw: unknown = JSON.parse(await readFile(join(LABELS_DIR, `${slug}.json`), 'utf8'))
    const labels = parseClipLabels(raw, `labels/${slug}.json`)
    if (!labels.complete) continue
    const own = labels.shots.filter((s) => s.source === 'own').map((s) => s.time).sort((a, b) => a - b)
    const others = labels.shots.filter((s) => s.source !== 'own').map((s) => s.time).sort((a, b) => a - b)
    clips.push({ slug, own, others, sparse: own.length <= SPARSE_MAX_OWN })
  }

  const thresholds = Object.keys(dump[clips[0].slug]).sort()
  console.log(`клипов ${clips.length}, своих выстрелов ${clips.reduce((n, c) => n + c.own.length, 0)}, `
    + `допуск ${(TOLERANCE_S * 1000).toFixed(0)} мс\n`)

  console.log('порог  сдвиг   полнота  точность    F1   разреж  плотн   лишних/выстрел')
  let best = { f1: 0, line: '' }
  for (const threshold of thresholds) {
    for (const shift of SHIFTS_S) {
      const all: Tally = { tp: 0, fp: 0, fn: 0 }
      const sparse: Tally = { tp: 0, fp: 0, fn: 0 }
      const dense: Tally = { tp: 0, fp: 0, fn: 0 }
      for (const clip of clips) {
        const times = (dump[clip.slug][threshold] ?? []).map((t) => t + shift)
        // Enemy shots are passed as "allowed but not required": hitting an enemy shot
        // should count as neither a success nor a gross error.
        const s = scoreDetections(clip.own, times, TOLERANCE_S, clip.others)
        add(all, s)
        add(clip.sparse ? sparse : dense, s)
      }
      const line =
        `${threshold}   ${(shift * 1000).toFixed(0).padStart(3)}мс   ` +
        `${recall(all).toFixed(1).padStart(6)}    ${precision(all).toFixed(1).padStart(6)}  ` +
        `${f1(all).toFixed(1).padStart(5)}   ${f1(sparse).toFixed(1).padStart(5)}  ` +
        `${f1(dense).toFixed(1).padStart(5)}   ${(all.fp / Math.max(1, all.tp + all.fn)).toFixed(2).padStart(5)}`
      console.log(line)
      if (f1(all) > best.f1) best = { f1: f1(all), line }
    }
  }
  console.log(`\nлучшее: ${best.line.trim()}`)
  console.log('\nСРАВНИВАТЬ НЕ С ЭТИМ ЧИСЛОМ НАПРЯМУЮ: счётчик патронов даёт F1 82.0 на своих')
  console.log('19 клипах, прежняя схема 62.0 на всех 45. Порог здесь подобран по этой же')
  console.log('таблице, то есть число ОПТИМИСТИЧНО — честный порог берётся на отложенных клипах.')
}

void main()
