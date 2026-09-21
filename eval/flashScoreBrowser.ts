/**
 * Sweep of threshold and gap over saved flash scores — without a pass over the video.
 *
 * A browser run takes minutes, and tuning rules on it is impossible. But selection does not
 * depend on frames: it only needs candidate scores, and those are already in
 * `eval/.cache/flashBrowser.json`. The same trick paid off for counter alignment.
 *
 *   pnpm exec tsx eval/flashScoreBrowser.ts [tolerance]
 *
 * COMPARE AT EQUAL RECALL. A table at a fixed threshold shows movement along the curve,
 * not a shift of the curve itself — the project has been burned by this before.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scoreDetections } from '../src/domain/detection/detectionMetrics'
import { parseClipLabels } from '../src/domain/detection/labels'
import { LABELS_DIR, PROJECT_ROOT } from './fixtures'

const TOLERANCE_S = Number(process.argv[2] ?? 0.05)

/**
 * Suppressed and scoped clips are excluded: there is physically no flash there, and mixing
 * them with the rest means measuring the wrong thing. Selection is by name and is incomplete —
 * compilation highlights cannot be classified by name.
 */
const EXCLUDED = /^(m4a1s|usp-0|mp5sd|awp|aug|g3sg1|scar20|ssg08|sg553)-/

/** Gap at which candidates are cut into bursts. */
const BURST_GAP_S = 0.25
const THRESHOLDS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7]
/** Zero — no collapsing at all; that is what is being checked. */

interface Row {
  slug: string
  scored: { time: number; score: number }[]
}

type Scored = { time: number; score: number }

/** Each candidate on its own: confirmed by a flash or not. */
function perCandidate(scored: Scored[], threshold: number): number[] {
  return scored.filter((s) => s.score >= threshold).map((s) => s.time).sort((a, b) => a - b)
}

/**
 * THE WHOLE BURST: the flash says "the player is shooting here", the sound places the shots.
 *
 * The idea from a measurement: a flash lives 10-20 ms, frames come every 33 ms, and about
 * every third shot falls between frames — it is in no frame at all. Inside a burst such a shot
 * is recovered not from the picture but from the sound: since the player is shooting here,
 * this burst's candidates belong to them.
 *
 * @param need how many candidates in the burst must be confirmed to accept all of it
 */
function wholeBurst(scored: Scored[], threshold: number, need: number): number[] {
  const times = [...scored].sort((a, b) => a.time - b.time)
  const bursts: Scored[][] = []
  for (const s of times) {
    const last = bursts[bursts.length - 1]
    if (last && s.time - last[last.length - 1].time <= BURST_GAP_S) last.push(s)
    else bursts.push([s])
  }
  const out: number[] = []
  for (const burst of bursts) {
    const confirmed = burst.filter((s) => s.score >= threshold)
    if (confirmed.length >= need) out.push(...burst.map((s) => s.time))
    else out.push(...confirmed.map((s) => s.time))
  }
  return out.sort((a, b) => a - b)
}

