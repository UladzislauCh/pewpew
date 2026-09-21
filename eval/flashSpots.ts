/**
 * Does the flash BOX tell an own shot from an extra label.
 *
 * Hypothesis: the own flash is large and consistently in one place in the frame (the weapon model
 * at the bottom centre), while extra labels latch onto others' fire — there the box is smaller and scattered.
 * Confidence does not know this: it is about "looks like a flash", not "whose".
 *
 * If the hypothesis holds, selection gains a feature independent of both sound and brightness.
 *
 *   pnpm exec tsx eval/flashSpots.ts [tolerance]
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseClipLabels } from '../src/domain/detection/labels'
import { LABELS_DIR, PROJECT_ROOT } from './fixtures'
import { DEFAULT_FLASH_THRESHOLD } from '../src/domain/detection/flash/thresholds'

const TOLERANCE_S = Number(process.argv[2] ?? 0.05)
const EXCLUDED = /^(m4a1s|usp-0|mp5sd)-/

interface Row {
  slug: string
  scored: { time: number; score: number; cls: number[]; spot: number[] | null }[]
}

const quantiles = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))]
  return { q25: q(0.25), med: q(0.5), q75: q(0.75) }
}

async function main(): Promise<void> {
  const rows: Row[] = JSON.parse(
    await readFile(join(PROJECT_ROOT, 'eval/.cache/flashBrowser.json'), 'utf8'),
  )

  // Confirmed candidates split into two buckets: hit an own shot or not.
  // The BOXES of these two buckets are compared.
  const hit: number[][] = []
  const miss: number[][] = []
  for (const row of rows) {
    if (!row.scored || EXCLUDED.test(row.slug)) continue
    const raw: unknown = JSON.parse(await readFile(join(LABELS_DIR, `${row.slug}.json`), 'utf8'))
    const labels = parseClipLabels(raw, `labels/${row.slug}.json`)
    if (!labels.complete) continue
    const own = labels.shots.filter((s) => s.source === 'own').map((s) => s.time)
    for (const s of row.scored) {
      if (s.score < DEFAULT_FLASH_THRESHOLD || !s.spot) continue
      const near = own.some((t) => Math.abs(t - s.time) <= TOLERANCE_S)
      ;(near ? hit : miss).push(s.spot)
    }
  }

  const show = (name: string, rows: number[][]) => {
    if (!rows.length) {
      console.log(`${name}: пусто`)
      return
    }
    const area = rows.map((s) => s[2] * s[3])
    const cx = rows.map((s) => s[0])
    const cy = rows.map((s) => s[1])
    const a = quantiles(area)
    const x = quantiles(cx)
    const y = quantiles(cy)
    console.log(`${name.padEnd(22)} n=${String(rows.length).padStart(4)}` +
      `   площадь ${(100 * a.med).toFixed(2)}% (${(100 * a.q25).toFixed(2)}..${(100 * a.q75).toFixed(2)})` +
      `   x ${x.med.toFixed(2)} (${x.q25.toFixed(2)}..${x.q75.toFixed(2)})` +
      `   y ${y.med.toFixed(2)} (${y.q25.toFixed(2)}..${y.q75.toFixed(2)})`)
  }

  console.log(`допуск ${(TOLERANCE_S * 1000).toFixed(0)} мс, порог ${DEFAULT_FLASH_THRESHOLD}\n`)
  show('попали в выстрел', hit)
  show('лишние метки', miss)

  // How well the feature separates at all: the share of extras cut while keeping 90% of the correct ones.
  console.log('\nотсечение по площади рамки:')
  const area = (s: number[]) => s[2] * s[3]
  const hitArea = hit.map(area).sort((a, b) => a - b)
  for (const keep of [0.95, 0.9, 0.8]) {
    const cut = hitArea[Math.floor(hitArea.length * (1 - keep))]
    const dropped = miss.filter((s) => area(s) < cut).length
    console.log(`   сохранить ${(100 * keep).toFixed(0)}% верных (площадь >= ${(100 * cut).toFixed(2)}%)` +
      ` -> отсекается ${dropped} из ${miss.length} лишних (${((100 * dropped) / Math.max(1, miss.length)).toFixed(1)}%)`)
  }
}

void main()
