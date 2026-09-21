/**
 * Finding the weapon region by frame blocks, and motion features inside it.
 *
 * Replaces the old region search — the p10..p45 variability band and the largest connected
 * region — which did not land on the weapon. Checked by eye and by numbers: a person marked the
 * region on 49 clips, and the old heuristic barely overlaps their boxes — median IoU 0.065,
 * under 0.2 on 31 clips of 46, and on six it did not cover the box at all. The consequence was
 * measured: 16 `weapon.*` features out of 74 were a wash.
 *
 * How it works here.
 *
 * 1. The frame is cut into a 16x16 grid of blocks. On frames with strong camera motion each
 *    block is classed as "moves with the scene" or "pinned to the screen", and its liveliness
 *    and reaction to audio candidates are computed.
 * 2. Logistic regression on these features gives the probability "block is on the weapon".
 *    Trained on the person's boxes (`eval/weaponRegions.json`), validated with per-clip folds.
 * 3. The TWELVE blocks with the highest probability are taken — about 5% of the frame.
 *
 * Two measurement results shaped this design, and both are counter-intuitive.
 *
 * THE "DOES NOT MOVE WITH THE CAMERA" CRITERION DOES NOT WORK. It was proposed as the main one,
 * but its AUC for "block inside the person's box" is 0.528 — a coin toss. The reason: the
 * viewmodel is not pinned to the screen, it sways when walking and jerks on recoil — exactly
 * what we measure. What is pinned to the screen is the killfeed, nicknames and webcam. Other
 * features work: block liveliness 0.710, reaction to candidates 0.685, "moves, but not with
 * the scene" 0.631. The `pinned` feature is kept in the model as a weak one, but not as a filter.
 *
 * SOFT WEIGHTS ARE WORSE THAN HARD SELECTION. Weighting all 256 blocks by probability — 0.634,
 * a rectangle — 0.670, top-12 — 0.691. And weights INSIDE the selection give nothing:
 * "top-12 weighted" and "top-12 unweighted" match to the third decimal. Only which twelve
 * blocks matters.
 */

/** Side of the square the frame is resized to for block analysis. */
export const BLOCK_FRAME = 256
/** Block side in pixels of that square. */
export const BLOCK = 16
/** Block grid. */
export const BLOCK_GRID = BLOCK_FRAME / BLOCK
export const BLOCK_COUNT = BLOCK_GRID * BLOCK_GRID
/** Block shift search limit when classifying into "scene" and "pinned". */
const CLASSIFY_MAX_SHIFT = 6
/** Weapon region shift search limit. */
export const WEAPON_MAX_SHIFT = 8
/**
 * "Shift matched" tolerance, pixels. A strict zero selects only UI: the viewmodel sways, and
 * with zero tolerance banners and black bars end up "pinned" while the barrel drops out.
 */
const SHIFT_TOLERANCE = 1.5
/** How many highest-probability blocks form the region. The optimum was measured. */
export const TOP_BLOCKS = 12
/** How many frames with the strongest camera motion to analyse: where the camera is still, analysis is impossible. */
export const CLASSIFY_FRAMES = 60

/** Per-block result. All are shares and ratios: absolute levels do not transfer between clips. */
export interface BlockStats {
  /** Share of analysed frames where the block stayed put despite scene motion. */
  pinned: number
  /** Share where the block moved with the scene. */
  scene: number
  /** Median absolute frame difference — whether the block is "alive". The strongest single feature. */
  activity: number
  /** Frame difference at candidate moments divided by the usual one. The weapon jerks, the killfeed does not. */
  reacts: number
}

/** Logistic regression over block features. Weight order matches `blockFeatures`. */
export interface BlockModel {
  version: number
  /** Feature names — insurance against a shuffled order, as with the motion model. */
  features: string[]
  weights: number[]
  bias: number
}

export const BLOCK_FEATURE_NAMES: readonly string[] = [
  'activityRank',
  'reactsRank',
  'neither',
  'pinned',
  'scene',
  'x',
  'y',
  'xy',
]

/** Mean absolute block difference at a shift. Every other pixel — twice as fast, same quality. */
export function blockCost(
  data: Uint8Array,
  prevOffset: number,
  curOffset: number,
  bx: number,
  by: number,
  sx: number,
  sy: number,
): number {
  let sum = 0
  let n = 0
  for (let y = by; y < by + BLOCK; y += 2) {
    const ty = y + sy
    if (ty < 0 || ty >= BLOCK_FRAME) continue
    for (let x = bx; x < bx + BLOCK; x += 2) {
      const tx = x + sx
      if (tx < 0 || tx >= BLOCK_FRAME) continue
      sum += Math.abs(data[prevOffset + ty * BLOCK_FRAME + tx] - data[curOffset + y * BLOCK_FRAME + x])
      n++
    }
  }
  return n ? sum / n : 0
}

