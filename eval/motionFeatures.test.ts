/**
 * Building the motion feature vector.
 *
 * Checks one thing, but something that already broke: the vector length must match
 * the number of names in BOTH cases — whether weapon motion was captured or not. There
 * used to be a hardcoded 22 here against the actual 16 `weapon.*` features, and the
 * path without a mask crashed. In the reference set every clip has a mask, so no
 * measurement ever caught it, while for a user with a static clip the second stage
 * fell back entirely to the audio-only score.
 */
import { describe, expect, it } from 'vitest'
import {
  MOTION_FEATURE_NAMES,
  computeZoneMotion,
  motionFeaturesAt,
  type GrayFrames,
  type WeaponMotion,
} from '../src/domain/detection/motion/motionFeatures'
import { BLOCK_FRAME, BlockFrames } from '../src/domain/detection/motion/blockMotion'

/** Frames with a crawling gradient: content doesn't matter, only the shape of the result. */
function frames(n: number, w: number, h: number): GrayFrames {
  const data = new Uint8Array(n * w * h)
  for (let f = 0; f < n; f++)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) data[f * w * h + y * w + x] = (x * 3 + y * 5 + f * 2) & 255
  return { data, width: w, height: h, frames: n, fps: 30 }
}

function weaponMotion(n: number): WeaponMotion {
  const dx = new Float64Array(n)
  const dy = new Float64Array(n)
  for (let f = 1; f < n; f++) {
    dy[f] = f % 3 === 0 ? 1 : -1
    dx[f] = f % 5 === 0 ? 2 : 0
  }
  return {
    frames: n,
    fps: 30,
    band: { y0: 0.5, y1: 1 },
    maskPx: 1200,
    maskBox: { x0: 10, x1: 200, y0: 5, y1: 100 },
    dx,
    dy,
  }
}

describe('motionFeaturesAt', () => {
  const zone = computeZoneMotion(frames(120, 96, 96))

  it('gives exactly as many features as names — with weapon motion', () => {
    const v = motionFeaturesAt(zone, weaponMotion(120), 2, 0.7)
    expect(v).not.toBeNull()
    expect(v!.length).toBe(MOTION_FEATURE_NAMES.length)
    expect([...v!].every(Number.isFinite)).toBe(true)
  })

  it('gives the same number of features WITHOUT weapon motion, filled with NaN', () => {
    const v = motionFeaturesAt(zone, null, 2, 0.7)
    expect(v).not.toBeNull()
    expect(v!.length).toBe(MOTION_FEATURE_NAMES.length)

    // NaN sits exactly at the weapon.* positions — a zero there would mean "the weapon
    // didn't move", which is a different claim than "no data".
    const missing = MOTION_FEATURE_NAMES.map((name, i) => (Number.isNaN(v![i]) ? name : null)).filter(Boolean)
    expect(missing).toEqual(MOTION_FEATURE_NAMES.filter((n) => n.startsWith('weapon.')))
  })

  it('returns null where the window degenerates', () => {
    // A candidate past the end of the clip: summaries would be computed over two or
    // three frames and would be misleading.
    expect(motionFeaturesAt(zone, null, 100, 0.7)).toBeNull()
    // And on a clip shorter than the window itself.
    expect(motionFeaturesAt(computeZoneMotion(frames(4, 96, 96)), null, 0.05, 0.7)).toBeNull()
  })
})

/**
 * Regression for a specific bug: the frame buffer was released BEFORE building the
 * weapon motion object, and `frames` came out zero. The window degenerated, all 16
 * `weapon.*` features became NaN, the model substituted their means — and the product
 * path silently fell back to a single camera. There was no crash: NaN is a legitimate
 * value here, meaning "no data".
 */
describe('BlockFrames', () => {
  it('remembers its length after releasing pixels', () => {
    const frames = new BlockFrames()
    for (let i = 0; i < 5; i++) frames.push(new Uint8Array(BLOCK_FRAME * BLOCK_FRAME))
    expect(frames.length).toBe(5)
    frames.releaseFrames()
    expect(frames.length).toBe(5)
  })
})
