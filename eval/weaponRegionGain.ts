/**
 * Does the residual in the human-labelled region give anything IN THE METRIC, not in AUC.
 *
 *   pnpm exec tsx eval/weaponRegionGain.ts
 *
 * This is a mandatory step, not a formality. The journal closed nine directions that had
 * discriminating power but no gain in the metric; the rule from there — look not only at
 * "does the feature discriminate" but at "what SHARE of errors does it address".
 *
 * Measurement scheme. The feature is added to the current motion model's score, and a logistic
 * regression is trained on top of the two numbers. The honest baseline is the same regression on
 * the model score ALONE: otherwise the recalibration gain would be credited to the new feature.
 * Validation is by clip, with folds: a whole clip is either in training or in test, because
 * candidates within a clip are not independent.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FIXTURES_DIR, PROJECT_ROOT, loadAllFixtures } from './fixtures'
import { loadClipMotion } from './motionCache'
import { toMono } from '../src/domain/audio/audioTypes'
import { detectShotsWithNet } from '../src/domain/detection/shotNet/detectShotsWithNet'
import { deserializeWeights } from '../src/domain/detection/shotNet/shotNet'
import { motionFeaturesAt, scoreMotion, type MotionModel } from '../src/domain/detection/motion/motionFeatures'
import { scoreDetections } from '../src/domain/detection/detectionMetrics'

const TOLERANCE_S = 0.05
const HALF_MS = 40
const FOLDS = 5
const SPARSE_MAX_OWN = 20

interface Series { frames: number; fps: number; resid: number[]; diff: number[] }

interface Row {
  slug: string
  time: number
  own: boolean
  sparse: boolean
  motion: number
  /** Peak frame difference in a ±40 ms window inside the human region, normalised by the clip median. */
  weapon: number
}

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b)
  return s[s.length >> 1] || 1
}

function peakAt(sig: number[], fps: number, time: number): number | null {
  const centre = Math.round(time * fps)
  const r = Math.max(1, Math.round((HALF_MS / 1000) * fps))
  const f0 = Math.max(1, centre - r)
  const f1 = Math.min(sig.length - 1, centre + r)
  if (f1 < f0) return null
  let peak = -Infinity
  for (let f = f0; f <= f1; f++) peak = Math.max(peak, sig[f])
  return peak
}

/** Logistic regression by gradient descent. Two or three features, no separate library needed. */
function fit(X: number[][], y: number[], steps = 4000, lr = 0.3): number[] {
  const d = X[0].length
  const w = new Array<number>(d + 1).fill(0)
  for (let step = 0; step < steps; step++) {
    const g = new Array<number>(d + 1).fill(0)
    for (let i = 0; i < X.length; i++) {
      let z = w[d]
      for (let j = 0; j < d; j++) z += w[j] * X[i][j]
      const p = 1 / (1 + Math.exp(-z))
      const e = p - y[i]
      for (let j = 0; j < d; j++) g[j] += e * X[i][j]
      g[d] += e
    }
    for (let j = 0; j <= d; j++) w[j] -= (lr * g[j]) / X.length
  }
  return w
}

const predict = (w: number[], x: number[]): number => {
  let z = w[x.length]
  for (let j = 0; j < x.length; j++) z += w[j] * x[j]
  return 1 / (1 + Math.exp(-z))
}

/** Extra labels per own shot at a given recall — the manual-edit metric. */
function extrasAtRecall(rows: Row[], scores: number[], recall: number): number {
  const order = rows.map((_, i) => i).sort((a, b) => scores[b] - scores[a])
  const total = rows.filter((r) => r.own).length
  let tp = 0
  let fp = 0
  for (const i of order) {
    if (rows[i].own) tp++
    else fp++
    if (tp / total >= recall) return fp / Math.max(1, tp)
  }
  return fp / Math.max(1, tp)
}

