/**
 * Flash labels against manual labels — PAIRWISE, not as a summary.
 *
 * The summary (`eval/flashScoreBrowser.ts`) says HOW MANY matched. Here you see HOW: how far
 * a label diverged from the manual one in time, whether there is a systematic offset, which
 * clips drag things down. The user fixes a systematic offset with one slider, but not spread
 * and misses, and these are different troubles.
 *
 * Suppressed and scoped clips are excluded: there is physically no flash there.
 *
 *   pnpm exec tsx eval/flashCompare.ts [tolerance]
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scoreDetections } from '../src/domain/detection/detectionMetrics'
import { parseClipLabels } from '../src/domain/detection/labels'
import { LABELS_DIR, PROJECT_ROOT } from './fixtures'
import { DEFAULT_FLASH_THRESHOLD } from '../src/domain/detection/flash/thresholds'

const TOLERANCE_S = Number(process.argv[2] ?? 0.05)
const THRESHOLD = Number(process.argv[3] ?? DEFAULT_FLASH_THRESHOLD)
const EXCLUDED = /^(m4a1s|usp-0|mp5sd|awp|aug|g3sg1|scar20|ssg08|sg553)-/

interface Row {
  slug: string
  scored: { time: number; score: number }[]
}

const median = (xs: number[]): number => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

async function main(): Promise<void> {
  const rows: Row[] = JSON.parse(
    await readFile(join(PROJECT_ROOT, 'eval/.cache/flashBrowser.json'), 'utf8'),
  )

  const perClip: {
    slug: string
    own: number
    tp: number
    fp: number
    fn: number
    offset: number
    spread: number
  }[] = []
  const allOffsets: number[] = []
  let skipped = 0

  for (const row of rows) {
    if (!row.scored) continue
    if (EXCLUDED.test(row.slug)) {
      skipped++
      continue
    }
    const raw: unknown = JSON.parse(await readFile(join(LABELS_DIR, `${row.slug}.json`), 'utf8'))
    const labels = parseClipLabels(raw, `labels/${row.slug}.json`)
    if (!labels.complete) continue

    const own = labels.shots.filter((s) => s.source === 'own').map((s) => s.time).sort((a, b) => a - b)
    const others = labels.shots.filter((s) => s.source !== 'own').map((s) => s.time)
    const marks = row.scored.filter((s) => s.score >= THRESHOLD).map((s) => s.time).sort((a, b) => a - b)
    const s = scoreDetections(own, marks, TOLERANCE_S, others)

    // Divergence is measured to the NEAREST label, not greedily in order. Greedy matching on early
    // unpaired labels eats the later ones and invents an offset — the project already caught
    // this on `bizon`, where phantom +201 ms were born this way.
    const offsets: number[] = []
    for (const t of own) {
      let best = Infinity
      for (const m of marks) {
        const d = m - t
        if (Math.abs(d) < Math.abs(best)) best = d
      }
      if (Math.abs(best) <= TOLERANCE_S) offsets.push(best)
    }
    allOffsets.push(...offsets)

    const spreadFrom = median(offsets)
    perClip.push({
      slug: row.slug,
      own: own.length,
      tp: s.truePositives,
      fp: s.falsePositives,
      fn: s.falseNegatives,
      offset: spreadFrom,
      spread: median(offsets.map((o) => Math.abs(o - spreadFrom))),
    })
  }

  perClip.sort((a, b) => b.tp / Math.max(1, b.own) - a.tp / Math.max(1, a.own))
  console.log(`клипов ${perClip.length} (исключено с глушителем и оптикой ${skipped}), `
    + `порог ${THRESHOLD}, допуск ${(TOLERANCE_S * 1000).toFixed(0)} мс\n`)
  console.log(`${'клип'.padEnd(38)} ${'своих'.padStart(5)} ${'нашли'.padStart(5)} ${'лишн'.padStart(4)} ${'проп'.padStart(4)}  полнота  сдвиг  разброс`)
  for (const c of perClip) {
    console.log(
      `${c.slug.slice(0, 36).padEnd(38)} ${String(c.own).padStart(5)} ${String(c.tp).padStart(5)} ` +
        `${String(c.fp).padStart(4)} ${String(c.fn).padStart(4)}  ` +
        `${((100 * c.tp) / Math.max(1, c.own)).toFixed(0).padStart(6)}%  ` +
        `${Number.isNaN(c.offset) ? '    —' : (1000 * c.offset).toFixed(0).padStart(4) + 'мс'}  ` +
        `${Number.isNaN(c.spread) ? '   —' : (1000 * c.spread).toFixed(0).padStart(4) + 'мс'}`,
    )
  }

  const own = perClip.reduce((n, c) => n + c.own, 0)
  const tp = perClip.reduce((n, c) => n + c.tp, 0)
  const fp = perClip.reduce((n, c) => n + c.fp, 0)
  const fn = perClip.reduce((n, c) => n + c.fn, 0)
  console.log(`\nВСЕГО  своих ${own}, нашли ${tp}, лишних ${fp}, пропущено ${fn}`)
  console.log(`       полнота ${((100 * tp) / (tp + fn)).toFixed(1)}  точность ${((100 * tp) / (tp + fp)).toFixed(1)}  F1 ${((200 * tp) / (2 * tp + fp + fn)).toFixed(1)}`)

  allOffsets.sort((a, b) => a - b)
  const q = (p: number) => (1000 * allOffsets[Math.floor(allOffsets.length * p)]).toFixed(0)
  console.log(`\nРАСХОЖДЕНИЕ ВРЕМЕНИ по ${allOffsets.length} совпавшим парам, мс:`)
  console.log(`   медиана ${q(0.5)},  половина пар в ${q(0.25)}..${q(0.75)},  девять десятых в ${q(0.05)}..${q(0.95)}`)
  const within = (ms: number) => allOffsets.filter((o) => Math.abs(o) <= ms / 1000).length
  for (const ms of [10, 20, 33, 50]) {
    console.log(`   в пределах ${String(ms).padStart(2)} мс: ${((100 * within(ms)) / allOffsets.length).toFixed(1)}%`)
  }
}

void main()
