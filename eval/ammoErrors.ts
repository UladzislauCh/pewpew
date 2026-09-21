/**
 * What the ammo counter's errors consist of.
 *
 * The size of a bucket says nothing about how much of it can be recovered. Project rule:
 * look not at "is there an error" but at "what SHARE of errors does the proposed fix address".
 *
 * Extra labels split into:
 *   ENEMY    — hit a labelled enemy shot; the counter cannot fix it, it is a read error
 *   PLACEMENT — an own shot nearby (50..250 ms), but missed the tolerance
 *   DUPLICATE — an own shot nearby, but another of our labels already found it
 *   NOISE    — no own shot within 250 ms at all
 *
 * Misses split into:
 *   SHIFTED  — there is an UNUSED counter event nearby; fixed by placement
 *   UNSEEN   — no free events nearby; fixed only by reading the counter
 *
 * Matching free events to misses is strictly ONE TO ONE. Without this, in a burst one event
 * would count as "nearby" for several shots at once, and the share of fixable misses would
 * come out inflated.
 *
 *   pnpm exec tsx eval/ammoErrors.ts [clips.json]
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scoreDetections } from '../src/domain/detection/detectionMetrics'
import { parseClipLabels } from '../src/domain/detection/labels'
import { PROJECT_ROOT, LABELS_DIR } from './fixtures'

const TOLERANCE_S = 0.05
/** Up to what distance we consider the "same" shot to be nearby rather than an unrelated sound. */
const NEAR_S = 0.25

interface ClipRun {
  slug: string
  covered: boolean
  shots: number[]
  shotsVideo?: number[]
  alignOffset?: number
}

const nearest = (xs: readonly number[], t: number): number =>
  xs.length === 0 ? Infinity : Math.min(...xs.map((x) => Math.abs(x - t)))

async function main(): Promise<void> {
  const path = process.argv[2] ?? join(PROJECT_ROOT, 'python/out/clips.json')
  const runs: ClipRun[] = JSON.parse(await readFile(path, 'utf8'))

  const fp = { enemy: 0, placement: 0, duplicate: 0, noise: 0 }
  const fn = { shifted: 0, unseen: 0 }
  const perClip: { slug: string; fp: typeof fp; fn: typeof fn; own: number }[] = []

  for (const run of runs) {
    if (!run.covered) continue
    const raw: unknown = JSON.parse(await readFile(join(LABELS_DIR, `${run.slug}.json`), 'utf8'))
    const labels = parseClipLabels(raw, `labels/${run.slug}.json`)
    if (!labels.complete) continue

    const own = labels.shots.filter((s) => s.source === 'own').map((s) => s.time).sort((a, b) => a - b)
    const enemy = labels.shots.filter((s) => s.source !== 'own').map((s) => s.time).sort((a, b) => a - b)
    const predicted = [...run.shots].sort((a, b) => a - b)
    const s = scoreDetections(own, predicted, TOLERANCE_S, [])
    const matchedOwn = new Set(s.match.matches.map((m) => m.referenceIndex))

    const clipFp = { enemy: 0, placement: 0, duplicate: 0, noise: 0 }
    for (const index of s.falsePositiveIndices) {
      const t = predicted[index]
      const dOwn = nearest(own, t)
      if (nearest(enemy, t) <= TOLERANCE_S) clipFp.enemy++
      else if (dOwn > NEAR_S) clipFp.noise++
      else {
        // An own shot nearby. Duplicate or miss — decided by whether it has already been found.
        let closest = -1
        let best = Infinity
        for (let i = 0; i < own.length; i++) {
          const d = Math.abs(own[i] - t)
          if (d < best) { best = d; closest = i }
        }
        if (closest >= 0 && matchedOwn.has(closest)) clipFp.duplicate++
        else clipFp.placement++
      }
    }

    // Free counter events — those that did not become TP. These and only these can close
    // a miss by moving a label.
    const spare = s.falsePositiveIndices.map((i) => predicted[i]).sort((a, b) => a - b)
    const usedSpare = new Set<number>()
    const clipFn = { shifted: 0, unseen: 0 }
    for (const index of s.match.missedReferenceIndices) {
      const t = own[index]
      let pick = -1
      let best = NEAR_S
      for (let j = 0; j < spare.length; j++) {
        if (usedSpare.has(j)) continue
        const d = Math.abs(spare[j] - t)
        if (d <= best) { best = d; pick = j }
      }
      if (pick >= 0) { usedSpare.add(pick); clipFn.shifted++ }
      else clipFn.unseen++
    }

    for (const k of Object.keys(fp) as (keyof typeof fp)[]) fp[k] += clipFp[k]
    for (const k of Object.keys(fn) as (keyof typeof fn)[]) fn[k] += clipFn[k]
    perClip.push({ slug: run.slug, fp: clipFp, fn: clipFn, own: own.length })
  }

  const fpTotal = Object.values(fp).reduce((a, b) => a + b, 0)
  const fnTotal = Object.values(fn).reduce((a, b) => a + b, 0)

  console.log('--- по клипам (лишние / пропуски)')
  console.log('клип'.padEnd(32) + 'чужой  расст  дубль   шум  |  смещён  не виден')
  for (const c of perClip.sort((a, b) => b.fn.shifted + b.fp.placement - (a.fn.shifted + a.fp.placement))) {
    console.log(
      c.slug.slice(0, 32).padEnd(32) +
        `${String(c.fp.enemy).padStart(5)}${String(c.fp.placement).padStart(7)}` +
        `${String(c.fp.duplicate).padStart(7)}${String(c.fp.noise).padStart(6)}  |` +
        `${String(c.fn.shifted).padStart(8)}${String(c.fn.unseen).padStart(10)}`,
    )
  }

  console.log(`\n--- ЛИШНИЕ МЕТКИ, всего ${fpTotal}`)
  for (const [name, value] of [
    ['ЧУЖОЙ выстрел (ошибка чтения счётчика)', fp.enemy],
    ['РАССТАНОВКА (свой рядом, мимо допуска)', fp.placement],
    ['ДУБЛЬ (свой рядом, но уже найден)', fp.duplicate],
    ['ШУМ (своего ближе 250 мс нет)', fp.noise],
  ] as const) {
    console.log(`  ${name.padEnd(42)} ${String(value).padStart(4)}  ${((100 * value) / fpTotal).toFixed(0)}%`)
  }

  console.log(`\n--- ПРОПУСКИ, всего ${fnTotal}`)
  for (const [name, value] of [
    ['СМЕЩЁН (рядом есть свободное событие)', fn.shifted],
    ['НЕ ВИДЕН (свободных событий рядом нет)', fn.unseen],
  ] as const) {
    console.log(`  ${name.padEnd(42)} ${String(value).padStart(4)}  ${((100 * value) / fnTotal).toFixed(0)}%`)
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
