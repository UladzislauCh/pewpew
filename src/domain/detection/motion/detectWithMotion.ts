import type { DetectedShot } from '../shotDetection'
import { decodeGrayFrames, FULL_FRAME_SIZE, WEAPON_HEIGHT, WEAPON_WIDTH } from './frameSource'
import {
  assertMotionModel,
  computeWeaponMotion,
  computeZoneMotion,
  findGameplayBand,
  motionFeaturesAt,
  sampleGrayFrame,
  scoreMotion,
  type MotionModel,
  type WeaponMotion,
  type ZoneMotion,
} from './motionFeatures'
import {
  analyzeBlocks,
  assertBlockModel,
  BLOCK_FRAME,
  BLOCK_GRID,
  BlockFrames,
  CLASSIFY_FRAMES,
  selectWeaponBlocks,
  weaponShiftSeries,
  type BlockModel,
} from './blockMotion'
import {
  boxFromBlocks,
  fieldFrame,
  sampleWeaponCrop,
  WeaponFieldAccumulator,
  type FieldSeries,
  type WeaponBox,
} from './weaponField'
import { shotsFromAmmo, type AmmoRejection, type AmmoResult } from '../ammo/detectWithAmmo'
import { loadPrototypes } from '../ammo/reader'
import { AmmoScan } from '../ammo/scan'

/**
 * Second detection stage: keep the shots that were fired BY THIS PLAYER.
 *
 * The net answers "a shot is here" from audio, which cannot tell whose shot it was — enemy fire is
 * near-indistinguishable by ear (AUC 0.546 own vs enemy). Camera and weapon motion can: the view
 * kicks and the viewmodel jerks only when the player fires. Measured on 49 labelled clips by
 * cross-validation across clips: audio alone saves 1.00x of the manual labelling work — i.e.
 * nothing — while audio plus motion saves 2.20x.
 *
 * Cost is the reason this is a separate, awaitable stage rather than part of the audio pass: the
 * whole clip has to be decoded twice (full frame, then the weapon strip whose position depends on
 * the first pass). Measured at ~4.4 ms per frame of motion estimation, so roughly 8 s of compute
 * per minute of 30 fps video, plus decoding.
 */

// The `/__models/` URL is RESEARCH-ONLY, served only by the dev server. This stage is not called
// from the wizard, and there is no reason to ship its models to production: they live in
// `fixtures/`, not in `public/`. Product models (flashNet, shotNet, counter prototypes) stay
// where they were.
const MODEL_URL = '/__models/motionModel.json'
const MODEL_BLOCKS_URL = '/__models/motionModel.blocks.json'
const BLOCK_MODEL_URL = '/__models/blockModel.json'

let modelPromise: Promise<MotionModel> | null = null

export function loadMotionModel(url: string = MODEL_URL): Promise<MotionModel> {
  if (!modelPromise) {
    modelPromise = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`Не удалось загрузить модель движения: HTTP ${r.status}`)
        return r.json() as Promise<MotionModel>
      })
      .then((model) => {
        // Feature order is the only thing tying the extractor to the weights.
        // Without the check a shuffled order does not throw, it silently ruins quality.
        assertMotionModel(model)
        return model
      })
      .catch((e) => {
        modelPromise = null
        throw e
      })
  }
  return modelPromise
}

/**
 * Weights for the selected-blocks scheme — the same 74 features, but trained on signals
 * FROM A DIFFERENT REGION, hence a separate file.
 *
 * The features match by name and order, the weights do not: `weapon.*` here are taken from the
 * twelve blocks selected by the classifier, while in `motionModel.json` they come from the
 * variability band. Substituting one for the other silently yields garbage, because the name
 * check will not catch such a swap.
 *
 * There are exactly 74 features, not 77. Three frame-difference features inside the region were
 * tested and dropped: on consistent signals they give 62.3 against 62.3 without them, and on
 * sparse clips they drop 39.3 to 38.0.
 */
let blocksModelPromise: Promise<MotionModel> | null = null

export function loadBlocksMotionModel(url: string = MODEL_BLOCKS_URL): Promise<MotionModel> {
  if (!blocksModelPromise) {
    blocksModelPromise = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`Не удалось загрузить модель движения по блокам: HTTP ${r.status}`)
        return r.json() as Promise<MotionModel>
      })
      .then((model) => {
        assertMotionModel(model)
        return model
      })
      .catch((e) => {
        blocksModelPromise = null
        throw e
      })
  }
  return blocksModelPromise
}

