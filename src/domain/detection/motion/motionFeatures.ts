/**
 * Motion features: 74 numbers per candidate, in exactly the order of models/motionModel.json.
 *
 * A port of `eval/zoneMotion.mjs` (camera motion by zone) and `eval/weaponMotionAll.mjs`
 * (the weapon model's own motion) from the eval pipeline to production. The only difference
 * is the input: in eval frames came as a binary cache from `frametool`, here from the decoder.
 * Everything else is ported literally, down to traversal order and tie-breaking: the weights
 * were trained on these numbers, and any discrepancy makes them meaningless.
 *
 * Why the features are what they are (measurements in eval/README.md):
 *
 *  - Audio alone is useless: 1.00x by volume of manual edits, i.e. parity with labelling
 *    from scratch. Motion carries everything — camera plus weapon give 2.20x.
 *  - Camera motion is measured PER ZONE, not as one shift per frame: on a shot the picture
 *    does not move as a whole.
 *  - The shift of the weapon ZONE is not weapon motion. The first measurement gave exactly
 *    0.000 on every clip, and the wrong conclusion "the weapon is static" was drawn from it.
 *    Block search finds the dominant shift of the zone, and the zone is dominated by the
 *    background around the model, so only pixels of the weapon mask must be counted.
 *  - The weapon mask is not "the most stable": in vertical crops the black bars are perfectly
 *    static and win such a selection (the second attempt gave zeros again). The weapon is
 *    MODERATELY stable, so the variability band between p10 and p45 is taken.
 *  - For the weapon the SHAPE of the trajectory matters, not its amplitude: by amplitude firing
 *    does not differ from walking at all (AUC 0.430 on |dy| — when walking the weapon moves
 *    even more), but by jaggedness and the 8-16 Hz band it does (0.764).
 */
import { fft } from '../shotNet/fft'

/** Grayscale frames, back to back: `frames * width * height` bytes. */
export interface GrayFrames {
  data: Uint8Array
  width: number
  height: number
  frames: number
  /**
   * Actual fps, i.e. `frames / duration` of the clip, not the nominal one from the container.
   * Features were extracted exactly this way in training, and windows around a candidate are
   * measured in frames — a mismatch would shift every window.
   */
  fps: number
}

/** A frame region as fractions from 0 to 1. */
export interface CropRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * Frame source: returns a frame region in grayscale, scaled to outW x outH.
 * This is the `frametool crop` interface that features were extracted with in training.
 *
 * TWO passes over the video are needed, and one will not do: the weapon band is found from
 * the motion zones, and those are known only after the whole clip has been seen.
 */
export type GrayFrameSource = (crop: CropRect, outW: number, outH: number) => Promise<GrayFrames> | GrayFrames

/** A candidate from the audio detector: exactly what `detectShotsWithNet` returns. */
export interface MotionCandidate {
  time: number
  confidence: number
}

/**
 * Geometry and windows. Match the `params` field in models/motionModel.json plus constants
 * from weaponMotionAll.mjs that are not in the weights file. Cannot be changed without retraining.
 */
export const MOTION_PARAMS = {
  /** Camera zone grid. */
  grid: 3,
  /** The whole frame is scaled into a square — aspect ratio is not preserved, as in training. */
  frameSize: 384,
  /** Half-window around a candidate, ms. On a single frame the kick drowns in estimate jitter. */
  halfMs: 250,
  /** FFT window length for the weapon trajectory shape, frames. */
  specN: 32,
  /** Zone shift search limit, pixels. */
  maxShift: 5,
  /** Size of the weapon band crop. */
  weaponWidth: 320,
  weaponHeight: 140,
  /** Weapon shift search limit, pixels. */
  weaponMaxShift: 6,
  /** Audio detector threshold for selecting candidates. */
  candidateThreshold: 0.3,
} as const

/** Camera motion by zone: per-shift series for every frame. */
export interface ZoneMotion {
  grid: number
  frames: number
  fps: number
  /** Per zone (index `row * grid + col`), length frames. Frame zero is always 0. */
  dx: Float64Array[]
  dy: Float64Array[]
}

/** The weapon model's own motion. */
export interface WeaponMotion {
  frames: number
  fps: number
  /** The frame band the motion was taken from. */
  band: { y0: number; y1: number }
  /** Weapon mask size in pixels and its bounds — for diagnostics. */
  maskPx: number
  maskBox: { x0: number; x1: number; y0: number; y1: number }
  dx: Float64Array
  dy: Float64Array
}

