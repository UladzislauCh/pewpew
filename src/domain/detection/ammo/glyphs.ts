/**
 * Extracting HUD glyphs from a frame: bright connected blobs that look like a digit, joined
 * into horizontal numbers ("16", "90", "100").
 *
 * On the threshold. The CS2 HUD is semi-transparent, the moving scene shows through it, so
 * comparing brightness works poorly while comparing binary masks works well. The threshold is
 * high: digits are clearly brighter than the scene, and it cuts the scene out entirely.
 *
 * On the CHANNEL. The threshold is applied to the max of R, G, B, not to Rec.601 luma. The reason
 * was measured: at low ammo CS2 paints the counter orange, and near the end red, and red ink has a
 * Rec.601 luma of 155 against a threshold of 190 — i.e. the digits vanish ENTIRELY. Measured on
 * the `kyousuke` clip, frame 500: 0 pixels above threshold by luma, 147 by channel max. For white
 * digits there is no difference (276 against 280).
 *
 * The colour depends on the MAGAZINE REMAINDER, not on whether a burst is in progress: a
 * three-round burst from a full magazine is drawn white from start to finish.
 *
 * Ported from `python/ammo/glyphs.py`. Same numbers and rules.
 */

/** Binarisation threshold on the channel max. */
export const BINARY_THRESHOLD = 190

/**
 * Bounds of "looks like a digit", as fractions of the frame height.
 *
 * The lower bound was lowered from 0.010 to 0.006 for the RESERVE ammo — the number to the right
 * of the magazine. It is drawn half as large: 11–15 px against 24–37 px for the magazine, and the
 * old threshold cut it right at the edge. Measured: detection of the right-hand group rose from
 * 22% of frames to 38%.
 *
 * Small glyphs do NOT spawn slots — that is what `SLOT_MIN_GLYPH_HEIGHT` is for. Otherwise the
 * number of candidate places doubles, and the project has already hit exactly that: slot growth
 * hung the tab.
 */
const MIN_GLYPH_HEIGHT = 0.006
const MAX_GLYPH_HEIGHT = 0.06

/**
 * Below this height a glyph is only good as a NEIGHBOUR of an already found number, not as a
 * separate place in the frame. This is the old common threshold: slots are gathered exactly as before.
 */
export const SLOT_MIN_GLYPH_HEIGHT = 0.01

/** A digit is taller than wide, but not infinitely: "1" is narrow, "0" is wide. */
const MIN_ASPECT = 0.15
const MAX_ASPECT = 1.3

/** Share of filled pixels inside the box. A solid rectangle is not a digit. */
const MIN_FILL = 0.15
const MAX_FILL = 0.92

/** One bright blob that passed the "looks like a digit" check. */
export interface Glyph {
  x: number
  y: number
  w: number
  h: number
  /** Binary mask inside the box, length w*h, values 0/1. */
  mask: Uint8Array
}

/** A horizontal group of glyphs — one number on screen. */
export interface Group {
  glyphs: Glyph[]
  x: number
  y: number
  right: number
  bottom: number
  cx: number
  cy: number
}

export const glyphCx = (g: Glyph): number => g.x + g.w / 2
export const glyphCy = (g: Glyph): number => g.y + g.h / 2

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * Reusable parsing buffers.
 *
 * Without them every rectangle on every frame allocated three typed arrays, and a clip gathers
 * tens of thousands of rectangles. The allocation itself and the garbage collection after it
 * turned out to be the main cost of parsing, not the computation.
 */
export class GlyphWorkspace {
  binary = new Uint8Array(0)
  labels = new Int32Array(0)
  stack = new Int32Array(0)

  reserve(size: number): void {
    if (this.binary.length < size) {
      this.binary = new Uint8Array(size)
      this.labels = new Int32Array(size)
      this.stack = new Int32Array(size)
    }
  }
}

/**
 * Mask of bright pixels inside a frame rectangle.
 *
 * Channel max, not luma — see the module header. The rectangle exists so that on most frames only
 * already found places are parsed rather than the whole frame: a full parse of a 1280x720 frame in
 * the browser is too expensive to do 900 times.
 */
export function binarize(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  rect: Rect,
  work: GlyphWorkspace,
  threshold: number = BINARY_THRESHOLD,
): { data: Uint8Array; w: number; h: number } {
  const w = rect.x1 - rect.x0
  const h = rect.y1 - rect.y0
  work.reserve(w * h)
  const data = work.binary
  data.fill(0, 0, w * h)
  for (let y = 0; y < h; y++) {
    let src = ((rect.y0 + y) * width + rect.x0) * 4
    let dst = y * w
    for (let x = 0; x < w; x++, src += 4, dst++) {
      const r = rgba[src]
      const g = rgba[src + 1]
      const b = rgba[src + 2]
      const ink = r > g ? (r > b ? r : b) : g > b ? g : b
      if (ink >= threshold) data[dst] = 1
    }
  }
  return { data, w, h }
}