let blockModelPromise: Promise<BlockModel> | null = null

export function loadBlockModel(url: string = BLOCK_MODEL_URL): Promise<BlockModel> {
  if (!blockModelPromise) {
    blockModelPromise = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`Не удалось загрузить модель блоков: HTTP ${r.status}`)
        return r.json() as Promise<BlockModel>
      })
      .then((model) => {
        assertBlockModel(model)
        return model
      })
      .catch((e) => {
        blockModelPromise = null
        throw e
      })
  }
  return blockModelPromise
}

/**
 * Motion score a candidate must reach to stay on screen.
 *
 * Measured on the 49 labelled clips: audio alone scores F1 34.9 (89% recall, 4808 marks) and the
 * spectral-flow detector it replaces scores 49.7 (46% recall, 974 marks). Filtering the audio
 * candidates by motion gives F1 64.3 at this threshold — 75% recall for 1563 marks — rising to
 * 66.2 at 0.6. The lower value is chosen deliberately: a missing shot has to be found by ear,
 * while a spurious one is removed with the editor's slider.
 *
 * Lived in `WizardApp`, moved here when the flash became the product path: the motion stage is
 * not called from the wizard, but stays working, with its own threshold.
 */
export const DEFAULT_MOTION_THRESHOLD = 0.5

export interface MotionScoredShot extends DetectedShot {
  /** Probability "this is an own shot" from motion, 0..1. */
  motionScore: number
  /**
   * Where the label came from. `ammo` — the ammo counter was read, i.e. the game reported the
   * shot directly; `motion` — an indirect estimate from camera and weapon motion.
   */
  source?: 'ammo' | 'motion'
}

export interface MotionDetectionOptions {
  signal?: AbortSignal
  /** Progress 0..1 — decoding takes seconds, and without it the screen looks frozen. */
  onProgress?: (fraction: number) => void
  /** Disable the ammo counter and use only the old scheme. For reconciling the two paths. */
  ammo?: boolean
  /**
   * Compute the weapon-region field series and export them in `MotionTrace`.
   *
   * Off by default, and that is a measurement result, not caution: the field features were
   * TESTED by the metric and rejected. At equal recall they make things worse — on clips with
   * per-frame labels 0.35 extras per shot against 0.30 for the baseline, and so at every frame
   * offset. The product should not pay for this, but the measurement pipeline needs the series:
   * without them the measurement cannot be reproduced.
   */
  field?: boolean
}

/**
 * What the ammo counter decided — for reconciling the product path with the measurement pipeline.
 *
 * Without the hook a discrepancy between them is localised by guessing: the slot, the reading
 * series, the offset and the snapping all live inside one pass and are not visible outside.
 */
let ammoListener: ((result: AmmoResult | AmmoRejection) => void) | null = null

export function onAmmoTrace(listener: ((result: AmmoResult | AmmoRejection) => void) | null): void {
  ammoListener = listener
}

/**
 * Scores audio candidates by motion. Returns them all, ranked — filtering is the editor's job,
 * because the cost of a spurious mark versus a missed one is a product decision, not a detector one.
 */