/**
 * Crops an RGBA frame region and converts it to grayscale — the same sampling that
 * `frametool crop` did in training: nearest neighbour and integer Rec.601.
 *
 * Smoothing scaling (e.g. `drawImage` on a canvas) gives DIFFERENT pixels, so the decoder
 * must convert frames with exactly this function.
 *
 * `stride` is the row length in bytes: with WebCodecs it can be larger than `width * 4`.
 */
export function sampleGrayFrame(
  rgba: Uint8Array | Uint8ClampedArray,
  srcW: number,
  srcH: number,
  crop: CropRect,
  outW: number,
  outH: number,
  out: Uint8Array = new Uint8Array(outW * outH),
  outOffset = 0,
  stride = srcW * 4,
): Uint8Array {
  const sx0 = Math.trunc(crop.x0 * srcW)
  const sy0 = Math.trunc(crop.y0 * srcH)
  const sw = Math.max(1, Math.trunc((crop.x1 - crop.x0) * srcW))
  const sh = Math.max(1, Math.trunc((crop.y1 - crop.y0) * srcH))

  for (let y = 0; y < outH; y++) {
    const sy = Math.min(srcH - 1, Math.max(0, sy0 + Math.trunc((y * sh) / outH)))
    const row = sy * stride
    const dst = outOffset + y * outW
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(srcW - 1, Math.max(0, sx0 + Math.trunc((x * sw) / outW)))
      const o = row + sx * 4
      out[dst + x] = (rgba[o] * 77 + rgba[o + 1] * 150 + rgba[o + 2] * 29) >> 8
    }
  }
  return out
}

/** Refine the minimum with a parabola through three points — gives sub-pixel fractions. */
function subpixel(cm1: number, c0: number, cp1: number): number {
  const d = cm1 - 2 * c0 + cp1
  if (Math.abs(d) < 1e-9) return 0
  const delta = (0.5 * (cm1 - cp1)) / d
  return Math.abs(delta) <= 1 ? delta : 0
}

/**
 * Rounding to three decimals is NOT cosmetic.
 *
 * In eval the shifts went through a cache where they were stored with three decimals, and the
 * model was trained on exactly those rounded series. Rounding snaps sub-pixel noise to zero,
 * and the sign-flip count rests on that zero: it is counted only over non-zero values and is
 * at the same time the strongest single feature (AUC 0.774).
 *
 * Measured on the aug clip: without rounding there are 20 exact zeros instead of 113, the
 * flips features diverge from training by up to 0.2, and the model score by up to 0.26 in probability.
 */
const round3 = (v: number): number => +v.toFixed(3)

/**
 * Camera motion over a zone grid.
 *
 * The shift is searched per axis: first the best vertical one, then the horizontal one given it.
 * Every other pixel is used — it did not affect quality, and it runs twice as fast.
 */
export function computeZoneMotion(frames: GrayFrames, grid: number = MOTION_PARAMS.grid): ZoneMotion {
  const { data, width: W, height: H, frames: N } = frames
  const maxShift = MOTION_PARAMS.maxShift
  const frameSize = W * H

  // Zone boundaries are integers: at 384/3 that is exactly 0, 128, 256, 384, as in training.
  const bx = Array.from({ length: grid + 1 }, (_, i) => Math.round((i * W) / grid))
  const by = Array.from({ length: grid + 1 }, (_, i) => Math.round((i * H) / grid))

  const cost = (fPrev: number, fCur: number, x0: number, x1: number, y0: number, y1: number, sx: number, sy: number): number => {
    const a = fPrev * frameSize
    const b = fCur * frameSize
    let sum = 0
    let n = 0
    for (let y = Math.max(y0, y0 - sy); y < Math.min(y1, y1 - sy); y += 2) {
      const rowA = (y + sy) * W
      const rowB = y * W
      for (let x = Math.max(x0, x0 - sx); x < Math.min(x1, x1 - sx); x += 2) {
        sum += Math.abs(data[a + rowA + x + sx] - data[b + rowB + x])
        n++
      }
    }
    return n ? sum / n : Infinity
  }

  const Z = grid * grid
  const dx: Float64Array[] = []
  const dy: Float64Array[] = []
  for (let z = 0; z < Z; z++) {
    dx.push(new Float64Array(N))
    dy.push(new Float64Array(N))
  }

  const cy = new Float64Array(2 * maxShift + 1)
  const cx = new Float64Array(2 * maxShift + 1)

  for (let fr = 1; fr < N; fr++) {
    for (let zy = 0; zy < grid; zy++) {
      for (let zx = 0; zx < grid; zx++) {
        const z = zy * grid + zx
        const x0 = bx[zx]
        const x1 = bx[zx + 1]
        const y0 = by[zy]
        const y1 = by[zy + 1]

        for (let s = -maxShift; s <= maxShift; s++) cy[s + maxShift] = cost(fr - 1, fr, x0, x1, y0, y1, 0, s)
        let iy = 0
        for (let i = 1; i < cy.length; i++) if (cy[i] < cy[iy]) iy = i
        dy[z][fr] = round3(iy - maxShift + (iy > 0 && iy < cy.length - 1 ? subpixel(cy[iy - 1], cy[iy], cy[iy + 1]) : 0))

        const fixedY = iy - maxShift
        for (let s = -maxShift; s <= maxShift; s++) cx[s + maxShift] = cost(fr - 1, fr, x0, x1, y0, y1, s, fixedY)
        let ix = 0
        for (let i = 1; i < cx.length; i++) if (cx[i] < cx[ix]) ix = i
        dx[z][fr] = round3(ix - maxShift + (ix > 0 && ix < cx.length - 1 ? subpixel(cx[ix - 1], cx[ix], cx[ix + 1]) : 0))
      }
    }
  }

  return { grid, frames: N, fps: frames.fps, dx, dy }
}

