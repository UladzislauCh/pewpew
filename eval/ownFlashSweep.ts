/**
 * Sweep of own-flash anchor selection rules — WITHOUT a pass over the video.
 *
 * Works from the hot-frame dump (`eval/.cache/flashWhySweep.json`, page
 * `/eval/flashWhy.html?out=flashWhySweep.json`). One hour of decoding pays off because
 * after it any rule is checked in seconds.
 *
 * WHY NOT FROM flashBrowser.json. That cache was taken along the audio path: frames were taken
 * only around audio candidates. The ghosts this was all about are not there — on `donk` it
 * has exactly four correct flashes and not a single extra. A sweep over it would show there
 * is nothing to change.
 *
 * F1 IS NOT WHAT IS MEASURED. Labels on some clips are dirty (measured: the clean half 66.3
 * versus 29.8 on the dirty one at equal size), and a rule that removed an extra label looks
 * like a regression there. What is printed is how many labels the rule removes and on which
 * clips — the decision on this table is made by a human.
 *
 *   pnpm exec tsx eval/ownFlashSweep.ts
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FASTEST_PERIOD_S } from '../src/domain/detection/flash/fireRates'
import { findOwnFlashes, isOwnFlash, type OwnFlashOptions, type Spot } from '../src/domain/detection/flash/ownWeapon'
import { PROJECT_ROOT } from './fixtures'

interface Hot {
  t: number
  s: number
  c: string
  b: [number, number, number, number] | null
}
interface Dump {
  slug: string
  source: string
  shots: number[]
  hot: Hot[]
}

const spotOf = (h: Hot): Spot | null =>
  h.b ? { cx: h.b[0], cy: h.b[1], w: h.b[2], h: h.b[3] } : null

/** The same peak placement as in the product: by descending confidence, the gap is the fire-rate limit. */
function pickPeaks(frames: { t: number; s: number }[]): number[] {
  const kept: { t: number; s: number }[] = []
  for (const f of [...frames].sort((a, b) => b.s - a.s)) {
    if (kept.some((k) => Math.abs(k.t - f.t) < FASTEST_PERIOD_S)) continue
    kept.push(f)
  }
  return kept.map((k) => k.t).sort((a, b) => a - b)
}

/**
 * The previous rule: a cluster by trigger count, radius 0.12, one anchor.
 * Kept here in full so the comparison is with code, not with a memory of it.
 */
function legacyReference(spots: Spot[]): Spot | null {
  const usable = spots.filter((s) => s.w > 0 && s.h > 0)
  if (usable.length < 3) return null
  const area = (s: Spot) => s.w * s.h
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0
  let best: { members: Spot[]; area: number } | null = null
  for (const seed of usable) {
    const members = usable.filter((s) => Math.hypot(s.cx - seed.cx, s.cy - seed.cy) <= 0.12)
    if (members.length < 3) continue
    const a = median(members.map(area))
    if (!best || members.length > best.members.length || (members.length === best.members.length && a > best.area)) {
      best = { members, area: a }
    }
  }
  if (!best) return null
  return {
    cx: median(best.members.map((s) => s.cx)),
    cy: median(best.members.map((s) => s.cy)),
    w: Math.sqrt(best.area),
    h: Math.sqrt(best.area),
  }
}

function marksLegacy(hot: Hot[]): number[] {
  const own = legacyReference(hot.map(spotOf).filter((s): s is Spot => !!s))
  const kept = hot.filter((h) => {
    const s = spotOf(h)
    if (!own || !s || s.w <= 0) return true
    if (Math.hypot(s.cx - own.cx, s.cy - own.cy) > 0.12) return false
    return s.w * s.h >= (own.w * own.h) / 3
  })
  return pickPeaks(kept.map((h) => ({ t: h.t, s: h.s })))
}

function marksNew(hot: Hot[], options: OwnFlashOptions): number[] {
  const own = findOwnFlashes(hot.map(spotOf).filter((s): s is Spot => !!s), options)
  const kept = hot.filter((h) => isOwnFlash(spotOf(h), own, options))
  return pickPeaks(kept.map((h) => ({ t: h.t, s: h.s })))
}

async function main(): Promise<void> {
  // The full dump is kept under a protected name: HMR overwrites the working file as soon
  // as you touch any module the page imports.
  const path = join(PROJECT_ROOT, process.argv[2] ?? 'eval/.cache/flashWhySweep-50.json')
  const dumps: Dump[] = JSON.parse(await readFile(path, 'utf8'))
  console.log(`клипов в дампе ${dumps.length}\n`)

  const variants: { name: string; options: OwnFlashOptions }[] = [
    { name: 'минимум 1', options: { minMembers: 1 } },
    { name: 'минимум 2', options: { minMembers: 2 } },
    { name: 'минимум 3', options: { minMembers: 3 } },
    { name: 'радиус 0.12, мин 2', options: { minMembers: 2, radius: 0.12 } },
    { name: 'одна опора, мин 2', options: { minMembers: 2, maxReferences: 1 } },
  ]

  const head = ['клип'.padEnd(40), 'было'.padStart(5)]
  for (const v of variants) head.push(v.name.padStart(18))
  console.log(head.join(''))

  const totals = new Map<string, { removed: number; wiped: number; marks: number }>()
  for (const v of variants) totals.set(v.name, { removed: 0, wiped: 0, marks: 0 })
  let before = 0

  for (const d of dumps.sort((a, b) => a.slug.localeCompare(b.slug))) {
    const base = marksLegacy(d.hot)
    before += base.length
    const cells = [d.slug.slice(0, 38).padEnd(40), String(base.length).padStart(5)]
    for (const v of variants) {
      const now = marksNew(d.hot, v.options)
      const t = totals.get(v.name)!
      t.marks += now.length
      t.removed += base.length - now.length
      // A clip where the rule removed ALL labels is a separate report line: this is not a
      // precision gain but the loss of the whole clip, and in the sum of removed labels it is indistinguishable.
      if (base.length > 0 && now.length === 0) t.wiped++
      const delta = now.length - base.length
      cells.push(`${now.length}${delta ? ` (${delta > 0 ? '+' : ''}${delta})` : ''}`.padStart(18))
    }
    console.log(cells.join(''))
  }

  console.log(`\nвсего меток прежним правилом: ${before}`)
  for (const v of variants) {
    const t = totals.get(v.name)!
    console.log(
      `  ${v.name.padEnd(20)} меток ${String(t.marks).padStart(4)}` +
        `   снято ${String(t.removed).padStart(4)}` +
        `   клипов обнулено ${t.wiped}`,
    )
  }
}

void main()
