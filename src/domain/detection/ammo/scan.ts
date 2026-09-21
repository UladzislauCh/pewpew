/**
 * A pass over the clip: where the numbers sit on screen and how they changed.
 *
 * The pass produces "slots". A slot is a stable position of a number on screen: ammo, health,
 * armour, reserve ammo, round timer, score. Identifying the ammo among them is NOT done here —
 * it is in identify.ts and relies on the behaviour of the values, not on position. Position
 * cannot be a constant: there are at least three layouts (native HUD, tournament broadcast,
 * cropped framing).
 *
 * EVERY frame is analysed in full, as in the Python original.
 *
 * The optimisation "analyse only the neighbourhoods of already found places" was written and
 * DISCARDED. It saved four seconds per clip and cost three sources of discrepancy: overlapping
 * neighbourhoods found the same number several times and spawned duplicates (on `ak47` the
 * correct slot with 478 reads lost on score to a phantom with 99), and the "whom to read on each
 * frame" selection lost the real counter (`bizon`: 41% of frames instead of 74%, 35 shots
 * instead of 60). A full analysis costs 6.3 ms per frame — 5.7 s per clip, on par with the
 * motion pass that already runs.
 *
 * The only thing left from that work is buffer reuse: it does not affect the result and removes
 * tens of thousands of memory allocations per clip.
 *
 * The second and last difference from Python: the value is read IMMEDIATELY and stored as a
 * number. Storing glyph masks is not an option — three 20x30 digits over 900 frames and forty
 * slots is tens of megabytes wasted.
 */
import { binarize, findGlyphs, GlyphWorkspace, groupGlyphs, SLOT_MIN_GLYPH_HEIGHT, type Group } from './glyphs'
import {
  despike,
  MAX_NEIGHBOUR_GLYPH_DISTANCE,
  readGroup,
  stabilize,
  type Prototypes,
  type Series,
} from './reader'

/** A slot that flickered in a couple of frames is scenery or an editing caption, not a HUD reading. */
const MIN_LIFE_FRACTION = 0.1
const MIN_LIFE_FRAMES = 8

/**
 * How far to the right of a number its NEIGHBOUR — reserve ammo — is searched, in heights of the number itself.
 *
 * Measured on frames: the reserve is 1.0–1.6 heights away from the magazine. Three leaves margin,
 * but no more: further on come the weapon icon and unrelated captions.
 */
const NEIGHBOUR_SPAN = 3
/** The neighbour is on the same row: centre no higher or lower than this fraction of the height. */
const NEIGHBOUR_ROW = 0.6

interface Slot {
  cx: number
  cy: number
  height: number
  /** Right edge of the number in the last frame — the neighbour is measured from it. */
  right: number
  frames: number[]
  /** The read number, or null if any digit was not recognised. */
  values: (number | null)[]
  /** Frames and values of the right NEIGHBOUR — reserve ammo. Not read on every frame. */
  reserveFrames: number[]
  reserveValues: number[]
}

export interface SlotResult {
  cx: number
  cy: number
  height: number
  /** Share of the clip's frames where the slot was present at all. */
  presence: number
  series: Series
  /**
   * Readings of the right neighbour — reserve ammo. `null` if the neighbour was not read.
   *
   * Needed for an INVARIANT that neither a scoreboard, a timer nor health can fake: on a shot the
   * reserve stays put, on a reload it drops by exactly as much as the magazine jumped.
   */
  reserve: Series | null
}

export interface ScanResult {
  slots: SlotResult[]
  frames: number
  width: number
  height: number
}

function matches(slot: Slot, group: Group): boolean {
  const tol = Math.max(0.6 * slot.height, 6)
  if (Math.abs(group.cy - slot.cy) > tol) return false
  // Horizontal tolerance is wider: the number grows left or right depending on alignment,
  // and the centre shifts by half a digit.
  if (Math.abs(group.cx - slot.cx) > Math.max(1.5 * slot.height, 12)) return false
  return Math.abs(group.bottom - group.y - slot.height) <= 0.35 * slot.height
}

function add(slot: Slot, frame: number, group: Group, value: number | null): void {
  const n = slot.frames.length
  slot.right = group.right
  // Running average of the position: the HUD stays put, but the number's box wanders by a pixel
  // when the digit count changes (16 -> 9), and the anchor must move with it.
  slot.cx = (slot.cx * n + group.cx) / (n + 1)
  slot.cy = (slot.cy * n + group.cy) / (n + 1)
  slot.height = (slot.height * n + (group.bottom - group.y)) / (n + 1)
  slot.frames.push(frame)
  slot.values.push(value)
}

/**
 * An accumulator attached to the same video pass that already runs for motion.
 *
 * Frames arrive at native resolution — that matters: in a 1080p frame the counter is about
 * thirty pixels tall, and in a frame scaled down to 384 only a few are left.
 */