/**
 * The frame band containing the weapon model.
 *
 * It cannot be a constant: in vertical crops the game field is a narrow middle band, with a
 * banner above and a webcam below. The game field is found from the motion zones (where there
 * is no motion, there is no gameplay), and the weapon lies in its lower half.
 *
 * Returns null if there is no motion in the frame at all.
 */
export function findGameplayBand(zone: ZoneMotion): { y0: number; y1: number } | null {
  const G = zone.grid
  const rowMotion: number[] = []
  for (let r = 0; r < G; r++) {
    let s = 0
    for (let c = 0; c < G; c++) {
      const a = zone.dy[r * G + c]
      let m = 0
      for (const v of a) m += Math.abs(v)
      s += m / a.length
    }
    rowMotion.push(s / G)
  }

  const peak = Math.max(...rowMotion)
  if (peak < 0.05) return null
  const live = rowMotion.map((v) => v >= peak * 0.25)
  const first = live.indexOf(true)
  const last = live.lastIndexOf(true)
  if (first < 0) return null

  const y0 = first / G
  const y1 = (last + 1) / G
  // The weapon is in the LOWER half of the game field.
  // Four decimals is exactly the precision the crop was specified with in training.
  return { y0: +(y0 + (y1 - y0) * 0.45).toFixed(4), y1: +y1.toFixed(4) }
}

/**
 * The weapon model's own motion over the frames of the band found by `findGameplayBand`.
 *
 * The camera is fixed to the player's head and does not jerk on a shot; the weapon model itself
 * moves. The mask is taken from the p10..p45 variability band and the largest connected region:
 * the bars do not change at all, the scene changes a lot, the weapon is in between. The shift is
 * computed ONLY over mask pixels — otherwise the background dominates and the result is exactly zero.
 *
 * Returns null if the mask did not accumulate (under 500 pixels) or there are too few frames.
 */
