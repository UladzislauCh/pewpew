/**
 * Reading HUD numbers: glyph -> digit, group -> number, per-frame series -> stable values.
 *
 * The classifier is nearest neighbour over a set of prototypes. Deliberately not a network: the
 * vocabulary is closed (ten symbols), there is one font, and the size is constant within a clip.
 *
 * There are SEVERAL prototypes per digit, and that is not a defect but a consequence of the
 * semi-transparent HUD: the scene moves through the digit, and one symbol comes in several
 * renderings. An earlier attempt in the project's history fought this by clustering into exactly
 * ten groups and failed; here the spread of renderings helps the classifier.
 *
 * Ported from `python/ammo/reader.py`.
 */
import type { Glyph } from './glyphs'

const PROTOTYPES_URL = '/models/ammoPrototypes.json'

export { MAX_NEIGHBOUR_GLYPH_DISTANCE }

/**
 * Share of mismatched pixels above which a glyph is considered not a digit. Cuts out letters of
 * nicknames and banners that happened to pass the shape check.
 */
const MAX_GLYPH_DISTANCE = 0.22

/**
 * The same threshold for SMALL glyphs — reserve ammo.
 *
 * A 7x12 glyph is stretched to a 16x24 cell and gets stair-stepped edges the prototype does not
 * have: the distance grows even though the digit is recognised correctly. On `ssg08` reserve
 * digits give 0.208–0.284, i.e. they are read correctly and rejected by the threshold. With 0.28
 * the reserve is read on 152 frames of 186 instead of 37, and stabilisation brings it to the
 * correct 90 on 78% of frames.
 *
 * TESTED AND REJECTED: comparing a small glyph in a small cell. More frames are accepted, but the
 * WRONG digits are read — 38, 56, 98 instead of 90. Coarsening the cell kills discrimination
 * between similar digits faster than it fixes the edges.
 *
 * The relaxation applies ONLY to reading the neighbour. For the slot's own values the threshold is
 * unchanged: there an error goes straight into shot labels.
 */
const MAX_NEIGHBOUR_GLYPH_DISTANCE = 0.28

export interface Prototypes {
  cellW: number
  cellH: number
  /** Per prototype: a mask of length cellW*cellH, values 0/1. */
  bits: Uint8Array[]
  digits: number[]
}

interface PrototypesJson {
  cell: [number, number]
  prototypes: { digit: number; bits: string }[]
}

export function parsePrototypes(payload: PrototypesJson): Prototypes {
  const [cellW, cellH] = payload.cell
  const bits: Uint8Array[] = []
  const digits: number[] = []
  for (const p of payload.prototypes) {
    if (p.bits.length !== cellW * cellH) {
      throw new Error(`Прототип цифры ${p.digit}: ${p.bits.length} бит вместо ${cellW * cellH}`)
    }
    const mask = new Uint8Array(cellW * cellH)
    for (let i = 0; i < p.bits.length; i++) mask[i] = p.bits.charCodeAt(i) === 49 ? 1 : 0
    bits.push(mask)
    digits.push(p.digit)
  }
  if (!bits.length) throw new Error('Набор прототипов цифр пуст')
  return { cellW, cellH, bits, digits }
}

let prototypesPromise: Promise<Prototypes> | null = null

export function loadPrototypes(url: string = PROTOTYPES_URL): Promise<Prototypes> {
  if (!prototypesPromise) {
    prototypesPromise = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`Не удалось загрузить прототипы цифр: HTTP ${r.status}`)
        return r.json() as Promise<PrototypesJson>
      })
      .then(parsePrototypes)
      .catch((e) => {
        prototypesPromise = null
        throw e
      })
  }
  return prototypesPromise
}

/**
 * Glyph into a fixed box — to compare across frames and across clips.
 *
 * Nearest neighbour, not smoothing: the mask is binary, and half-tones on its edge only blur the
 * difference between similar digits.
 */
