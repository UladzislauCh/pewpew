/**
 * Weapon area shift field.
 *
 * Tested on constructed frames, not on clips: the field's arithmetic doesn't depend
 * on video, while a run over the corpus costs minutes. The cases picked are the ones
 * where block matching breaks silently — a shift without residual, and residual
 * without a shift.
 */
import { describe, expect, it } from 'vitest'
import {
  boxFromBlocks,
  FIELD_H,
  FIELD_W,
  fieldFrame,
  sampleWeaponCrop,
  WeaponFieldWorkspace,
} from '../src/domain/detection/motion/weaponField'

/** A frame with a large non-repeating texture: block matching needs something to latch onto. */
function texture(shiftX = 0, shiftY = 0): Uint8Array {
  const out = new Uint8Array(FIELD_W * FIELD_H)
  for (let y = 0; y < FIELD_H; y++) {
    for (let x = 0; x < FIELD_W; x++) {
      const sx = x - shiftX
      const sy = y - shiftY
      out[y * FIELD_W + x] = (Math.sin(sx * 0.21) * 90 + Math.cos(sy * 0.37) * 90 + 128) & 255
    }
  }
  return out
}

function frames(prev: Uint8Array, cur: Uint8Array): ReturnType<typeof fieldFrame> {
  const ws = new WeaponFieldWorkspace()
  ws.cur.set(prev)
  ws.swap()
  ws.cur.set(cur)
  return fieldFrame(ws)
}

describe('weapon area shift field', () => {
  it('gives nothing on the first frame — nothing to compare against', () => {
    const ws = new WeaponFieldWorkspace()
    ws.cur.set(texture())
    expect(fieldFrame(ws)).toEqual({ diff: 0, resid: 0, spread: 0, residAff: 0, u: 0, v: 0 })
  })

  it('a static image: everything is zero', () => {
    const f = frames(texture(), texture())
    expect(f.diff).toBe(0)
    expect(f.resid).toBe(0)
    expect(f.spread).toBe(0)
    expect(f.u).toBe(0)
    expect(f.v).toBe(0)
  })

  it('a pure shift is found, leaving no residual', () => {
    const f = frames(texture(), texture(2, -1))
    expect(f.u).toBe(2)
    expect(f.v).toBe(-1)
    // The shift explains everything: the residual is an order of magnitude below
    // the uncompensated difference.
    expect(f.resid).toBeLessThan(f.diff / 10)
    // All sub-blocks moved the same way — the field is uniform.
    expect(f.spread).toBe(0)
    expect(f.residAff).toBeCloseTo(0, 10)
  })

  it('parts of the area moving apart produce field spread', () => {
    // Left half stays put, right half moves: exactly how recoil differs from camera
    // panning — the weapon moves differently from the rest of the frame's content.
    const prev = texture()
    const cur = texture()
    const moved = texture(3, 0)
    for (let y = 0; y < FIELD_H; y++) {
      for (let x = FIELD_W >> 1; x < FIELD_W; x++) cur[y * FIELD_W + x] = moved[y * FIELD_W + x]
    }
    const f = frames(prev, cur)
    expect(f.spread).toBeGreaterThan(0.5)
  })

  it('field spread is not confused with a uniform shift', () => {
    const uniform = frames(texture(), texture(3, 2))
    const split = (() => {
      const cur = texture()
      const moved = texture(3, 0)
      for (let y = 0; y < FIELD_H; y++) {
        for (let x = FIELD_W >> 1; x < FIELD_W; x++) cur[y * FIELD_W + x] = moved[y * FIELD_W + x]
      }
      return frames(texture(), cur)
    })()
    expect(uniform.spread).toBeLessThan(split.spread)
  })
})

describe('weapon area sampling', () => {
  it('averages over area rather than taking the nearest pixel', () => {
    // Source is twice the target size, values alternate 0 and 200: averaging gives
    // 100, nearest-neighbor would give 0 or 200.
    const w = FIELD_W * 2
    const h = FIELD_H * 2
    const src = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) src[y * w + x] = x % 2 === 0 ? 0 : 200
    }
    const out = new Uint8Array(FIELD_W * FIELD_H)
    sampleWeaponCrop(src, w, h, { x0: 0, y0: 0, x1: 1, y1: 1 }, out)
    expect(out[0]).toBe(100)
    expect(out[FIELD_W * FIELD_H - 1]).toBe(100)
  })

  it('a degenerate box does not crash sampling', () => {
    const src = new Uint8Array(64 * 64).fill(77)
    const out = new Uint8Array(FIELD_W * FIELD_H)
    sampleWeaponCrop(src, 64, 64, { x0: 0.5, y0: 0.5, x1: 0.5, y1: 0.5 }, out)
    expect(out[0]).toBe(77)
  })
})

describe('box from selected blocks', () => {
  it('covers all blocks and is measured in frame fractions', () => {
    // Blocks 1 and 34 on a 16-grid: columns 1 and 2, rows 0 and 2.
    const box = boxFromBlocks([1, 34], 16)
    expect(box).toEqual({ x0: 1 / 16, y0: 0, x1: 3 / 16, y1: 3 / 16 })
  })

  it('no blocks means no box', () => {
    expect(boxFromBlocks([], 16)).toBeNull()
  })
})