export function computeWeaponMotion(frames: GrayFrames, band: { y0: number; y1: number }): WeaponMotion | null {
  const { data, width: W, height: H, frames: N } = frames
  const frameSize = W * H
  if (N < 20) return null

  // Per-pixel variability over time. More than 250 frames are not needed, the estimate does not change.
  const step = Math.max(1, Math.floor(N / 250))
  const mean = new Float64Array(frameSize)
  const sq = new Float64Array(frameSize)
  let used = 0
  for (let fr = 0; fr < N; fr += step) {
    const off = fr * frameSize
    for (let i = 0; i < frameSize; i++) {
      const v = data[off + i]
      mean[i] += v
      sq[i] += v * v
    }
    used++
  }
  const sd = new Float64Array(frameSize)
  for (let i = 0; i < frameSize; i++) {
    const m = mean[i] / used
    sd[i] = Math.sqrt(Math.max(0, sq[i] / used - m * m))
  }

  const sorted = Float64Array.from(sd).sort()
  const q = (p: number): number => sorted[Math.floor(sorted.length * p)]
  const lo = Math.max(q(0.1), 3)
  const hi = q(0.45)

  const mask = new Uint8Array(frameSize)
  for (let i = 0; i < frameSize; i++) if (sd[i] >= lo && sd[i] <= hi) mask[i] = 1

  // Largest connected region of the mask: depth-first search over eight neighbours.
  const seen = new Uint8Array(frameSize)
  let bestComp: number[] = []
  const stack: number[] = []
  for (let s = 0; s < frameSize; s++) {
    if (!mask[s] || seen[s]) continue
    const px: number[] = []
    stack.push(s)
    seen[s] = 1
    while (stack.length) {
      const p = stack.pop() as number
      px.push(p)
      const x = p % W
      const y = (p / W) | 0
      for (let ddy = -1; ddy <= 1; ddy++) {
        for (let ddx = -1; ddx <= 1; ddx++) {
          const nx = x + ddx
          const ny = y + ddy
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
          const qq = ny * W + nx
          if (mask[qq] && !seen[qq]) {
            seen[qq] = 1
            stack.push(qq)
          }
        }
      }
    }
    if (px.length > bestComp.length) bestComp = px
  }
  if (bestComp.length < 500) return null

  const maxShift = MOTION_PARAMS.weaponMaxShift
  const wdx = new Float64Array(N)
  const wdy = new Float64Array(N)
  for (let fr = 1; fr < N; fr++) {
    const a = (fr - 1) * frameSize
    const b = fr * frameSize
    let bx = 0
    let by = 0
    let bc = Infinity
    for (let ddy = -maxShift; ddy <= maxShift; ddy++) {
      for (let ddx = -maxShift; ddx <= maxShift; ddx++) {
        let cost = 0
        let n = 0
        for (let k = 0; k < bestComp.length; k += 2) {
          const p = bestComp[k]
          const x = p % W
          const y = (p / W) | 0
          const sx = x + ddx
          const sy = y + ddy
          if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue
          cost += Math.abs(data[a + sy * W + sx] - data[b + p])
          n++
        }
        if (n > bestComp.length * 0.25) {
          const c = cost / n
          if (c < bc) {
            bc = c
            bx = ddx
            by = ddy
          }
        }
      }
    }
    wdx[fr] = bx
    wdy[fr] = by
  }

  let mnx = W
  let mxx = 0
  let mny = H
  let mxy = 0
  for (const p of bestComp) {
    const x = p % W
    const y = (p / W) | 0
    if (x < mnx) mnx = x
    if (x > mxx) mxx = x
    if (y < mny) mny = y
    if (y > mxy) mxy = y
  }

  return {
    frames: N,
    fps: frames.fps,
    band,
    maskPx: bestComp.length,
    maskBox: { x0: mnx, x1: mxx, y0: mny, y1: mxy },
    dx: wdx,
    dy: wdy,
  }
}

/** Names of the 74 features. The order must match the `features` field in models/motionModel.json. */
export const MOTION_FEATURE_NAMES: readonly string[] = (() => {
  const names: string[] = []
  for (let z = 0; z < MOTION_PARAMS.grid * MOTION_PARAMS.grid; z++) {
    for (const axis of ['dy', 'dx']) for (const stat of ['meanAbs', 'sd', 'flips']) names.push(`cam.zone${z}.${axis}.${stat}`)
  }
  names.push('cam.mismatch.meanAbs', 'cam.mismatch.sd', 'cam.mismatch.flips')
  for (const axis of ['dy', 'dx']) for (const stat of ['meanAbs', 'sd', 'flips']) names.push(`weapon.${axis}.${stat}`)
  for (const axis of ['dy', 'dx']) for (const stat of ['band0_3', 'band3_8', 'band8_16', 'roughness', 'meanSigned']) names.push(`weapon.${axis}.${stat}`)
  names.push('audioConfidence')
  return names
})()

/**
 * How many features weapon motion gives. Counted BY NAME, not as a constant.
 *
 * A constant 22 stood here while the actual count was 16, and `motionFeaturesAt` always threw
 * when the weapon mask did not accumulate: the vector length went to 80 against 74 names. In the
 * reference set all 49 clips have a mask, so measurements never saw it, but for a user with a
 * static clip (no gameplay band found) or a mask under 500 px the whole second stage fell back
 * to audio.
 */
const WEAPON_FEATURE_COUNT = MOTION_FEATURE_NAMES.filter((n) => n.startsWith('weapon.')).length

