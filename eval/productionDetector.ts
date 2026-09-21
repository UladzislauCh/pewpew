/**
 * The detector that is ACTUALLY in the product: candidates by the audio network, then the motion filter.
 *
 * Before this `pnpm eval` measured `createDefaultDetector()` — the old spectral pipeline, which is
 * on no execution path in the app. The baseline recorded in `eval/baseline.json` (July 29,
 * F1 53.8) described it too. So for many weeks the project's standard measurement measured
 * something other than what ships, and no improvement to the production scheme could be verified with it.
 *
 * Motion is read from `eval/.cache`, not decoded: Node has neither canvas nor WebCodecs.
 * So the measurement describes the model's DECISION, not decoding. That decoding does not
 * interfere was checked on all clips twice: for the previous scheme the divergence is 0.2 F1
 * points, for the block scheme 0.1 points with 98.9% matching decisions (eval/browserCheckEval.ts).
 *
 * There are two schemes, and the one with material available is used:
 *
 *   BY BLOCKS — the weapon region from twelve blocks selected by the classifier.
 *               This is what ships. Needs `eval/.cache/blockSignals.json`
 *               and `public/models/motionModel.blocks.json`.
 *   PREVIOUS  — the variability band inside the gameplay band. Fallback if there is no block cache.
 *
 * The block cache is computed by the browser: `pnpm exec tsx eval/weightedPrep.ts --prod`, then
 * `/eval/weighted.html`, then move `weightedSignals.json` to `blockSignals.json`.
 * The `--prod` flag matters: without it the block weights are cross-validated ones, and the
 * measurement would describe a region selection other than the product's.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { toMono } from '../src/domain/audio/audioTypes'
import { detectShotsWithNet } from '../src/domain/detection/shotNet/detectShotsWithNet'
import { deserializeWeights } from '../src/domain/detection/shotNet/shotNet'
import {
  motionFeaturesAt,
  MOTION_PARAMS,
  scoreMotion,
  type MotionModel,
  type WeaponMotion,
} from '../src/domain/detection/motion/motionFeatures'
import type { Detector } from './evaluate'
import { FIXTURES_DIR, PROJECT_ROOT } from './fixtures'
import { loadClipMotion, type ClipMotion } from './motionCache'

/** Second-stage threshold. The product uses 0.5, not the F1-maximising 0.6 — a product decision:
 *  the user looks for a missed shot by ear, and removes an extra label with the slider. */
export const MOTION_THRESHOLD = 0.5

export interface ProductionDetector {
  detect: Detector
  /** Clips with no motion cache: scored by sound ONLY. */
  missingMotion: string[]
  /** Which scheme was measured. */
  scheme: 'blocks' | 'band'
  /** Clips without per-block signals: scored by the previous scheme. */
  missingBlocks: string[]
}

interface BlockSeries {
  frames: number
  fps: number
  dx: number[]
  dy: number[]
}

/** Weapon-region series over the selected blocks, captured by the browser. */
async function loadBlockSignals(): Promise<Record<string, BlockSeries> | null> {
  const path = join(PROJECT_ROOT, 'eval/.cache/blockSignals.json')
  if (!existsSync(path)) return null
  const raw = JSON.parse(await readFile(path, 'utf8')) as { clips: Record<string, BlockSeries | null> }
  const out: Record<string, BlockSeries> = {}
  for (const [slug, s] of Object.entries(raw.clips)) if (s) out[slug] = s
  return out
}

export async function createProductionDetector(slugs: string[]): Promise<ProductionDetector> {
  const netWeights = deserializeWeights(
    await readFile(join(PROJECT_ROOT, 'public/models/shotNet.json'), 'utf8'),
  )
  const bandModel: MotionModel = JSON.parse(
    await readFile(join(FIXTURES_DIR, 'models/motionModel.json'), 'utf8'),
  )
  const blocksPath = join(FIXTURES_DIR, 'models/motionModel.blocks.json')
  const blocksModel: MotionModel | null = existsSync(blocksPath)
    ? JSON.parse(await readFile(blocksPath, 'utf8'))
    : null
  const blockSignals = blocksModel ? await loadBlockSignals() : null
  const scheme: 'blocks' | 'band' = blockSignals ? 'blocks' : 'band'
  const missingBlocks: string[] = []

  const motionBySlug = new Map<string, ClipMotion>()
  const missingMotion: string[] = []
  for (const slug of slugs) {
    const motion = await loadClipMotion(slug)
    if (motion) motionBySlug.set(slug, motion)
    else missingMotion.push(slug)
  }

  for (const slug of slugs) {
    if (motionBySlug.has(slug) && blockSignals && !blockSignals[slug]) missingBlocks.push(slug)
  }

  const detect: Detector = (audio, fixture) => {
    const slug = fixture.labels.slug
    const shots = detectShotsWithNet(toMono(audio), audio.sampleRate, netWeights, {
      threshold: MOTION_PARAMS.candidateThreshold,
    })
    const motion = motionBySlug.get(slug)
    // Without a motion cache only bare candidates remain — the app behaves the same
    // when the second stage fails: fall back to the previous one, not an empty result.
    if (!motion) return shots.map((s) => s.time)

    const series = blockSignals?.[slug]
    // The region from selected blocks takes the place of the previous one: feature names and
    // order are the same, only the weights differ — and that is why they live in a separate file.
    const weapon: WeaponMotion | null =
      series && blocksModel
        ? {
            frames: series.frames,
            fps: series.fps,
            band: { y0: 0, y1: 1 },
            maskPx: 0,
            maskBox: { x0: 0, x1: 0, y0: 0, y1: 0 },
            dx: Float64Array.from(series.dx),
            dy: Float64Array.from(series.dy),
          }
        : motion.weapon
    const model = series && blocksModel ? blocksModel : bandModel

    return shots
      .filter((shot) => {
        const features = motionFeaturesAt(motion.zone, weapon, shot.time, shot.confidence)
        // For a candidate at the very edge of the clip the window degenerates; prod keeps the label.
        if (!features) return true
        return scoreMotion(model, features) >= MOTION_THRESHOLD
      })
      .map((s) => s.time)
  }

  return { detect, missingMotion, scheme, missingBlocks }
}