/**
 * Eight-connected components of a binary mask, filtered by digit shape.
 *
 * Breadth-first traversal with our own stack: recursion on a blob of thousands of pixels
 * overflows the stack, and such blobs do occur — e.g. a sky overexposed above the threshold.
 *
 * `frameHeight` is the height of the WHOLE frame, not the rectangle: digit size bounds are given
 * as fractions of the frame and must not change when parsing a piece.
 */
export function findGlyphs(
  binary: { data: Uint8Array; w: number; h: number },
  frameHeight: number,
  work: GlyphWorkspace,
  offsetX = 0,
  offsetY = 0,
): Glyph[] {
  const { data, w, h } = binary
  const size = w * h
  const minH = MIN_GLYPH_HEIGHT * frameHeight
  const maxH = MAX_GLYPH_HEIGHT * frameHeight

  // Component labels, not a pixel list. A list would grow to hundreds of thousands of elements
  // on one bright blob like an overexposed sky — and frames have plenty of those.
  const labels = work.labels
  const stack = work.stack
  labels.fill(0, 0, size)
  const out: Glyph[] = []
  let label = 0

  for (let start = 0; start < size; start++) {
    if (!data[start] || labels[start]) continue

    label++
    let top = 0
    stack[top++] = start
    labels[start] = label
    let area = 0
    let minX = w
    let maxX = -1
    let minY = h
    let maxY = -1

    while (top > 0) {
      const p = stack[--top]
      area++
      const px = p % w
      const py = (p - px) / w
      if (px < minX) minX = px
      if (px > maxX) maxX = px
      if (py < minY) minY = py
      if (py > maxY) maxY = py

      const y0 = py > 0 ? py - 1 : 0
      const y1 = py + 1 < h ? py + 1 : h - 1
      const x0 = px > 0 ? px - 1 : 0
      const x1 = px + 1 < w ? px + 1 : w - 1
      for (let ny = y0; ny <= y1; ny++) {
        const row = ny * w
        for (let nx = x0; nx <= x1; nx++) {
          const q = row + nx
          if (data[q] && !labels[q]) {
            labels[q] = label
            stack[top++] = q
          }
        }
      }
    }

    const gw = maxX - minX + 1
    const gh = maxY - minY + 1
    if (gh < minH || gh > maxH) continue
    const aspect = gw / gh
    if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) continue
    const fill = area / (gw * gh)
    if (fill < MIN_FILL || fill > MAX_FILL) continue

    const mask = new Uint8Array(gw * gh)
    for (let y = 0; y < gh; y++) {
      const src = (minY + y) * w + minX
      const dst = y * gw
      for (let x = 0; x < gw; x++) if (labels[src + x] === label) mask[dst + x] = 1
    }
    out.push({ x: minX + offsetX, y: minY + offsetY, w: gw, h: gh, mask })
  }

  return out
}

function makeGroup(glyphs: Glyph[]): Group {
  let x = Infinity
  let y = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const g of glyphs) {
    if (g.x < x) x = g.x
    if (g.y < y) y = g.y
    if (g.x + g.w > right) right = g.x + g.w
    if (g.y + g.h > bottom) bottom = g.y + g.h
  }
  return { glyphs, x, y, right, bottom, cx: (x + right) / 2, cy: (y + bottom) / 2 }
}

/**
 * Joining glyphs into numbers.
 *
 * Rows first, then adjacency within a row. Sorting straight by (cy, x) is wrong: centres of
 * neighbouring digits of one number differ by fractions of a pixel, and anything at the same
 * height at the other end of the frame wedges between them in traversal order. That is exactly
 * how "16" fell apart into "1" and "6".
 */
export function groupGlyphs(glyphs: Glyph[], maxDigits = 3): Group[] {
  if (!glyphs.length) return []

  const rows: Glyph[][] = []
  for (const glyph of [...glyphs].sort((a, b) => glyphCy(a) - glyphCy(b))) {
    let placed = false
    for (const row of rows) {
      const ref = row[row.length - 1]
      if (Math.abs(glyphCy(glyph) - glyphCy(ref)) <= 0.4 * Math.max(glyph.h, ref.h)) {
        row.push(glyph)
        placed = true
        break
      }
    }
    if (!placed) rows.push([glyph])
  }

  const groups: Glyph[][] = []
  for (const row of rows) {
    const ordered = [...row].sort((a, b) => a.x - b.x)
    let current: Glyph[] = [ordered[0]]
    for (const glyph of ordered.slice(1)) {
      const prev = current[current.length - 1]
      const sameSize = Math.abs(glyph.h - prev.h) <= 0.3 * Math.max(glyph.h, prev.h)
      const gap = glyph.x - (prev.x + prev.w)
      const close = gap >= -0.2 * prev.h && gap <= 0.85 * Math.max(glyph.h, prev.h)
      if (sameSize && close) current.push(glyph)
      else {
        groups.push(current)
        current = [glyph]
      }
    }
    groups.push(current)
  }

  return groups.filter((g) => g.length >= 1 && g.length <= maxDigits).map(makeGroup)
}