/** Series summary over a window: mean absolute value, SD and sign-flip rate. */
function summarize(sig: Float64Array, f0: number, f1: number, out: number[]): void {
  let sumAbs = 0
  let sum = 0
  let flips = 0
  let n = 0
  for (let f = f0; f <= f1; f++) {
    sumAbs += Math.abs(sig[f])
    sum += sig[f]
    if (f > f0 && Math.sign(sig[f]) !== Math.sign(sig[f - 1]) && sig[f] !== 0) flips++
    n++
  }
  const mean = sum / n
  let varSum = 0
  for (let f = f0; f <= f1; f++) varSum += (sig[f] - mean) ** 2
  out.push(sumAbs / n, Math.sqrt(varSum / n), flips / n)
}

/**
 * Trajectory shape: energy shares in bands, jaggedness, signed mean.
 *
 * The spectrum here does NOT measure fire rate: the hypothesis of camera oscillation at the
 * weapon's frequency was tested and refuted (a long window and narrow bands do not help). What
 * is measured is the roughness of motion over a short stretch — enough to tell a recoil jerk
 * from the smooth sway of walking.
 */
function shape(sig: Float64Array, ctr: number, frames: number, fps: number, out: number[]): void {
  const specN = MOTION_PARAMS.specN
  const f0 = Math.max(1, Math.min(frames - specN - 1, ctr - (specN >> 1)))
  // Clamped reads within the series: on a clip shorter than the FFT window this would give NaN otherwise.
  const at = (i: number): number => sig[Math.min(frames - 1, Math.max(0, i))]

  const re = new Float32Array(specN)
  const im = new Float32Array(specN)
  let mean = 0
  for (let i = 0; i < specN; i++) mean += at(f0 + i)
  mean /= specN
  for (let i = 0; i < specN; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (specN - 1)))
    re[i] = (at(f0 + i) - mean) * w
    im[i] = 0
  }
  fft(re, im)

  const bins = specN >> 1
  const power = new Float64Array(bins)
  let total = 0
  for (let k = 0; k < bins; k++) {
    power[k] = re[k] * re[k] + im[k] * im[k]
    total += power[k]
  }
  total = total || 1e-9
  const hz = fps / specN
  const band = (a: number, b: number): number => {
    let e = 0
    for (let k = 0; k < bins; k++) {
      const h = k * hz
      if (h >= a && h < b) e += power[k]
    }
    return e / total
  }

  let d2 = 0
  let amp = 0
  for (let i = f0 + 1; i < f0 + specN - 1; i++) {
    d2 += Math.abs(at(i + 1) - 2 * at(i) + at(i - 1))
    amp += Math.abs(at(i) - mean)
  }

  out.push(band(0, 3), band(3, 8), band(8, 16), d2 / Math.max(amp, 1e-6), mean)
}

/**
 * 74 features for one candidate.
 *
 * Returns null if the candidate sits at the very edge of the clip and the window degenerates —
 * the eval pipeline does the same, so summaries are not computed over two or three frames.
 *
 * If weapon motion was not extracted (`weapon === null`), its features are filled with NaN:
 * silently substituting zeros is wrong, zero in these features does not mean "no data" but a
 * quite definite motion. `scoreMotion` replaces NaN with the training mean.
 */
export function motionFeaturesAt(
  zone: ZoneMotion,
  weapon: WeaponMotion | null,
  time: number,
  audioConfidence: number,
  halfMs: number = MOTION_PARAMS.halfMs,
): Float64Array | null {
  const Z = zone.grid * zone.grid
  const centre = Math.round(time * zone.fps)
  const r = Math.max(2, Math.round((halfMs / 1000) * zone.fps))
  const f0 = Math.max(1, centre - r)
  const f1 = Math.min(zone.frames - 1, centre + r)
  if (f1 - f0 < 4) return null

  const v: number[] = []
  for (let z = 0; z < Z; z++) {
    summarize(zone.dy[z], f0, f1, v)
    summarize(zone.dx[z], f0, f1, v)
  }

  // Top-versus-bottom mismatch of the frame: a weak addition on its own, but it is already
  // contained in per-zone motion and need not be extracted separately.
  const top: number[] = []
  const bottom: number[] = []
  for (let z = 0; z < Z; z++) {
    const row = (z / zone.grid) | 0
    if (row === 0) top.push(z)
    else if (row === zone.grid - 1) bottom.push(z)
  }
  const mismatch = new Float64Array(zone.frames)
  for (let f = f0; f <= f1; f++) {
    let t = 0
    let b = 0
    for (const z of top) t += zone.dy[z][f]
    for (const z of bottom) b += zone.dy[z][f]
    mismatch[f] = b / bottom.length - t / top.length
  }
  summarize(mismatch, f0, f1, v)

  if (weapon) {
    const wc = Math.round(time * weapon.fps)
    const wr = Math.max(2, Math.round((halfMs / 1000) * weapon.fps))
    const wf0 = Math.max(1, wc - wr)
    const wf1 = Math.min(weapon.frames - 1, wc + wr)
    summarize(weapon.dy, wf0, wf1, v)
    summarize(weapon.dx, wf0, wf1, v)
    shape(weapon.dy, wc, weapon.frames, weapon.fps, v)
    shape(weapon.dx, wc, weapon.frames, weapon.fps, v)
  } else {
    for (let i = 0; i < WEAPON_FEATURE_COUNT; i++) v.push(NaN)
  }

  v.push(audioConfidence)

  if (v.length !== MOTION_FEATURE_NAMES.length) {
    throw new Error(`признаков ${v.length}, имён ${MOTION_FEATURE_NAMES.length}`)
  }
  return Float64Array.from(v)
}

