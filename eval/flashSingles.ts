/**
 * Single shots separately from bursts.
 *
 * WHY THIS IS THE MAIN METRIC rather than overall F1. With the sound replaced, an error inside
 * a burst is inaudible: a missed or extra shot in a run of eight gets lost. A single shot is
 * heard in full: miss it — the game's gunfire remains; add an extra — a shot sounds where
 * there was none.
 *
 * Overall F1, meanwhile, is dominated by bursts: 87% of own shots in the corpus are in bursts.
 * So it measures exactly the part where an error is cheap.
 *
 *   pnpm exec tsx eval/flashSingles.ts [tolerance]
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseClipLabels } from '../src/domain/detection/labels'
import { LABELS_DIR, PROJECT_ROOT } from './fixtures'
import { DEFAULT_FLASH_THRESHOLD } from '../src/domain/detection/flash/thresholds'
import { BURST_GAP_S } from '../src/domain/detection/flash/fireRates'

const TOLERANCE_S = Number(process.argv[2] ?? 0.05)
const EXCLUDED = /^(m4a1s|usp-0|mp5sd)-/

interface Row {
  slug: string
  times: number[]
  scored: { time: number; score: number }[]
}

/** A shot is single if the nearest own shot is further than BURST_GAP_S. */
function isolate(times: number[]): { single: number[]; burst: number[] } {
  const single: number[] = []
  const burst: number[] = []
  for (let i = 0; i < times.length; i++) {
    const before = i > 0 ? times[i] - times[i - 1] : Infinity
    const after = i < times.length - 1 ? times[i + 1] - times[i] : Infinity
    ;(Math.min(before, after) > BURST_GAP_S ? single : burst).push(times[i])
  }
  return { single, burst }
}

async function main(): Promise<void> {
  const rows: Row[] = JSON.parse(
    await readFile(join(PROJECT_ROOT, 'eval/.cache/flashBrowser.json'), 'utf8'),
  )

  let singles = 0
  let singlesHit = 0
  let singlesExtra = 0
  let bursts = 0
  let burstsHit = 0
  const offsets: number[] = []
  const perClip: { slug: string; n: number; hit: number; extra: number }[] = []

  for (const row of rows) {
    if (!row.scored || EXCLUDED.test(row.slug)) continue
    const raw: unknown = JSON.parse(await readFile(join(LABELS_DIR, `${row.slug}.json`), 'utf8'))
    const labels = parseClipLabels(raw, `labels/${row.slug}.json`)
    if (!labels.complete) continue

    const own = labels.shots.filter((s) => s.source === 'own').map((s) => s.time).sort((a, b) => a - b)
    const marks = row.scored.filter((s) => s.score >= DEFAULT_FLASH_THRESHOLD).map((s) => s.time)
    const { single, burst } = isolate(own)

    let hit = 0
    for (const t of single) {
      const near = marks.filter((m) => Math.abs(m - t) <= TOLERANCE_S)
      if (near.length) {
        hit++
        offsets.push(near.reduce((b, m) => (Math.abs(m - t) < Math.abs(b - t) ? m : b)) - t)
      }
    }
    // An extra label next to a single shot is as audible as a miss.
    let extra = 0
    for (const m of marks) {
      const nearSingle = single.some((t) => Math.abs(m - t) <= BURST_GAP_S)
      const nearAny = own.some((t) => Math.abs(m - t) <= TOLERANCE_S)
      if (nearSingle && !nearAny) extra++
    }

    singles += single.length
    singlesHit += hit
    singlesExtra += extra
    bursts += burst.length
    burstsHit += burst.filter((t) => marks.some((m) => Math.abs(m - t) <= TOLERANCE_S)).length
    if (single.length) perClip.push({ slug: row.slug, n: single.length, hit, extra })
  }

  console.log(`допуск ${(TOLERANCE_S * 1000).toFixed(0)} мс, порог ${DEFAULT_FLASH_THRESHOLD}\n`)
  console.log(`ОДИНОЧНЫЕ ВЫСТРЕЛЫ (ближайший свой дальше ${(BURST_GAP_S * 1000).toFixed(0)} мс)`)
  console.log(`   всего ${singles}, найдено ${singlesHit} (${((100 * singlesHit) / Math.max(1, singles)).toFixed(1)}%)`)
  console.log(`   лишних меток рядом с ними: ${singlesExtra}`)
  if (offsets.length) {
    const s = [...offsets].sort((a, b) => a - b)
    const q = (p: number) => (1000 * s[Math.floor(s.length * p)]).toFixed(0)
    console.log(`   расхождение времени: медиана ${q(0.5)} мс, половина в ${q(0.25)}..${q(0.75)}`)
  }
  console.log(`\nВ ОЧЕРЕДЯХ`)
  console.log(`   всего ${bursts}, найдено ${burstsHit} (${((100 * burstsHit) / Math.max(1, bursts)).toFixed(1)}%)`)
  console.log(`   доля очередных среди всех своих: ${((100 * bursts) / Math.max(1, bursts + singles)).toFixed(0)}%`)

  perClip.sort((a, b) => a.hit / a.n - b.hit / b.n)
  console.log(`\nхудшие клипы по одиночным:`)
  for (const c of perClip.slice(0, 10)) {
    console.log(`   ${c.slug.slice(0, 38).padEnd(40)} ${c.hit}/${c.n}   лишних ${c.extra}`)
  }
}

void main()
