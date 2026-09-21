/**
 * Sparse clips versus dense: what the motion threshold does.
 *
 * Diagnosis: the sound finds ~90% of own shots in both groups, while the second stage throws away
 * 73% of them in sparse clips. The question is whether loosening the threshold brings them back and at what cost.
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
const THRESHOLDS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6]
/** The sparse / dense boundary. 20 own shots — roughly the set's median. */
const SPARSE_MAX_OWN = 20

async function main(): Promise<void> {
  const { fixtures } = await loadAllFixtures()
  const weights = deserializeWeights(await readFile(join(PROJECT_ROOT, 'public/models/shotNet.json'), 'utf8'))
  const model: MotionModel = JSON.parse(await readFile(join(FIXTURES_DIR, 'models/motionModel.json'), 'utf8'))

  type Clip = { slug: string; own: number[]; scored: { time: number; score: number }[] }
  const clips: Clip[] = []
  for (const f of fixtures) {
    const m = await loadClipMotion(f.labels.slug)
    if (!m) continue
    const own = f.labels.shots.filter((s) => s.source === 'own').map((s) => s.time).sort((a, b) => a - b)
    const cands = detectShotsWithNet(toMono(f.audio), f.audio.sampleRate, weights, { threshold: MOTION_PARAMS.candidateThreshold })
    const scored = cands.map((c) => {
      const feat = motionFeaturesAt(m.zone, m.weapon, c.time, c.confidence)
      return { time: c.time, score: feat ? scoreMotion(model, feat) : c.confidence }
    })
    clips.push({ slug: f.labels.slug, own, scored })
  }

  const sparse = clips.filter((c) => c.own.length <= SPARSE_MAX_OWN)
  const dense = clips.filter((c) => c.own.length > SPARSE_MAX_OWN)
  console.log(`разреженных (≤${SPARSE_MAX_OWN} своих): ${sparse.length}, плотных: ${dense.length}`)
  console.log(`своих выстрелов: в разреженных ${sparse.reduce((a, c) => a + c.own.length, 0)}, в плотных ${dense.reduce((a, c) => a + c.own.length, 0)}`)
  console.log()

  const report = (name: string, group: Clip[]) => {
    console.log(`--- ${name}`)
    console.log('порог'.padEnd(8) + 'полнота'.padStart(9) + 'точность'.padStart(10) + 'F1'.padStart(7) + 'меток'.padStart(8) + 'лишних на выстрел'.padStart(20))
    for (const t of THRESHOLDS) {
      let tp = 0, fp = 0, fn = 0, marks = 0, own = 0
      for (const c of group) {
        const picked = c.scored.filter((s) => s.score >= t).map((s) => s.time).sort((a, b) => a - b)
        const s = scoreDetections(c.own, picked, TOLERANCE_S)
        tp += s.truePositives; fp += s.falsePositives; fn += s.falseNegatives
        marks += picked.length; own += c.own.length
      }
      const p = tp + fp ? tp / (tp + fp) : 0
      const r = tp + fn ? tp / (tp + fn) : 0
      const f1 = p + r ? (2 * p * r) / (p + r) : 0
      console.log(
        t.toFixed(1).padEnd(8) +
        (r * 100).toFixed(0).padStart(8) + '%' +
        (p * 100).toFixed(0).padStart(9) + '%' +
        (f1 * 100).toFixed(1).padStart(7) +
        String(marks).padStart(8) +
        (fp / own).toFixed(2).padStart(20),
      )
    }
    console.log()
  }
  report(`разреженные, ${sparse.length} клипов`, sparse)
  report(`плотные, ${dense.length} клипов`, dense)
}

void main()
