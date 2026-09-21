/**
 * Shift field inside the weapon region — what the shipped scheme does not compute.
 *
 * Currently `weaponShiftSeries` searches for ONE shift for the whole region: it tries offsets,
 * sums the cost over blocks and takes the minimum of the sum. Two already computed things go to
 * waste in the process: the minimum for EACH block separately (i.e. the field) and the value of
 * the minimum itself (i.e. the residual — the part of motion the shift failed to explain).
 *
 * Here both are computed, but on a frame sample of its own rather than on 256×256 blocks: the
 * weapon region is taken as the bounding rectangle of the selected blocks and scaled down to
 * 160×80. A measurement on 15 clips with a counter showed the coarsening does not hurt but helps
 * (median 0.885 against 0.871 for 320×160 at a tenth of the cost): on a fine grid the per-block
 * estimate is noisy, and the noise eats the signal.
 *
 * WHAT IS DELIBERATELY NOT HERE. Divergence and curl — "the weapon moves into the player along an
 * arc" — were tested twice, at two resolutions, with and without sub-pixel: AUC 0.556 and 0.511,
 * i.e. a coin toss. Series relative to scene motion were tested and add almost nothing (0.885
 * against 0.878 by median, worse by mean), while dragging in a dependency on the zone model.
 * Details in the journal.
 */

/** Region sample size. The coarsening was tested by measurement and is beneficial, see the header. */
export const FIELD_W = 160
export const FIELD_H = 80
/** Field sub-block grid. */
export const FIELD_GRID_X = 6
export const FIELD_GRID_Y = 3
/** Sub-block shift search limit, in sample pixels. */
export const FIELD_MAX_SHIFT = 5

const BLOCKS = FIELD_GRID_X * FIELD_GRID_Y
const SPAN = 2 * FIELD_MAX_SHIFT + 1
const SHIFTS = SPAN * SPAN

/** Per-frame series. Names match the Python exploration (`python/tools/field_series.py`). */
export interface FieldSeries {
  /** Frame difference inside the region without shift compensation. */
  diff: Float64Array
  /** Residual after the best OVERALL shift of the region. */
  resid: Float64Array
  /** Spread of the field across sub-blocks: how much parts of the region move apart. */
  spread: Float64Array
  /** Field residual after removing the affine model: what neither shift nor scale explains. */
  residAff: Float64Array
  /** Mean horizontal and vertical shift of the region. */
  u: Float64Array
  v: Float64Array
}

export const FIELD_SERIES_NAMES = ['diff', 'resid', 'spread', 'residAff', 'u', 'v'] as const
export type FieldSeriesName = (typeof FIELD_SERIES_NAMES)[number]

export interface WeaponBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * Affine fit matrix for the field: columns "one, cx, cy" over sub-block centres.
 * The pseudo-inverse is computed once — the grid is fixed.
 */
function affinePseudoInverse(): Float64Array {
  const design = new Float64Array(BLOCKS * 3)
  for (let b = 0; b < BLOCKS; b++) {
    const gx = b % FIELD_GRID_X
    const gy = (b / FIELD_GRID_X) | 0
    design[b * 3] = 1
    design[b * 3 + 1] = ((gx + 0.5) / FIELD_GRID_X) * 2 - 1
    design[b * 3 + 2] = ((gy + 0.5) / FIELD_GRID_Y) * 2 - 1
  }
  // (XᵀX)⁻¹Xᵀ for three columns: a 3×3 matrix is inverted by Gaussian elimination without
  // pivoting — it is diagonally dominant by construction of the grid.
  const xtx = new Float64Array(9)
  for (let b = 0; b < BLOCKS; b++) {
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) xtx[i * 3 + j] += design[b * 3 + i] * design[b * 3 + j]
    }
  }
  const inv = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1])
  for (let c = 0; c < 3; c++) {
    const pivot = xtx[c * 3 + c]
    for (let j = 0; j < 3; j++) {
      xtx[c * 3 + j] /= pivot
      inv[c * 3 + j] /= pivot
    }
    for (let r = 0; r < 3; r++) {
      if (r === c) continue
      const factor = xtx[r * 3 + c]
      for (let j = 0; j < 3; j++) {
        xtx[r * 3 + j] -= factor * xtx[c * 3 + j]
        inv[r * 3 + j] -= factor * inv[c * 3 + j]
      }
    }
  }
  const pinv = new Float64Array(3 * BLOCKS)
  for (let i = 0; i < 3; i++) {
    for (let b = 0; b < BLOCKS; b++) {
      let acc = 0
      for (let k = 0; k < 3; k++) acc += inv[i * 3 + k] * design[b * 3 + k]
      pinv[i * BLOCKS + b] = acc
    }
  }
  return pinv
}