export async function scoreShotsByMotion(
  file: File | Blob,
  shots: DetectedShot[],
  duration: number,
  options: MotionDetectionOptions = {},
): Promise<MotionScoredShot[]> {
  if (!shots.length) return []

  // The new scheme needs both models; without either we take the old path.
  const [blockModel, blocksModel] = await Promise.all([
    loadBlockModel().catch(() => null),
    loadBlocksMotionModel().catch(() => null),
  ])
  const useBlocks = blockModel !== null && blocksModel !== null
  options.onProgress?.(0.05)

  // ONE pass over the video. 256x256 frames accumulate during the same pass that is made for
  // camera motion anyway, and everything else is computed from them afterwards: block analysis,
  // region selection and its shift. Previously the clip was decoded a second time for the latter —
  // and decoding is about 8 seconds of 10 on a 22-second clip.
  const blocks = useBlocks ? new BlockFrames() : null
  const blockArea = BLOCK_FRAME * BLOCK_FRAME

  // The ammo counter rides the same pass. Frames arrive here at NATIVE resolution, and that is
  // mandatory for it: in a 1080p frame the counter is about thirty pixels tall, and scaled down
  // to 384 only a few are left.
  const ammoScan = options.ammo === false ? null : await loadPrototypes().then((p) => new AmmoScan(p)).catch(() => null)
  let videoStart = 0
  let videoFps = 0

  const full = await decodeGrayFrames(
    file,
    { x0: 0, y0: 0, x1: 1, y1: 1 },
    FULL_FRAME_SIZE,
    FULL_FRAME_SIZE,
    duration,
    {
      signal: options.signal,
      onVideoStart: ammoScan ? (t) => { videoStart = t } : undefined,
      onVideoFps: ammoScan ? (f) => { videoFps = f } : undefined,
      onFrame:
        blocks || ammoScan
          ? (rgba, width, height, index) => {
              if (blocks) {
                const frame = new Uint8Array(blockArea)
                sampleGrayFrame(rgba, width, height, { x0: 0, y0: 0, x1: 1, y1: 1 }, BLOCK_FRAME, BLOCK_FRAME, frame)
                blocks.push(frame)
              }
              ammoScan?.push(rgba, width, height, index)
            }
          : undefined,
    },
  )
  options.onProgress?.(0.45)

  // Where the counter is read, it is the answer: the game reported its shot directly.
  // Where it is not — the old scheme works, audio plus motion.
  if (ammoScan) {
    const scan = ammoScan.result()
    // The VIDEO TRACK frame rate, not "frames divided by duration": the duration comes from audio
    // and does not match the video track, which accumulates up to half a frame by the end of the
    // clip — and that is the difference between hitting a shot and missing it.
    const fps = videoFps > 0 ? videoFps : full.frames / duration
    const ammo = shotsFromAmmo(scan, fps, shots.map((s) => s.time), videoStart)
    if (ammo.times) {
      ammoListener?.(ammo)
      // strength and motionScore = 1: the game reported the shot directly, nothing to rank.
      // relativeLoudness stays zero — loudness no longer has anything to do with the decision.
      return ammo.times.map((time) => ({
        time,
        strength: 1,
        relativeLoudness: 0,
        motionScore: 1,
        source: 'ammo' as const,
      }))
    }
    ammoListener?.(ammo)
  }

  const zone = computeZoneMotion(full)
  options.onProgress?.(0.6)

  if (blocks && blockModel && blocksModel) {
    const scored = scoreWithBlocks(shots, duration, zone, blocks, blockModel, blocksModel, options)
    if (scored) return scored
  }

  // Fallback to the old scheme: the variability band inside the gameplay band. It is worse — the
  // region lands on the webcam and smoke — but better than handing the user bare audio.
  return scoreWithBand(file, shots, duration, zone, await loadMotionModel(), options)
}

/**
 * Frames for block analysis — those with the strongest camera motion.
 *
 * Where the camera is still, "moves with the scene" and "pinned to the screen" are
 * indistinguishable, and analysing such a frame only adds noise. The magnitude is taken from the
 * already computed zone motion, so no extra pass over the video is needed.
 */
function pickClassifyFrames(zone: ZoneMotion, limit = CLASSIFY_FRAMES): number[] {
  const Z = zone.grid * zone.grid
  const magnitude: { frame: number; value: number }[] = []
  for (let f = 1; f < zone.frames; f++) {
    let m = 0
    for (let z = 0; z < Z; z++) m += Math.abs(zone.dx[z][f]) + Math.abs(zone.dy[z][f])
    magnitude.push({ frame: f, value: m / Z })
  }
  magnitude.sort((a, b) => b.value - a.value)
  return magnitude.slice(0, limit).map((x) => x.frame).sort((a, b) => a - b)
}

/**
 * Intermediate series of the new scheme — for reconciling the product path with the eval pipeline.
 *
 * Without it a discrepancy between them can only be localised by guessing: the region, camera
 * motion, region shift and scores live inside one function and are not visible outside.
 */
export interface MotionTrace {
  zoneFrames: number
  zoneFps: number
  weaponFrames: number
  weaponFps: number
  blocks: number[]
  dx: number[]
  dy: number[]
  scores: { time: number; audio: number; score: number }[]
  /**
   * Weapon-region field series. For now they go ONLY outward, to eval: weights for them are not
   * trained yet, and they do not enter the product decision.
   */
  field: Record<string, number[]> | null
}