async function main(): Promise<void> {
  const rows: Row[] = JSON.parse(
    await readFile(join(PROJECT_ROOT, 'eval/.cache/flashBrowser.json'), 'utf8'),
  )
  const clips: { slug: string; own: number[]; others: number[]; scored: Row['scored'] }[] = []
  for (const row of rows) {
    const raw: unknown = JSON.parse(await readFile(join(LABELS_DIR, `${row.slug}.json`), 'utf8'))
    const labels = parseClipLabels(raw, `labels/${row.slug}.json`)
    if (!labels.complete || !row.scored || EXCLUDED.test(row.slug)) continue
    clips.push({
      slug: row.slug,
      own: labels.shots.filter((s) => s.source === 'own').map((s) => s.time).sort((a, b) => a - b),
      others: labels.shots.filter((s) => s.source !== 'own').map((s) => s.time),
      scored: row.scored,
    })
  }

  const own = clips.reduce((n, c) => n + c.own.length, 0)
  console.log(`клипов ${clips.length}, своих выстрелов ${own}, допуск ${(TOLERANCE_S * 1000).toFixed(0)} мс\n`)
  console.log('способ            порог   полнота  точность    F1   меток')
  let best = { f1: 0, line: '' }
/**
 * RHYTHM FILL-IN: shots confirmed by a flash set the firing tempo, and in the gaps of that
 * tempo an audio candidate is accepted.
 *
 * The idea from a measurement: a flash lives 10-20 ms, frames come every 33 ms, and about
 * every third shot lands in no frame. But the burst tempo is set by the weapon and is constant,
 * so a missed shot sits EXACTLY between its neighbours. This is much more precise than
 * accepting the whole burst: audio yields three times more candidates than shots, and
 * "whole burst" drops precision from 66 to 36.
 *
 * @param snap how close to the expected spot a candidate must be, in seconds
 */
function fillRhythm(scored: Scored[], threshold: number, snap: number, need = 2): number[] {
  const times = [...scored].sort((a, b) => a.time - b.time)
  const bursts: Scored[][] = []
  for (const s of times) {
    const last = bursts[bursts.length - 1]
    if (last && s.time - last[last.length - 1].time <= BURST_GAP_S) last.push(s)
    else bursts.push([s])
  }

  const out: number[] = []
  for (const burst of bursts) {
    const confirmed = burst.filter((s) => s.score >= threshold).map((s) => s.time)
    out.push(...confirmed)
    if (confirmed.length < need) continue

    // Burst tempo — the SMALLEST gap between confirmed shots. The median will not do:
    // if every second shot is missed, the median gap becomes a double period.
    const gaps: number[] = []
    for (let i = 1; i < confirmed.length; i++) gaps.push(confirmed[i] - confirmed[i - 1])
    const period = Math.min(...gaps)
    if (!(period > 0.04 && period < BURST_GAP_S)) continue

    for (let i = 1; i < confirmed.length; i++) {
      const span = confirmed[i] - confirmed[i - 1]
      const steps = Math.round(span / period)
      if (steps < 2) continue
      for (let k = 1; k < steps; k++) {
        const expected = confirmed[i - 1] + k * period
        // A label is placed only where the SOUND also heard a shot: inventing moments
        // out of nothing is no longer detection but extrapolation.
        let near: number | null = null
        let bestDistance = snap
        for (const s of burst) {
          const d = Math.abs(s.time - expected)
          if (d < bestDistance) {
            bestDistance = d
            near = s.time
          }
        }
        if (near !== null && !out.includes(near)) out.push(near)
      }
    }
  }
  return out.sort((a, b) => a - b)
}

  const strategies: { name: string; run: (s: Scored[], t: number) => number[] }[] = [
    { name: 'кандидат сам за себя', run: perCandidate },
    { name: 'очередь целиком, 1+', run: (s, t) => wholeBurst(s, t, 1) },
    { name: 'очередь целиком, 2+', run: (s, t) => wholeBurst(s, t, 2) },
    { name: 'очередь целиком, 3+', run: (s, t) => wholeBurst(s, t, 3) },
    { name: 'по ритму, 2+ подтв.', run: (s, t) => fillRhythm(s, t, 0.03, 2) },
    { name: 'по ритму, 3+ подтв.', run: (s, t) => fillRhythm(s, t, 0.03, 3) },
    { name: 'по ритму, 4+ подтв.', run: (s, t) => fillRhythm(s, t, 0.03, 4) },
  ]
  for (const strategy of strategies) {
    for (const threshold of THRESHOLDS) {
      let tp = 0
      let fp = 0
      let fn = 0
      let marks = 0
      for (const clip of clips) {
        const times = strategy.run(clip.scored, threshold)
        marks += times.length
        const s = scoreDetections(clip.own, times, TOLERANCE_S, clip.others)
        tp += s.truePositives
        fp += s.falsePositives
        fn += s.falseNegatives
      }
      const f1 = 2 * tp + fp + fn ? (200 * tp) / (2 * tp + fp + fn) : 0
      const line =
        `${strategy.name.padEnd(22)}${threshold.toFixed(2)}   ` +
        `${((100 * tp) / Math.max(1, tp + fn)).toFixed(1).padStart(6)}    ` +
        `${((100 * tp) / Math.max(1, tp + fp)).toFixed(1).padStart(6)}  ${f1.toFixed(1).padStart(5)}  ` +
        `${String(marks).padStart(5)}`
      console.log(line)
      if (f1 > best.f1) best = { f1, line }
    }
    console.log('')
  }
  console.log(`\nлучшее: ${best.line.trim()}`)
}

void main()