const PINV = affinePseudoInverse()

/** Reusable buffers: there are many frames, and allocating per frame is not an option. */
export class WeaponFieldWorkspace {
  readonly prev = new Uint8Array(FIELD_W * FIELD_H)
  readonly cur = new Uint8Array(FIELD_W * FIELD_H)
  readonly cost = new Float64Array(SHIFTS * BLOCKS)
  readonly bu = new Float64Array(BLOCKS)
  readonly bv = new Float64Array(BLOCKS)
  hasPrev = false

  swap(): void {
    // The current frame becomes the previous one: by copying, not by swapping references,
    // so the class fields stay readonly and do not get mixed up.
    this.prev.set(this.cur)
    this.hasPrev = true
  }
}

/**
 * Sampling the weapon region into a 160×80 grey field by AREA AVERAGING.
 *
 * The source is the 256×256 frame the video pass keeps for the blocks anyway. A native frame
 * cannot be here: the weapon region becomes known only AFTER the pass, when the classifier has
 * analysed the blocks, and by then native frames are already released. A second pass for
 * resolution is not needed — measured, via 256×256 the features work no worse, slightly better
 * (median 0.891 against 0.878 with a field from the native frame).
 *
 * Averaging, not nearest neighbour as in `sampleGrayFrame`: it is done that way there because
 * the motion model was trained on such pixels. That constraint does not carry over here —
 * these are new series, and their weights are trained from scratch.
 */
export function sampleWeaponCrop(
  gray: Uint8Array,
  width: number,
  height: number,
  box: WeaponBox,
  out: Uint8Array,
): void {
  const x0 = Math.max(0, Math.min(width - 1, Math.round(box.x0 * width)))
  const x1 = Math.max(x0 + 1, Math.min(width, Math.round(box.x1 * width)))
  const y0 = Math.max(0, Math.min(height - 1, Math.round(box.y0 * height)))
  const y1 = Math.max(y0 + 1, Math.min(height, Math.round(box.y1 * height)))
  const cw = x1 - x0
  const ch = y1 - y0

  for (let oy = 0; oy < FIELD_H; oy++) {
    const sy0 = y0 + ((oy * ch) / FIELD_H) | 0
    const sy1 = Math.max(sy0 + 1, y0 + (((oy + 1) * ch) / FIELD_H) | 0)
    for (let ox = 0; ox < FIELD_W; ox++) {
      const sx0 = x0 + ((ox * cw) / FIELD_W) | 0
      const sx1 = Math.max(sx0 + 1, x0 + (((ox + 1) * cw) / FIELD_W) | 0)
      let acc = 0
      let n = 0
      for (let sy = sy0; sy < sy1; sy++) {
        let p = sy * width + sx0
        for (let sx = sx0; sx < sx1; sx++, p++) {
          acc += gray[p]
          n++
        }
      }
      out[oy * FIELD_W + ox] = n ? (acc / n + 0.5) | 0 : 0
    }
  }
}

export interface FieldFrame {
  diff: number
  resid: number
  spread: number
  residAff: number
  u: number
  v: number
}

const ZERO_FRAME: FieldFrame = { diff: 0, resid: 0, spread: 0, residAff: 0, u: 0, v: 0 }

/**
 * One pair of frames: the per-sub-block shift field and summaries from it.
 *
 * The per-block minimum comes for free: the same costs are already iterated for the overall
 * shift, the only difference is that the minimum is taken per block rather than over their sum.
 */
