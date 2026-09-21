/**
 * Does the motion stage repair what the net alone broke?
 *
 *   pnpm exec tsx eval/compareMotion.ts
 *
 * `compareNet.ts` showed the net alone is a regression on this project's F1: it finds 88% of the
 * shots against 46%, but places 4.6x as many marks. That is the expected shape of a candidate
 * generator installed without its filter. The filter is the motion model — camera and weapon
 * motion decide whose shot it was, which audio cannot.
 *
 * Motion is read from eval/.cache/motion rather than decoded here: the browser path goes through
 * mediabunny/canvas, which does not exist in Node. So this measures the DECISION, not the decoding.
 * Decoding fidelity is no longer an open risk — it was checked on all 49 clips and moves the F1 by
 * 0.2 points (docs/HANDOFF-detection.md, eval/decodeCheck.ts).
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { evaluateAll, createDefaultDetector, type Detector } from './evaluate'
import { FIXTURES_DIR, PROJECT_ROOT, loadAllFixtures } from './fixtures'
import { loadClipMotion, type ClipMotion } from './motionCache'
import { toMono } from '../src/domain/audio/audioTypes'
import { detectShotsWithNet } from '../src/domain/detection/shotNet/detectShotsWithNet'
import { deserializeWeights } from '../src/domain/detection/shotNet/shotNet'
import {
  motionFeaturesAt,
  scoreMotion,
  type MotionModel,
} from '../src/domain/detection/motion/motionFeatures'

const SHOTNET_PATH = join(PROJECT_ROOT, 'public/models/shotNet.json')
const MOTION_PATH = join(FIXTURES_DIR, 'models/motionModel.json')

const CANDIDATE_THRESHOLD = 0.3
const MOTION_THRESHOLDS = [0, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]

function fmt(value: number): string {
  return (value * 100).toFixed(1).padStart(6)
}


async function main(): Promise<void> {
  const { fixtures } = await loadAllFixtures()
  const netWeights = deserializeWeights(await readFile(SHOTNET_PATH, 'utf8'))
  const motionModel: MotionModel = JSON.parse(await readFile(MOTION_PATH, 'utf8'))

  const motionBySlug = new Map<string, ClipMotion>()
  for (const fixture of fixtures) {
    const m = await loadClipMotion(fixture.labels.slug)
    if (m) motionBySlug.set(fixture.labels.slug, m)
  }

  const baseline = evaluateAll(fixtures, createDefaultDetector())
  const marksOf = (r: ReturnType<typeof evaluateAll>) =>
    r.clips.reduce((a, c) => a + c.predictedCount, 0)

  console.log(`клипов ${fixtures.length}, из них с кэшем движения ${motionBySlug.size}`)
  console.log()
  console.log('схема'.padEnd(30), 'F1'.padStart(7), 'точность'.padStart(9), 'полнота'.padStart(8), 'меток'.padStart(7))
  console.log('-'.repeat(66))
  console.log(
    'спектральный поток'.padEnd(30),
    fmt(baseline.aggregate.f1), fmt(baseline.aggregate.precision), fmt(baseline.aggregate.recall),
    String(marksOf(baseline)).padStart(7),
  )

  for (const motionThreshold of MOTION_THRESHOLDS) {
    // The detector is bound to the current clip's slug: matching goes by fixture.
    let currentSlug = ''
    const detect: Detector = (audio) => {
      const shots = detectShotsWithNet(toMono(audio), audio.sampleRate, netWeights, {
        threshold: CANDIDATE_THRESHOLD,
      })
      if (motionThreshold <= 0) return shots.map((s) => s.time)
      const motion = motionBySlug.get(currentSlug)
      if (!motion) return shots.map((s) => s.time)
      return shots
        .filter((shot) => {
          const f = motionFeaturesAt(motion.zone, motion.weapon, shot.time, shot.confidence)
          if (!f) return true
          return scoreMotion(motionModel, f) >= motionThreshold
        })
        .map((s) => s.time)
    }

    const clips = fixtures.map((fixture) => {
      currentSlug = fixture.labels.slug
      return evaluateAll([fixture], detect).clips[0]
    })
    let tp = 0, fp = 0, fn = 0
    for (const c of clips) {
      tp += c.loose.truePositives
      fp += c.loose.falsePositives
      fn += c.loose.falseNegatives
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn)
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
    const label = motionThreshold <= 0 ? 'сеть без фильтра' : `сеть + движение ${motionThreshold.toFixed(1)}`
    console.log(
      label.padEnd(30), fmt(f1), fmt(precision), fmt(recall),
      String(clips.reduce((a, c) => a + c.predictedCount, 0)).padStart(7),
    )
  }

  console.log()
  console.log('Движение читается из eval/.cache/motion: замеряется решение, а не декодирование.')
}

void main()
