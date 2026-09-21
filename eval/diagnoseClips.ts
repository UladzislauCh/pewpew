/**
 * Where exactly the detector fails and why.
 *
 *   pnpm exec tsx eval/diagnoseClips.ts
 *
 * Overall F1 averages very different things: in today's run `m249` gives 94.8, while three clips
 * give exactly 0.0. The mean over such a set describes no single clip, and there is nothing to fix by it.
 *
 * So everything here is per clip and next to the geometry the second stage depends on: the
 * playfield band and the weapon mask are found by heuristics, and if they land in the wrong place,
 * 22 weapon features out of 74 are garbage. The hypothesis the script tests: failing clips are
 * clips with broken geometry, not with "hard sound".
 *
 * Motion is read from eval/.cache/motion — Node has no canvas, see eval/motionCache.ts.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FIXTURES_DIR, PROJECT_ROOT, loadAllFixtures } from './fixtures'
import { loadClipMotion } from './motionCache'
import { toMono } from '../src/domain/audio/audioTypes'
import { scoreDetections } from '../src/domain/detection/detectionMetrics'
import { detectShotsWithNet } from '../src/domain/detection/shotNet/detectShotsWithNet'
import { deserializeWeights } from '../src/domain/detection/shotNet/shotNet'
import {
  motionFeaturesAt,
  scoreMotion,
  MOTION_PARAMS,
  type MotionModel,
} from '../src/domain/detection/motion/motionFeatures'

const TOLERANCE_S = 0.05
const MOTION_THRESHOLD = 0.5

interface Row {
  slug: string
  fps: number
  own: number
  candidates: number
  marks: number
  tp: number
  fp: number
  recall: number
  precision: number
  f1: number
  /** Ceiling: how many own shots made it into the audio candidates at all. */
  ceiling: number
  band: string
  maskPx: number
  /** Share of band area covered by the mask. Close to 1 — the mask covered everything, i.e. not the weapon. */
  maskFill: number
  /** Mask wider than 90% of the frame — almost certainly not a barrel but a webcam, a banner or a wall. */
  suspect: boolean
}

function pct(v: number): string {
  return Number.isFinite(v) ? (v * 100).toFixed(0).padStart(4) : '   —'
}

async function main(): Promise<void> {
  const { fixtures } = await loadAllFixtures()
  const weights = deserializeWeights(await readFile(join(PROJECT_ROOT, 'public/models/shotNet.json'), 'utf8'))
  const model: MotionModel = JSON.parse(await readFile(join(FIXTURES_DIR, 'models/motionModel.json'), 'utf8'))

  const rows: Row[] = []
  for (const fixture of fixtures) {
    const slug = fixture.labels.slug
    const motion = await loadClipMotion(slug)
    if (!motion) continue

    const own = fixture.labels.shots.filter((s) => s.source === 'own').map((s) => s.time).sort((a, b) => a - b)
    const candidates = detectShotsWithNet(toMono(fixture.audio), fixture.audio.sampleRate, weights, {
      threshold: MOTION_PARAMS.candidateThreshold,
    })

    const marks: number[] = []
    for (const c of candidates) {
      const f = motionFeaturesAt(motion.zone, motion.weapon, c.time, c.confidence)
      if (!f || scoreMotion(model, f) >= MOTION_THRESHOLD) marks.push(c.time)
    }

    const scored = scoreDetections(own, marks.sort((a, b) => a - b), TOLERANCE_S)
    // Ceiling: what would happen if the second stage worked perfectly and lost none of the own shots.
    const ceilingScore = scoreDetections(own, candidates.map((c) => c.time).sort((a, b) => a - b), TOLERANCE_S)

    const w = motion.weapon
    const boxW = w ? w.maskBox.x1 - w.maskBox.x0 : 0
    const bandArea = MOTION_PARAMS.weaponWidth * MOTION_PARAMS.weaponHeight

    rows.push({
      slug,
      fps: motion.zone.fps,
      own: own.length,
      candidates: candidates.length,
      marks: marks.length,
      tp: scored.truePositives,
      fp: scored.falsePositives,
      recall: scored.recall,
      precision: scored.precision,
      f1: scored.f1,
      ceiling: ceilingScore.recall,
      band: w ? `${w.band.y0}–${w.band.y1}` : '—',
      maskPx: w ? w.maskPx : 0,
      maskFill: w ? w.maskPx / bandArea : 0,
      suspect: w ? boxW >= MOTION_PARAMS.weaponWidth * 0.9 : true,
    })
  }

  rows.sort((a, b) => a.f1 - b.f1)

  console.log('Поклипово, порог движения 0.5, допуск 50 мс. Отсортировано от худшего.')
  console.log()
  console.log(
    'клип'.padEnd(26) + 'F1'.padStart(5) + 'полн'.padStart(6) + 'точн'.padStart(6) +
      'своих'.padStart(7) + 'меток'.padStart(7) + 'потол'.padStart(7) +
      'fps'.padStart(6) + 'маска%'.padStart(8) + ' полоса',
  )
  console.log('-'.repeat(100))
  for (const r of rows) {
    console.log(
      r.slug.slice(0, 24).padEnd(26) +
        pct(r.f1) + ' ' + pct(r.recall) + '  ' + pct(r.precision) + '  ' +
        String(r.own).padStart(6) + String(r.marks).padStart(7) + pct(r.ceiling) + '  ' +
        r.fps.toFixed(1).padStart(5) + (r.maskFill * 100).toFixed(0).padStart(7) + '%' +
        ' ' + r.band + (r.suspect ? '  ← маска во всю ширину' : ''),
    )
  }

  // Split into failing and working: if the hypothesis holds, their geometry differs.
  const bad = rows.filter((r) => r.f1 < 0.3)
  const good = rows.filter((r) => r.f1 >= 0.6)
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
  const share = (xs: Row[], p: (r: Row) => boolean) => (xs.length ? xs.filter(p).length / xs.length : NaN)

  console.log()
  console.log(`провальных (F1 < 30): ${bad.length}, рабочих (F1 ≥ 60): ${good.length}`)
  console.log()
  console.log('признак'.padEnd(34) + 'провальные'.padStart(12) + 'рабочие'.padStart(10))
  console.log('-'.repeat(56))
  const cmp = (name: string, f: (r: Row) => number, fmt = (v: number) => v.toFixed(2)) =>
    console.log(name.padEnd(34) + fmt(mean(bad.map(f))).padStart(12) + fmt(mean(good.map(f))).padStart(10))
  cmp('своих выстрелов в клипе', (r) => r.own, (v) => v.toFixed(1))
  cmp('потолок полноты по звуку', (r) => r.ceiling, (v) => (v * 100).toFixed(0) + '%')
  cmp('полнота после движения', (r) => r.recall, (v) => (v * 100).toFixed(0) + '%')
  cmp('заполненность маски', (r) => r.maskFill, (v) => (v * 100).toFixed(0) + '%')
  cmp('fps', (r) => r.fps, (v) => v.toFixed(1))
  console.log(
    'маска во всю ширину'.padEnd(34) +
      ((share(bad, (r) => r.suspect) * 100).toFixed(0) + '%').padStart(12) +
      ((share(good, (r) => r.suspect) * 100).toFixed(0) + '%').padStart(10),
  )
}

void main()
