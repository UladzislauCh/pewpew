/**
 * Parsing an ammo counter reading series: shots, reloads, weapon switches.
 *
 * The series are taken from real clips — they were exactly the cases where the logic
 * broke. Testing this in the browser is expensive (a clip takes seconds to process,
 * the whole set nine minutes), while the logic itself doesn't depend on frames at all.
 */
import { describe, expect, it } from 'vitest'
import { align, estimateOffset } from '../src/domain/detection/ammo/align'
import { extractShots } from '../src/domain/detection/ammo/events'
import { scoreSeries } from '../src/domain/detection/ammo/identify'
import { groupGlyphs, type Glyph } from '../src/domain/detection/ammo/glyphs'
import { despike, stabilize, type Series } from '../src/domain/detection/ammo/reader'

/** A per-frame series from pairs of "value, how many frames it holds". */
function series(runs: [value: number, frames: number][]): Series {
  const frames: number[] = []
  const values: number[] = []
  let frame = 0
  for (const [value, count] of runs) {
    for (let i = 0; i < count; i++) {
      frames.push(frame++)
      values.push(value)
    }
  }
  return { frames, values, readRate: 1 }
}

const FPS = 30

describe('extracting shots from counter readings', () => {
  it('every drop of one is a shot', () => {
    const { times } = extractShots(series([[30, 5], [29, 5], [28, 5], [27, 5]]), FPS)
    expect(times).toHaveLength(3)
  })

  it('the moment is placed on the frame where the new value first appears', () => {
    // The flash and the counter change land on the same frame, so the shot is that
    // frame, not the midpoint between it and the previous one.
    const { times } = extractShots(series([[30, 3], [29, 3]]), FPS)
    expect(times[0]).toBeCloseTo(3 / FPS, 6)
  })

  it('a rise is a reload, not a shot', () => {
    const { times, reloads } = extractShots(series([[3, 5], [2, 5], [30, 5]]), FPS)
    expect(times).toHaveLength(1)
    expect(reloads).toHaveLength(1)
  })

  it('a drop of several units splits into that many shots', () => {
    const { times } = extractShots(series([[30, 5], [27, 5]]), FPS)
    expect(times).toHaveLength(3)
  })

  it('an implausibly large drop is discarded, not counted as a burst', () => {
    const { times, skipped } = extractShots(series([[30, 5], [10, 5]]), FPS)
    expect(times).toHaveLength(0)
    expect(skipped).toBe(1)
  })

  it('switching weapons and back currently reads as a burst — a known defect', () => {
    // The ssg08 case: the player switches to a pistol after nearly every shot. The
    // sniper rifle goes 10-9-8, i.e. two shots, and between them the value jumps to
    // 12 (pistol) and back. The 12 -> 9 return adds three false labels.
    //
    // THE RULE "returning to a level that was left is a weapon switch" WAS WRITTEN
    // AND REJECTED BY MEASUREMENT: 74.5 vs 78.4 recall, and the target ssg08 wasn't
    // fixed. The reason is fundamental: a shotgun reloads ONE SHELL AT A TIME
    // (3-4-5-6-7), so every level becomes one that was "left", and real downward
    // shots through them get swallowed. On xm1014 this dropped the clip from 100%
    // to 10%.
    //
    // A weapon switch can't be told apart from this kind of dip using a single series:
    // for ssg08 the sniper rifle and the pistol differ by 2-3 rounds, exactly like
    // adjacent reload steps of the shotgun. An external signal is needed — a weapon
    // switch sound, or reading the weapon name from the HUD.
    const { times } = extractShots(
      series([[10, 5], [9, 5], [12, 5], [9, 5], [8, 5], [12, 5], [8, 5]]),
      FPS,
    )
    expect(times.length).toBeGreaterThan(2)
  })
})