export function normalizeGlyph(glyph: Glyph, cellW: number, cellH: number): Uint8Array {
  const out = new Uint8Array(cellW * cellH)
  for (let y = 0; y < cellH; y++) {
    const sy = Math.min(glyph.h - 1, Math.floor((y * glyph.h) / cellH))
    for (let x = 0; x < cellW; x++) {
      const sx = Math.min(glyph.w - 1, Math.floor((x * glyph.w) / cellW))
      out[y * cellW + x] = glyph.mask[sy * glyph.w + sx]
    }
  }
  return out
}

/** The digit of the nearest prototype. −1 if none fits. */
export function classify(prototypes: Prototypes, glyph: Glyph, limit = MAX_GLYPH_DISTANCE): number {
  const sample = normalizeGlyph(glyph, prototypes.cellW, prototypes.cellH)
  const size = sample.length
  let best = -1
  let bestDistance = Infinity
  for (let i = 0; i < prototypes.bits.length; i++) {
    const bits = prototypes.bits[i]
    let diff = 0
    for (let k = 0; k < size; k++) if (bits[k] !== sample[k]) diff++
    if (diff < bestDistance) {
      bestDistance = diff
      best = i
    }
  }
  return bestDistance / size <= limit ? prototypes.digits[best] : -1
}

/** A number from a group of glyphs. null if any glyph is not recognised. */
export function readGroup(prototypes: Prototypes, glyphs: Glyph[], limit = MAX_GLYPH_DISTANCE): number | null {
  let value = 0
  for (const glyph of glyphs) {
    const digit = classify(prototypes, glyph, limit)
    if (digit < 0) return null
    value = value * 10 + digit
  }
  return value
}

/** Readings of one slot over the clip's frames. */
export interface Series {
  frames: number[]
  values: number[]
  /** Share of the slot's frames where the number was read in full. */
  readRate: number
}

/**
 * Median over three neighbouring reads.
 *
 * The scene moves through the semi-transparent HUD, and one frame in a hundred is misread.
 * Outliers look like 18-19-17 or 19-16-19: the value bounces and immediately returns. Each such
 * outlier is an EXTRA decrement and an EXTRA increment, i.e. two false events.
 *
 * A median of three removes a single outlier in either direction and does not distort a monotonic
 * decrease: for 19-18-17 the median is 18. It introduces no thresholds and needs no tuning.
 */
export function despike(series: Series): Series {
  const n = series.values.length
  if (n < 3) return series
  const values = series.values.slice()
  for (let i = 1; i < n - 1; i++) {
    const a = series.values[i - 1]
    const b = series.values[i]
    const c = series.values[i + 1]
    values[i] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c))
  }
  return { frames: series.frames, values, readRate: series.readRate }
}

/**
 * A change counts only if the new value HELD.
 *
 * A median of three removes a one-read outlier, but not a two-read one. And those exist: on the
 * `ssg08` clip fleeting 12, 0 and 6, lasting a couple of frames each, wedged into the series
 * 10-9-8-7-6, and four real shots produced fourteen labels in clusters.
 *
 * The change moment is BACKDATED — to the first read of the stable run, not to where it was
 * confirmed. Otherwise every label would drift one frame forward, and a frame at 30 fps is a
 * third of the metric tolerance.
 *
 * The run length is exactly two reads: the fastest-firing weapon in CS2 gets about two frames per
 * shot, and demanding more would lose bursts.
 */
export function stabilize(series: Series, minRun = 2): Series {
  const n = series.values.length
  if (n < minRun) return series

  const values = series.values.slice()
  let current = series.values[0]
  let runValue = series.values[0]
  let runStart = 0
  let runLength = 1

  for (let i = 1; i < n; i++) {
    const value = series.values[i]
    if (value === runValue) runLength++
    else {
      runValue = value
      runStart = i
      runLength = 1
    }
    if (runLength >= minRun && value !== current) {
      current = value
      for (let k = runStart; k < i; k++) values[k] = value
    }
    values[i] = current
  }

  return { frames: series.frames, values, readRate: series.readRate }
}