export interface MotionFeaturesResult {
  /** Per candidate: 74 features, or null if the candidate is at the clip edge. */
  features: (Float64Array | null)[]
  zone: ZoneMotion
  weapon: WeaponMotion | null
  band: { y0: number; y1: number } | null
}

/**
 * The full path: two passes over the video and features for each candidate.
 *
 * Exactly two passes, because the weapon band is found from the motion zones, and those are
 * known only after the whole clip has been seen.
 */
export async function extractMotionFeatures(
  source: GrayFrameSource,
  candidates: readonly MotionCandidate[],
  options: { grid?: number; halfMs?: number } = {},
): Promise<MotionFeaturesResult> {
  const grid = options.grid ?? MOTION_PARAMS.grid
  const size = MOTION_PARAMS.frameSize

  const full = await source({ x0: 0, y0: 0, x1: 1, y1: 1 }, size, size)
  const zone = computeZoneMotion(full, grid)

  const band = findGameplayBand(zone)
  let weapon: WeaponMotion | null = null
  if (band) {
    const strip = await source({ x0: 0, y0: band.y0, x1: 1, y1: band.y1 }, MOTION_PARAMS.weaponWidth, MOTION_PARAMS.weaponHeight)
    weapon = computeWeaponMotion(strip, band)
  }

  const features = candidates.map((c) => motionFeaturesAt(zone, weapon, c.time, c.confidence, options.halfMs))
  return { features, zone, weapon, band }
}

/** Logistic regression from models/motionModel.json. */
export interface MotionModel {
  version: number
  params: { grid: number; halfMs: number; candidateThreshold: number; frameSize: number; specN: number }
  features: string[]
  mean: number[]
  scale: number[]
  weights: number[]
  bias: number
}

/**
 * Check that the extractor and the weights talk about the same thing.
 * Without it a shuffled feature order does not throw, it just silently ruins quality.
 */
export function assertMotionModel(model: MotionModel): void {
  if (model.features.length !== MOTION_FEATURE_NAMES.length) {
    throw new Error(`модель ждёт ${model.features.length} признаков, извлекатель даёт ${MOTION_FEATURE_NAMES.length}`)
  }
  for (let i = 0; i < model.features.length; i++) {
    if (model.features[i] !== MOTION_FEATURE_NAMES[i]) {
      throw new Error(`признак ${i}: модель ждёт ${model.features[i]}, извлекатель даёт ${MOTION_FEATURE_NAMES[i]}`)
    }
  }
  if (model.params.grid !== MOTION_PARAMS.grid || model.params.halfMs !== MOTION_PARAMS.halfMs ||
      model.params.frameSize !== MOTION_PARAMS.frameSize || model.params.specN !== MOTION_PARAMS.specN) {
    throw new Error('геометрия модели не совпадает с MOTION_PARAMS')
  }
}

/**
 * "This is an own shot" score: standardisation with the same mean and scale as in training,
 * then logistic regression. NaN (weapon motion not extracted) is replaced by the mean, i.e. a
 * feature value that does not move the score in any direction.
 */
export function scoreMotion(model: MotionModel, features: Float64Array): number {
  let z = model.bias
  for (let k = 0; k < features.length; k++) {
    const raw = features[k]
    const x = Number.isNaN(raw) ? model.mean[k] : raw
    z += model.weights[k] * ((x - model.mean[k]) / model.scale[k])
  }
  return 1 / (1 + Math.exp(-z))
}