describe('cleaning the reading series', () => {
  it('the median removes a one-reading outlier', () => {
    const cleaned = despike(series([[9, 1], [1, 1], [9, 1]]))
    expect(cleaned.values).toEqual([9, 9, 9])
  })

  it('stabilization removes a ONE-reading outlier', () => {
    const cleaned = stabilize(series([[10, 5], [12, 1], [10, 5]]))
    expect(new Set(cleaned.values)).toEqual(new Set([10]))
  })

  it('an outlier that held for two readings is NOT removed — and that is intentional', () => {
    // The run length is chosen to be two readings because for the fastest-firing
    // weapon in CS2 a shot takes about two frames: requiring more would mean losing
    // bursts. The price is that outliers of the same length get through.
    //
    // Hence the limit of this cleanup: on ssg08 fleeting 12s held for a couple of
    // frames, and the rule didn't remove them. What helps there isn't cleaning the
    // series, but understanding that 12 is the magazine of a DIFFERENT weapon (see
    // the weapon switch case above).
    const cleaned = stabilize(series([[10, 5], [12, 2], [10, 5]]))
    expect(new Set(cleaned.values)).toEqual(new Set([10, 12]))
  })

  it('stabilization does NOT eat a real fast change', () => {
    // For the fastest-firing weapon, a shot takes about two frames.
    const cleaned = stabilize(series([[30, 4], [29, 2], [28, 2], [27, 4]]))
    expect(extractShots(cleaned, FPS).times).toHaveLength(3)
  })

  it('the change moment is set to the first reading of the stable run', () => {
    const cleaned = stabilize(series([[30, 4], [29, 4]]))
    const { times } = extractShots(cleaned, FPS)
    expect(times[0]).toBeCloseTo(4 / FPS, 6)
  })
})

describe('alignment against audio', () => {
  it('audio CONFIRMS the moment but does not move it', () => {
    // A candidate 40ms from the moment: the label used to snap to it, and that was
    // the source of jitter. The counter knows the frame more precisely than the
    // nearest transient.
    const a = align([1.0, 2.0, 3.0], [1.04, 1.96, 3.03])
    expect(a.times).toEqual([1.0, 2.0, 3.0])
    expect(a.snapped).toBe(3)
    expect(a.kept).toBe(0)
  })

  it('a moment with no nearby candidate stays put and is not confirmed', () => {
    const a = align([1.0, 5.0], [1.02])
    expect(a.times).toEqual([1.0, 5.0])
    expect(a.snapped).toBe(1)
    expect(a.kept).toBe(1)
  })

  it('confirmation is strictly one-to-one — a burst is not confirmed by one transient', () => {
    // Two shots 60ms apart and one candidate between them.
    const a = align([1.0, 1.06], [1.03])
    expect(a.snapped).toBe(1)
    expect(a.times).toEqual([1.0, 1.06])
  })

  it('a clip-wide offset is applied — it helps, and this was measured separately', () => {
    // All moments shifted by 150ms: the offset is found and the labels move AS A
    // WHOLE, preserving distances between them.
    const events = [1.0, 2.0, 3.0, 4.0]
    const candidates = events.map((t) => t + 0.15)
    // The estimator's precision is its own 40ms tolerance, and with an equal number
    // of explained moments it picks the SMALLER offset: otherwise the choice would
    // wander across the plateau.
    const offset = estimateOffset(events, candidates)
    expect(Math.abs(offset - 0.15)).toBeLessThanOrEqual(0.04)
    const a = align(events, candidates)
    expect(a.offset).toBe(offset)
    expect(a.times[1] - a.times[0]).toBeCloseTo(1.0, 6)
  })

  it('an already-aligned clip does not move', () => {
    // The WELL_ALIGNED_RATE rule: for `five_seven` the raw times were accurate to
    // within 17ms, and the estimator used to shift them by 210ms, dropping the clip
    // from 68% to 37%.
    const events = [1.0, 2.0, 3.0, 4.0, 5.0]
    expect(estimateOffset(events, events.map((t) => t + 0.01))).toBe(0)
  })
})

describe('slot selection under a weapon switch', () => {
  const FPS_SLOT = 30

  /** Sniper rifle 10 rounds, pistol 20: returns produce dips of 11-12. */
  function switching(): Series {
    // Shot, jump to pistol, return — round and round: the small-step ratio drops to
    // 0.56 with five small dips, i.e. the magazine's backbone is visible, but the
    // ratio threshold isn't met.
    return series([
      [10, 4], [9, 4], [20, 4], [9, 4], [8, 4], [20, 4], [8, 4],
      [7, 4], [20, 4], [7, 4], [6, 4], [20, 4], [6, 4], [5, 4],
    ])
  }

  it('large drops from a WEAPON SWITCH do not kill the slot, they go to audio verification', () => {
    // This kind of series used to be discarded outright, and on `ssg08` the tournament
    // scoreboard won, while the real counter — readable on 100% of frames — wasn't
    // considered at all.
    const score = scoreSeries(switching(), FPS_SLOT)
    expect(score.smallStepRatio).toBeLessThan(0.65)
    expect(score.switchLike).toBe(true)
    expect(score.score).toBeGreaterThan(0)
  })

  it('large drops WITHOUT a backbone of small ones are still discarded', () => {
    // This is how health behaves: it decreases by any amount and gives almost no small dips.
    const health = series([
      [100, 4], [72, 4], [45, 4], [12, 4], [100, 4], [60, 4], [31, 4],
      [100, 4], [55, 4], [20, 4], [100, 4], [66, 4], [30, 4], [8, 4],
    ])
    const score = scoreSeries(health, FPS_SLOT)
    expect(score.switchLike).toBe(false)
    expect(score.score).toBe(0)
  })
})