export const blockOriginX = (block: number): number => (block % BLOCK_GRID) * BLOCK
export const blockOriginY = (block: number): number => ((block / BLOCK_GRID) | 0) * BLOCK

/**
 * Scene shift as the MODE of the joint distribution of block shifts.
 *
 * Not the median: there are two populations — pinned at zero and the scene — and the
 * per-component median lands BETWEEN them. On frame 14 of the `ak47` clip 269 blocks were at
 * (0,0), the scene was around (4,−3), the median gave (0,−2) and zero matches with either.
 * The zero cell is excluded: that is where the screen-pinned stuff sits.
 */
function sceneShift(shifts: { dx: number; dy: number }[]): { dx: number; dy: number } | null {
  const counts = new Map<string, number>()
  for (const s of shifts) {
    if (Math.abs(s.dx) <= SHIFT_TOLERANCE && Math.abs(s.dy) <= SHIFT_TOLERANCE) continue
    const key = `${s.dx},${s.dy}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let bestKey: string | null = null
  let bestN = 0
  for (const [k, n] of counts) if (n > bestN) { bestN = n; bestKey = k }
  // The mode must be a real population, not a stray block.
  if (!bestKey || bestN < shifts.length * 0.06) return null
  const [dx, dy] = bestKey.split(',').map(Number)
  return { dx, dy }
}

/**
 * 256x256 frames and per-block frame differences, collected in ONE decoding pass.
 *
 * The buffer is needed so that there stays one pass. Frames for "scene" vs "pinned"
 * classification are chosen by the amount of camera motion, which is known only after the
 * whole clip has been seen; the region shift is computed from pixels and also needs frames.
 * Previously a second pass over the video was made for that second need — the most expensive
 * part of the second stage (decoding is about 8 s of 10 on a 22-second clip).
 *
 * The buffer costs 64 KB per frame, i.e. about 118 MB per minute at 30 fps. The old scheme
 * held a comparable amount: a full 384x384 frame plus a 320x140 weapon band.
 */
export class BlockFrames {
  private readonly frames: Uint8Array[] = []
  /**
   * Differences are stored as floats, not bytes.
   *
   * The classifier is trained on the MEDIANS of these differences, and a typical block
   * difference is a few brightness units. Rounding to a byte with scale 4 lost a quarter unit,
   * and the median drifted; the cost of honest storage is 1 KB per frame, under two megabytes a minute.
   */
  private readonly diffs: Float32Array[] = []

  /**
   * Frame count. Counted by DIFFERENCES, not by pixels: pixels are released after region
   * selection, and a length based on them would drop to zero.
   *
   * There has already been a bug from this: `weapon.frames` got zero, the window degenerated,
   * all 16 weapon features became NaN, and the model substituted means for them. The product
   * path meanwhile silently scored on the camera alone — there was no crash, because NaN is a
   * legitimate value here and means "no data".
   */
  get length(): number {
    return this.diffs.length
  }

  /** Stores a frame and computes its difference with the previous one. Frames arrive in order. */
  push(frame: Uint8Array): void {
    this.frames.push(frame)
    const index = this.frames.length - 1
    const row = new Float32Array(BLOCK_COUNT)
    if (index > 0) {
      const prev = this.frames[index - 1]
      for (let b = 0; b < BLOCK_COUNT; b++) {
        row[b] = blockCostBetween(prev, frame, blockOriginX(b), blockOriginY(b), 0, 0)
      }
    }
    this.diffs.push(row)
  }

  frameAt(index: number): Uint8Array {
    return this.frames[index]
  }

  diffAt(index: number): Float32Array {
    return this.diffs[index]
  }

  /** Releases pixels, keeping the differences: after block selection frames are no longer needed. */
  releaseFrames(): void {
    this.frames.length = 0
  }
}

/** Mean absolute block difference between two separate frames. */
export function blockCostBetween(
  prev: Uint8Array,
  cur: Uint8Array,
  bx: number,
  by: number,
  sx: number,
  sy: number,
): number {
  let sum = 0
  let n = 0
  for (let y = by; y < by + BLOCK; y += 2) {
    const ty = y + sy
    if (ty < 0 || ty >= BLOCK_FRAME) continue
    for (let x = bx; x < bx + BLOCK; x += 2) {
      const tx = x + sx
      if (tx < 0 || tx >= BLOCK_FRAME) continue
      sum += Math.abs(prev[ty * BLOCK_FRAME + tx] - cur[y * BLOCK_FRAME + x])
      n++
    }
  }
  return n ? sum / n : 0
}

/**
 * Classifying blocks into "scene" and "pinned to the screen", plus liveliness and reaction
 * to candidates.
 *
 * `classifyFrames` are the indices of frames with the strongest camera motion: where the camera
 * is still, the scene is indistinguishable from pinned, and classification is meaningless.
 */
export function analyzeBlocks(
  frames: BlockFrames,
  classifyFrames: readonly number[],
  candidateFrames: ReadonlySet<number>,
): BlockStats[] | null {
  if (frames.length < 2) return null

  const pinned = new Float64Array(BLOCK_COUNT)
  const scene = new Float64Array(BLOCK_COUNT)
  let analysed = 0

  for (const index of classifyFrames) {
    if (index < 1 || index >= frames.length) continue
    const prev = frames.frameAt(index - 1)
    const cur = frames.frameAt(index)
    if (!prev || !cur) continue

    const shifts: { dx: number; dy: number }[] = []
    for (let b = 0; b < BLOCK_COUNT; b++) {
      let best = Infinity
      let dx = 0
      let dy = 0
      for (let sy = -CLASSIFY_MAX_SHIFT; sy <= CLASSIFY_MAX_SHIFT; sy++) {
        for (let sx = -CLASSIFY_MAX_SHIFT; sx <= CLASSIFY_MAX_SHIFT; sx++) {
          const c = blockCostBetween(prev, cur, blockOriginX(b), blockOriginY(b), sx, sy)
          if (c < best) { best = c; dx = sx; dy = sy }
        }
      }
      shifts.push({ dx, dy })
    }
    const sc = sceneShift(shifts)
    if (!sc) continue
    analysed++
    for (let b = 0; b < BLOCK_COUNT; b++) {
      const s = shifts[b]
      const toZero = Math.hypot(s.dx, s.dy)
      const toScene = Math.hypot(s.dx - sc.dx, s.dy - sc.dy)
      // The hypothesis is chosen EXCLUSIVELY: at small shifts the thresholds overlap, and the
      // same HUD block was counted for both. A tie goes to neither.
      if (toZero + SHIFT_TOLERANCE < toScene) pinned[b]++
      else if (toScene + SHIFT_TOLERANCE < toZero) scene[b]++
    }
  }
  if (!analysed) return null

  // MEDIAN, not mean: the classifier is trained on exactly that. The mean is pulled up by rare
  // frames with a cut or a flash, and block "liveliness" starts measuring them instead of the block.
  const all: number[][] = Array.from({ length: BLOCK_COUNT }, () => [])
  const cand: number[][] = Array.from({ length: BLOCK_COUNT }, () => [])
  for (let f = 1; f < frames.length; f++) {
    const row = frames.diffAt(f)
    const near = candidateFrames.has(f) || candidateFrames.has(f - 1) || candidateFrames.has(f + 1)
    for (let b = 0; b < BLOCK_COUNT; b++) {
      all[b].push(row[b])
      if (near) cand[b].push(row[b])
    }
  }
  if (!all[0].length) return null
  const median = (v: number[]): number => {
    if (!v.length) return 0
    const sorted = [...v].sort((a, b) => a - b)
    return sorted[sorted.length >> 1]
  }

  return Array.from({ length: BLOCK_COUNT }, (_, b) => {
    const base = median(all[b])
    return {
      pinned: pinned[b] / analysed,
      scene: scene[b] / analysed,
      activity: base,
      reacts: cand[b].length ? median(cand[b]) / Math.max(0.5, base) : 1,
    }
  })
}

/** Rank within the clip, 0..1. Absolute levels do not transfer between clips. */
function ranks(values: number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0])
  const out = new Array<number>(values.length).fill(0)
  order.forEach(([, i], k) => { out[i] = k / Math.max(1, values.length - 1) })
  return out
}

/** Block features in `BLOCK_FEATURE_NAMES` order. */
export function blockFeatures(stats: BlockStats[]): number[][] {
  const act = ranks(stats.map((b) => b.activity))
  const rea = ranks(stats.map((b) => b.reacts))
  return stats.map((b, i) => {
    const x = ((i % BLOCK_GRID) + 0.5) / BLOCK_GRID
    const y = ((i / BLOCK_GRID | 0) + 0.5) / BLOCK_GRID
    return [act[i], rea[i], Math.max(0, 1 - b.pinned - b.scene), b.pinned, b.scene, x, y, x * y]
  })
}

export function assertBlockModel(model: BlockModel): void {
  if (model.features.length !== BLOCK_FEATURE_NAMES.length) {
    throw new Error(`модель блоков ждёт ${model.features.length} признаков, извлекатель даёт ${BLOCK_FEATURE_NAMES.length}`)
  }
  for (let i = 0; i < model.features.length; i++) {
    if (model.features[i] !== BLOCK_FEATURE_NAMES[i]) {
      throw new Error(`признак ${i}: модель ждёт «${model.features[i]}», извлекатель даёт «${BLOCK_FEATURE_NAMES[i]}»`)
    }
  }
}

/**
 * Diagnostics hook: reports which blocks were chosen.
 *
 * Needed to reconcile the product path with the eval pipeline: if the paths disagree in numbers,
 * the first thing to know is whether they found the same region.
 */
let regionListener: ((blocks: number[]) => void) | null = null
export function onRegionPicked(listener: ((blocks: number[]) => void) | null): void {
  regionListener = listener
}

/** The selected region: block indices and their probabilities. */
export interface WeaponRegion {
  blocks: number[]
  /** Probability "the weapon is here" for each of them, in the same order. */
  weights: number[]
}

/**
 * The `TOP_BLOCKS` blocks with the highest "the weapon is here" probability, with the probabilities.
 *
 * The probabilities are needed by the shift search: it looks for the shift minimising the
 * WEIGHTED sum of costs, and a block the classifier is sure about pulls harder. That is exactly
 * how the series the motion model was trained on were computed; an equal-weight sum gives
 * different shifts.
 *
 * On the frame-difference feature the weights had no effect at all — "top-12 weighted" and
 * "top-12 unweighted" matched to the third decimal. Only the set of twelve matters.
 */
export function selectWeaponBlocks(model: BlockModel, stats: BlockStats[]): WeaponRegion {
  const features = blockFeatures(stats)
  const probability = features.map((f) => {
    let z = model.bias
    for (let j = 0; j < f.length; j++) z += model.weights[j] * f[j]
    return 1 / (1 + Math.exp(-z))
  })
  const picked = probability
    .map((p, i) => [p, i] as const)
    .sort((a, b) => b[0] - a[0])
    .slice(0, TOP_BLOCKS)
  const region = { blocks: picked.map(([, i]) => i), weights: picked.map(([p]) => p) }
  regionListener?.(region.blocks)
  return region
}

/** Weapon region motion series: the same names as the old `WeaponMotion`. */
export interface WeaponBlockMotion {
  frames: number
  fps: number
  blocks: number[]
  dx: Float64Array
  dy: Float64Array
  /** Frame difference inside the region without shift compensation. */
  diff: Float64Array
}

/** Weapon region shift series: a probability-weighted search. */
export function weaponShiftSeries(frames: BlockFrames, region: WeaponRegion): { dx: Float64Array; dy: Float64Array } {
  const dx = new Float64Array(frames.length)
  const dy = new Float64Array(frames.length)
  const total = region.weights.reduce((a, b) => a + b, 0) || 1
  for (let f = 1; f < frames.length; f++) {
    const prev = frames.frameAt(f - 1)
    const cur = frames.frameAt(f)
    let best = Infinity
    let bdx = 0
    let bdy = 0
    for (let sy = -WEAPON_MAX_SHIFT; sy <= WEAPON_MAX_SHIFT; sy++) {
      for (let sx = -WEAPON_MAX_SHIFT; sx <= WEAPON_MAX_SHIFT; sx++) {
        let cost = 0
        for (let k = 0; k < region.blocks.length; k++) {
          const b = region.blocks[k]
          cost += region.weights[k] * blockCostBetween(prev, cur, blockOriginX(b), blockOriginY(b), sx, sy)
        }
        cost /= total
        if (cost < best) { best = cost; bdx = sx; bdy = sy }
      }
    }
    dx[f] = bdx
    dy[f] = bdy
  }
  return { dx, dy }
}



/**
 * Frame-difference features inside the region were TESTED AND DROPPED — their absence here is deliberate.
 *
 * While the region shift was computed over the top 24 and the frame difference over the top 12,
 * three such features raised F1 from 61.4 to 62.3. As soon as both were computed over the same
 * twelve blocks, the gain vanished: 62.3 against 62.3, and on sparse clips 39.3 against 38.0,
 * i.e. harmful. The feature was fixing someone else's inaccuracy, not adding signal.
 *
 * Per-block difference series are still computed (`BlockFrames`), but go only into selection:
 * block liveliness and its reaction to audio candidates are taken from them.
 */