async function main(): Promise<void> {
  const signals = JSON.parse(await readFile(join(PROJECT_ROOT, 'eval/.cache/weaponSignals.json'), 'utf8')).clips as Record<
    string,
    { human: Series | null }
  >
  const { fixtures } = await loadAllFixtures()
  const netWeights = deserializeWeights(await readFile(join(PROJECT_ROOT, 'public/models/shotNet.json'), 'utf8'))
  const model: MotionModel = JSON.parse(await readFile(join(FIXTURES_DIR, 'models/motionModel.json'), 'utf8'))

  const rows: Row[] = []
  const slugs: string[] = []
  for (const f of fixtures) {
    const motion = await loadClipMotion(f.labels.slug)
    const series = signals[f.labels.slug]?.human
    if (!motion || !series) continue
    slugs.push(f.labels.slug)
    const own = f.labels.shots.filter((s) => s.source === 'own').map((s) => s.time)
    const sparse = own.length <= SPARSE_MAX_OWN
    const scale = median(series.diff.filter((v) => v > 0))
    for (const c of detectShotsWithNet(toMono(f.audio), f.audio.sampleRate, netWeights, { threshold: 0.3 })) {
      const feat = motionFeaturesAt(motion.zone, motion.weapon, c.time, c.confidence)
      const peak = peakAt(series.diff, series.fps, c.time)
      if (!feat || peak === null) continue
      rows.push({
        slug: f.labels.slug,
        time: c.time,
        own: own.some((t) => Math.abs(t - c.time) <= TOLERANCE_S),
        sparse,
        motion: scoreMotion(model, feat),
        weapon: peak / scale,
      })
    }
  }

  // Folds BY CLIP: candidates within a clip are not independent, and splitting them apart
  // would mean measuring peeking.
  const foldOf = new Map(slugs.map((s, i) => [s, i % FOLDS]))
  const base = new Array<number>(rows.length).fill(0)
  const combo = new Array<number>(rows.length).fill(0)

  for (let k = 0; k < FOLDS; k++) {
    const train = rows.filter((r) => foldOf.get(r.slug) !== k)
    const y = train.map((r) => (r.own ? 1 : 0))
    const wBase = fit(train.map((r) => [r.motion]), y)
    const wCombo = fit(train.map((r) => [r.motion, r.weapon]), y)
    rows.forEach((r, i) => {
      if (foldOf.get(r.slug) !== k) return
      base[i] = predict(wBase, [r.motion])
      combo[i] = predict(wCombo, [r.motion, r.weapon])
    })
  }

  const f1At = (rs: Row[], sc: number[], threshold = 0.5) => {
    const byClip = new Map<string, { own: number[]; marks: number[] }>()
    rs.forEach((r, i) => {
      const e = byClip.get(r.slug) ?? { own: [], marks: [] }
      if (sc[i] >= threshold) e.marks.push(r.time)
      byClip.set(r.slug, e)
    })
    let tp = 0, fp = 0, fn = 0
    for (const f of fixtures) {
      const e = byClip.get(f.labels.slug)
      if (!e) continue
      const own = f.labels.shots.filter((s) => s.source === 'own').map((s) => s.time).sort((a, b) => a - b)
      const s = scoreDetections(own, e.marks.sort((a, b) => a - b), TOLERANCE_S)
      tp += s.truePositives; fp += s.falsePositives; fn += s.falseNegatives
    }
    const p = tp / Math.max(1, tp + fp), r = tp / Math.max(1, tp + fn)
    return { f1: (2 * p * r) / Math.max(1e-9, p + r), p, r, marks: tp + fp }
  }

  console.log(`клипов ${slugs.length}, кандидатов ${rows.length}, своих ${rows.filter((r) => r.own).length}`)
  console.log(`окно признака ±${HALF_MS} мс, проверка ${FOLDS} фолдами по клипам`)
  console.log()
  console.log('  схема'.padEnd(34), 'F1'.padStart(7), 'точность'.padStart(9), 'полнота'.padStart(8), 'меток'.padStart(7))
  console.log('  ' + '-'.repeat(66))
  for (const [name, sc] of [['движение (перекалибровано)', base], ['движение + область оружия', combo]] as const) {
    const m = f1At(rows, sc)
    console.log(`  ${name.padEnd(32)}`, (100 * m.f1).toFixed(1).padStart(7), (100 * m.p).toFixed(1).padStart(9), (100 * m.r).toFixed(1).padStart(8), String(m.marks).padStart(7))
  }

  console.log()
  console.log('лишних меток на один свой выстрел (метрика объёма правок):')
  console.log('  схема'.padEnd(34), 'полнота 90%'.padStart(12), '80%'.padStart(8), '70%'.padStart(8))
  console.log('  ' + '-'.repeat(64))
  for (const [name, sc] of [['движение (перекалибровано)', base], ['движение + область оружия', combo]] as const) {
    const at = (r: number) => extrasAtRecall(rows, sc, r).toFixed(2).padStart(8)
    console.log(`  ${name.padEnd(32)}`, at(0.9).padStart(12), at(0.8), at(0.7))
  }

  console.log()
  console.log('по половинам набора, лишних на выстрел при полноте 80%:')
  for (const [name, only] of [['разреженные', true], ['плотные', false]] as const) {
    const idx = rows.map((_, i) => i).filter((i) => rows[i].sparse === only)
    const sub = idx.map((i) => rows[i])
    const b = extrasAtRecall(sub, idx.map((i) => base[i]), 0.8)
    const c = extrasAtRecall(sub, idx.map((i) => combo[i]), 0.8)
    console.log(`  ${name.padEnd(14)} движение ${b.toFixed(2)}  →  с областью ${c.toFixed(2)}   ${c < b ? 'лучше' : 'хуже'}`)
  }
}

void main()