let traceListener: ((trace: MotionTrace) => void) | null = null
export function onMotionTrace(listener: ((trace: MotionTrace) => void) | null): void {
  traceListener = listener
}

/**
 * Field series inside the weapon region.
 *
 * Computed from the same 256×256 frames the video pass keeps for the blocks — no second pass is
 * needed. Native resolution would have had nowhere to come from here anyway: the weapon region
 * is known only after block analysis.
 */
function computeFieldSeries(frames: BlockFrames, box: WeaponBox | null): FieldSeries | null {
  if (!box || frames.length === 0) return null
  const acc = new WeaponFieldAccumulator()
  for (let f = 0; f < frames.length; f++) {
    sampleWeaponCrop(frames.frameAt(f), BLOCK_FRAME, BLOCK_FRAME, box, acc.workspace.cur)
    acc.push(fieldFrame(acc.workspace))
    acc.workspace.swap()
  }
  return acc.series()
}

/** The new scheme: the region is twelve blocks selected by the classifier. */
function scoreWithBlocks(
  shots: DetectedShot[],
  duration: number,
  zone: ZoneMotion,
  blocks: BlockFrames,
  blockModel: BlockModel,
  model: MotionModel,
  options: MotionDetectionOptions,
): MotionScoredShot[] | null {
  const fps = blocks.length / duration
  const candidateFrames = new Set(shots.map((s) => Math.round(s.time * fps)))
  const stats = analyzeBlocks(blocks, pickClassifyFrames(zone), candidateFrames)
  if (!stats) return null

  const region = selectWeaponBlocks(blockModel, stats)
  const { dx, dy } = weaponShiftSeries(blocks, region)
  // The field is computed BEFORE the frames are released: after that the pixels are gone.
  const field = options.field ? computeFieldSeries(blocks, boxFromBlocks(region.blocks, BLOCK_GRID)) : null
  blocks.releaseFrames()
  options.onProgress?.(0.9)

  const weapon: WeaponMotion = {
    frames: blocks.length,
    fps,
    band: { y0: 0, y1: 1 },
    maskPx: region.blocks.length * 16 * 16,
    maskBox: { x0: 0, x1: 0, y0: 0, y1: 0 },
    dx,
    dy,
  }
  const scored = shots.map((shot) => {
    const features = motionFeaturesAt(zone, weapon, shot.time, shot.strength)
    // For a candidate at the very edge of the clip the window degenerates; keep the audio
    // confidence so the label does not silently vanish.
    const motionScore = features ? scoreMotion(model, features) : shot.strength
    return { ...shot, motionScore }
  })
  traceListener?.({
    zoneFrames: zone.frames,
    zoneFps: zone.fps,
    weaponFrames: weapon.frames,
    weaponFps: weapon.fps,
    blocks: region.blocks.slice().sort((a, b) => a - b),
    dx: Array.from(dx),
    dy: Array.from(dy),
    scores: scored.map((s) => ({ time: s.time, audio: s.strength, score: s.motionScore })),
    field: field
      ? Object.fromEntries(
          Object.entries(field).map(([name, values]) => [name, Array.from(values as Float64Array)]),
        )
      : null,
  })
  options.onProgress?.(1)
  return scored
}

/** The old scheme — fallback when the block classifier or its weights are unavailable. */
async function scoreWithBand(
  file: File | Blob,
  shots: DetectedShot[],
  duration: number,
  zone: ZoneMotion,
  model: MotionModel,
  options: MotionDetectionOptions,
): Promise<MotionScoredShot[]> {
  const band = findGameplayBand(zone)
  let weapon: WeaponMotion | null = null
  if (band) {
    const strip = await decodeGrayFrames(
      file,
      { x0: 0, y0: band.y0, x1: 1, y1: band.y1 },
      WEAPON_WIDTH,
      WEAPON_HEIGHT,
      duration,
      { signal: options.signal },
    )
    options.onProgress?.(0.85)
    weapon = computeWeaponMotion(strip, band)
  }
  options.onProgress?.(0.95)

  const scored = shots.map((shot) => {
    const features = motionFeaturesAt(zone, weapon, shot.time, shot.strength)
    const motionScore = features ? scoreMotion(model, features) : shot.strength
    return { ...shot, motionScore }
  })
  options.onProgress?.(1)
  return scored
}