export class AmmoScan {
  private slots: Slot[] = []
  private width = 0
  private height = 0
  private count = 0
  private readonly work = new GlyphWorkspace()
  private readonly prototypes: Prototypes

  constructor(prototypes: Prototypes) {
    this.prototypes = prototypes
  }

  push(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, index: number): void {
    this.width = width
    this.height = height
    this.count = index + 1

    const binary = binarize(rgba, width, { x0: 0, y0: 0, x1: width, y1: height }, this.work)
    const glyphs = findGlyphs(binary, height, this.work)

    // TWO DIFFERENT GROUPINGS, and that is not wasteful.
    //
    // The glyph height floor was lowered for the RESERVE ammo — it is half the size of the
    // magazine. But if the small stuff is let into the common grouping, it gets between the digits
    // of a large number, breaks the chain under the "neighbours of the same size" rule and falls
    // the number apart: that is exactly how "16" once split into "1" and "6". Measured on the
    // corpus: coverage 19 clips -> 17, F1 79.2 -> 61.4.
    //
    // So frame places are built ONLY from large glyphs and come out exactly as before the reserve
    // appeared, while neighbours are found in a separate pass over all of them.
    const floor = SLOT_MIN_GLYPH_HEIGHT * height
    const seeds = groupGlyphs(glyphs.filter((g) => g.h >= floor))
    const groups = groupGlyphs(glyphs)

    // The nearest matching slot, not the first one found, and no more than one group per slot per
    // frame: otherwise neighbouring captions merge into one slot and it gathers more entries than
    // the clip has frames.
    const taken = new Set<number>()
    for (const group of seeds) {
      let best = -1
      let bestDistance = Infinity
      for (let i = 0; i < this.slots.length; i++) {
        if (taken.has(i) || !matches(this.slots[i], group)) continue
        const d = Math.abs(group.cx - this.slots[i].cx) + Math.abs(group.cy - this.slots[i].cy)
        if (d < bestDistance) {
          bestDistance = d
          best = i
        }
      }
      const value = readGroup(this.prototypes, group.glyphs)
      if (best >= 0) {
        add(this.slots[best], index, group, value)
        taken.add(best)
      } else {
        const slot: Slot = {
          cx: group.cx,
          cy: group.cy,
          height: group.bottom - group.y,
          right: group.right,
          frames: [],
          values: [],
          reserveFrames: [],
          reserveValues: [],
        }
        add(slot, index, group, value)
        this.slots.push(slot)
        taken.add(this.slots.length - 1)
      }
    }

    // The right neighbour is reserve ammo. It is searched among ALL groups, including small ones,
    // and read with a relaxed threshold: a small glyph stretched to the prototype cell gets
    // stair-stepped edges and does not give an honest distance.
    for (const i of taken) this.readNeighbour(this.slots[i], groups, index)
  }

  private readNeighbour(slot: Slot, groups: Group[], index: number): void {
    let best: Group | null = null
    for (const group of groups) {
      if (group.x <= slot.right) continue
      if (group.x - slot.right > NEIGHBOUR_SPAN * slot.height) continue
      if (Math.abs(group.cy - slot.cy) > NEIGHBOUR_ROW * slot.height) continue
      if (!best || group.x < best.x) best = group
    }
    if (!best) return
    const value = readGroup(this.prototypes, best.glyphs, MAX_NEIGHBOUR_GLYPH_DISTANCE)
    if (value === null) return
    slot.reserveFrames.push(index)
    slot.reserveValues.push(value)
  }

  result(): ScanResult {
    const minLife = Math.max(MIN_LIFE_FRAMES, Math.floor(MIN_LIFE_FRACTION * this.count))
    const slots: SlotResult[] = []
    for (const slot of this.slots) {
      if (slot.frames.length < minLife) continue
      const frames: number[] = []
      const values: number[] = []
      for (let i = 0; i < slot.frames.length; i++) {
        const v = slot.values[i]
        if (v !== null) {
          frames.push(slot.frames[i])
          values.push(v)
        }
      }
      slots.push({
        cx: slot.cx,
        cy: slot.cy,
        height: slot.height,
        presence: slot.frames.length / Math.max(1, this.count),
        series: stabilize(despike({ frames, values, readRate: frames.length / Math.max(1, slot.frames.length) })),
        // The reserve is cleaned the same way as the magazine: it is read every other time,
        // and single classifier misses are especially frequent here.
        reserve: slot.reserveFrames.length
          ? stabilize(
              despike({
                frames: slot.reserveFrames,
                values: slot.reserveValues,
                readRate: slot.reserveFrames.length / Math.max(1, slot.frames.length),
              }),
            )
          : null,
      })
    }
    slots.sort((a, b) => b.series.frames.length - a.series.frames.length)
    return { slots, frames: this.count, width: this.width, height: this.height }
  }
}