export function fieldFrame(ws: WeaponFieldWorkspace): FieldFrame {
  if (!ws.hasPrev) return ZERO_FRAME
  const { prev, cur, cost, bu, bv } = ws
  const s = FIELD_MAX_SHIFT
  const vw = FIELD_W - 2 * s
  const vh = FIELD_H - 2 * s
  const bw = (vw / FIELD_GRID_X) | 0
  const bh = (vh / FIELD_GRID_Y) | 0
  const per = bw * bh

  cost.fill(0)
  for (let dy = -s, k = 0; dy <= s; dy++) {
    for (let dx = -s; dx <= s; dx++, k++) {
      const base = k * BLOCKS
      for (let gy = 0; gy < FIELD_GRID_Y; gy++) {
        for (let gx = 0; gx < FIELD_GRID_X; gx++) {
          let acc = 0
          for (let y = 0; y < bh; y++) {
            const py = s + gy * bh + y
            let p = py * FIELD_W + s + gx * bw
            let q = (py + dy) * FIELD_W + s + gx * bw + dx
            for (let x = 0; x < bw; x++, p++, q++) {
              const d = prev[p] - cur[q]
              acc += d < 0 ? -d : d
            }
          }
          cost[base + gy * FIELD_GRID_X + gx] = acc / per
        }
      }
    }
  }

  let bestTotal = Infinity
  let bestShift = 0
  for (let k = 0; k < SHIFTS; k++) {
    let total = 0
    for (let b = 0; b < BLOCKS; b++) total += cost[k * BLOCKS + b]
    if (total < bestTotal) {
      bestTotal = total
      bestShift = k
    }
  }
  const zero = (s * SPAN + s) * BLOCKS

  let diff = 0
  let su = 0
  let sv = 0
  for (let b = 0; b < BLOCKS; b++) {
    diff += cost[zero + b]
    let best = Infinity
    let at = 0
    for (let k = 0; k < SHIFTS; k++) {
      const c = cost[k * BLOCKS + b]
      if (c < best) {
        best = c
        at = k
      }
    }
    bu[b] = (at % SPAN) - s
    bv[b] = ((at / SPAN) | 0) - s
    su += bu[b]
    sv += bv[b]
  }
  const mu = su / BLOCKS
  const mv = sv / BLOCKS

  let spread = 0
  for (let b = 0; b < BLOCKS; b++) spread += Math.hypot(bu[b] - mu, bv[b] - mv)

  const coef = new Float64Array(6)
  for (let i = 0; i < 3; i++) {
    let au = 0
    let av = 0
    for (let b = 0; b < BLOCKS; b++) {
      au += PINV[i * BLOCKS + b] * bu[b]
      av += PINV[i * BLOCKS + b] * bv[b]
    }
    coef[i] = au
    coef[3 + i] = av
  }
  let residAff = 0
  for (let b = 0; b < BLOCKS; b++) {
    const gx = ((b % FIELD_GRID_X) + 0.5) / FIELD_GRID_X * 2 - 1
    const gy = (((b / FIELD_GRID_X) | 0) + 0.5) / FIELD_GRID_Y * 2 - 1
    const fu = coef[0] + coef[1] * gx + coef[2] * gy
    const fv = coef[3] + coef[4] * gx + coef[5] * gy
    residAff += Math.hypot(bu[b] - fu, bv[b] - fv)
  }

  return {
    diff: diff / BLOCKS,
    resid: bestTotal / BLOCKS,
    spread: spread / BLOCKS,
    residAff: residAff / BLOCKS,
    u: (bestShift % SPAN) - s,
    v: ((bestShift / SPAN) | 0) - s,
  }
}

/** Accumulator of per-frame series. */
export class WeaponFieldAccumulator {
  private readonly rows: FieldFrame[] = []
  readonly workspace = new WeaponFieldWorkspace()

  push(frame: FieldFrame): void {
    this.rows.push(frame)
  }

  get length(): number {
    return this.rows.length
  }

  series(): FieldSeries {
    const n = this.rows.length
    const out: FieldSeries = {
      diff: new Float64Array(n),
      resid: new Float64Array(n),
      spread: new Float64Array(n),
      residAff: new Float64Array(n),
      u: new Float64Array(n),
      v: new Float64Array(n),
    }
    for (let i = 0; i < n; i++) {
      const r = this.rows[i]
      out.diff[i] = r.diff
      out.resid[i] = r.resid
      out.spread[i] = r.spread
      out.residAff[i] = r.residAff
      out.u[i] = r.u
      out.v[i] = r.v
    }
    return out
  }
}

/** Bounding rectangle of the selected blocks, as fractions of the frame. */
export function boxFromBlocks(blocks: readonly number[], grid: number): WeaponBox | null {
  if (!blocks.length) return null
  let x0 = 1
  let y0 = 1
  let x1 = 0
  let y1 = 0
  for (const b of blocks) {
    const bx = (b % grid) / grid
    const by = ((b / grid) | 0) / grid
    x0 = Math.min(x0, bx)
    y0 = Math.min(y0, by)
    x1 = Math.max(x1, bx + 1 / grid)
    y1 = Math.max(y1, by + 1 / grid)
  }
  return { x0, y0, x1, y1 }
}