describe('ammo reserve distinguishes a weapon switch', () => {
  const FPS_SW = 30

  it('the reserve stays put on a shot — the shot counts', () => {
    const mag = series([[30, 4], [29, 4], [28, 4]])
    const res = series([[90, 12]])
    const e = extractShots(mag, FPS_SW, 0, res)
    expect(e.times).toHaveLength(2)
    expect(e.switched).toBe(0)
  })

  it('a drop with a CHANGED reserve is a weapon switch, not a burst', () => {
    // Return from a pistol (12 | 24) to a sniper rifle (9 | 90): by the magazine
    // series alone this is a dip of three, and it used to split into three shots
    // within a frame. The reserve resolves the ambiguity.
    const mag = series([[12, 4], [9, 4], [8, 4]])
    const res = series([[24, 4], [90, 8]])
    const e = extractShots(mag, FPS_SW, 0, res)
    expect(e.switched).toBe(1)
    expect(e.times).toHaveLength(1)
  })

  it('without a reserve the behavior is unchanged — the signal is not invented', () => {
    const mag = series([[12, 4], [9, 4], [8, 4]])
    expect(extractShots(mag, FPS_SW).times).toHaveLength(4)
    expect(extractShots(mag, FPS_SW).switched).toBe(0)
  })

  it('a shotgun reloads shell by shell while the reserve drops — shots are not lost', () => {
    // 5-6-7 going up by one while the reserve decreases is a reload; followed by real
    // shots with a STEADY reserve. The "return to a level that was left" rule used
    // to break here.
    const mag = series([[5, 3], [6, 3], [7, 3], [6, 3], [5, 3]])
    const res = series([[32, 3], [31, 3], [30, 9]])
    const e = extractShots(mag, FPS_SW, 0, res)
    expect(e.reloads).toHaveLength(2)
    expect(e.times).toHaveLength(2)
    expect(e.switched).toBe(0)
  })
})

describe('grouping glyphs into numbers', () => {
  /** Stub glyph: only the box and height matter for grouping, the mask isn't used. */
  function glyph(x: number, w: number, h = 10, y = 100): Glyph {
    return { x, y, w, h, mask: new Uint8Array(w * h) }
  }

  it('a regular number groups into one chain', () => {
    const groups = groupGlyphs([glyph(0, 5), glyph(6, 5)])
    expect(groups).toHaveLength(1)
    expect(groups[0].glyphs).toHaveLength(2)
  })

  it('glyphs from different rows do not join one chain', () => {
    const groups = groupGlyphs([glyph(0, 5, 10, 100), glyph(6, 5, 10, 140)])
    expect(groups).toHaveLength(2)
  })

  it('a chain longer than three glyphs is discarded — and this is INTENTIONAL', () => {
    // A magazine in CS2 is never longer than three digits (150 max, on the Negev).
    //
    // Splitting such a chain on a wide gap WAS TRIED and rejected by measurement.
    // The idea was tournament HUD layouts, where the separator is a slash: it passes
    // the shape check and merges "9 / 115" into five glyphs. The split added three
    // clips to coverage (19 -> 22), but all three scored WORSE with the counter
    // (`mp7` 15.4 vs 74.6), and on `g3sg1` it produced a spurious slot that won the
    // selection: F1 6.5 -> 4.8. Corpus total 80.7 -> 79.7 with a 1.2x slower pass.
    const chain = [glyph(0, 5), glyph(6, 5), glyph(12, 5), glyph(18, 5)]
    expect(groupGlyphs(chain)).toHaveLength(0)
  })
})
