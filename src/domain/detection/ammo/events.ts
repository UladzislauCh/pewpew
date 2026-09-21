/**
 * Ammo reading series -> own shot moments.
 *
 * Ported from `python/ammo/events.py`.
 */
import type { Series } from './reader'

/** A decrement larger than this is not a burst but a read error or an editing cut. */
const MAX_BURST_PER_STEP = 3

/** How far to look for a reserve reading around the transition frame: it is read every other time. */
const RESERVE_LOOKUP_FRAMES = 5

/**
 * How many consecutive reads the reserve value must hold to be considered real.
 *
 * One read is not enough, and that was measured: with it the cue fired on single classifier misses
 * and ate real shots — `ak47` lost 2 of 20, `bizon` 3 of 60, `m249` 2 of 90. On a real weapon
 * switch the new reserve holds all the time the weapon is in hand, so the stability requirement
 * costs nothing.
 */
const RESERVE_HOLD_READS = 3

export interface ShotEvents {
  times: number[]
  reloads: number[]
  /** Decrements discarded as implausible. */
  skipped: number
  /** Transitions identified by the reserve as a WEAPON SWITCH rather than firing. */
  switched: number
}

/**
 * A STABLE reserve reading on one side of the transition frame.
 *
 * `direction` −1 takes reads before the frame, +1 after. A value is returned only if it holds for
 * `RESERVE_HOLD_READS` consecutive reads: a single classifier miss must not look like a weapon switch.
 */
function steadyReserve(reserve: Series, frame: number, direction: -1 | 1): number | null {
  const { frames, values } = reserve
  // The nearest read on the required side.
  let start = -1
  for (let i = 0; i < frames.length; i++) {
    const inside = direction < 0
      ? frames[i] <= frame && frame - frames[i] <= RESERVE_LOOKUP_FRAMES
      : frames[i] >= frame && frames[i] - frame <= RESERVE_LOOKUP_FRAMES
    if (inside) {
      if (direction < 0) start = i
      else { start = i; break }
    }
  }
  if (start < 0) return null

  const value = values[start]
  let held = 0
  for (let i = start; i >= 0 && i < values.length; i += direction) {
    if (values[i] !== value) break
    held++
    if (held >= RESERVE_HOLD_READS) return value
  }
  // At the edge of the series there may not be enough reads — that is no reason to declare a weapon switch.
  return null
}

/**
 * Shots from counter decrements.
 *
 * The moment is placed on the FRAME where the new value is first visible, not midway between
 * frames. The reason is how the game draws a shot: the flash and the counter change land on the
 * SAME frame — checked by pixels on clips m4a4 (frames 101, 104, 107) and xm1014 (frame 50). So the
 * shot happened at the moment that frame shows.
 *
 * The old midpoint pulled events half a frame back. Measured on 323 pairs: the median "label minus
 * event" was +15 ms with half a frame being 16.7 ms — a match to the tenth. The fix raised recall
 * from 73.0 to 76.6, on sparse clips from 51.4 to 64.2.
 *
 * Video cannot be more precise than a frame in principle; audio refines the moment, see align.ts.
 */
export function extractShots(
  series: Series,
  fps: number,
  startTime = 0,
  reserve: Series | null = null,
): ShotEvents {
  const times: number[] = []
  const reloads: number[] = []
  let skipped = 0
  let switched = 0

  const at = (frame: number): number => startTime + frame / fps
  const { values, frames } = series

  for (let i = 1; i < values.length; i++) {
    const step = values[i] - values[i - 1]
    if (step === 0) continue

    if (step > 0) {
      reloads.push(at(frames[i]))
      continue
    }

    // THE RESERVE TELLS FIRING FROM A WEAPON SWITCH — which is indistinguishable from one series
    // in principle. On a shot the reserve stays put; on a weapon switch it changes along with the
    // magazine, because the other gun has its own ammo (on `ssg08`: sniper 9 | 90, pistol 12 | 24).
    //
    // Without this a return 12 -> 9 reads as a decrement of three and is spread into THREE shots
    // within one frame: on `ssg08` that produced clusters 1.49/1.50/1.51 and 3.16/3.17/3.17 against
    // labels 1.00 / 3.03 / 5.35 / 8.12.
    //
    // Measured that the cue stays silent where there is no weapon switch: zero triggers on
    // 62 decrements of the `m4a4`, `xm1014` and `ak47` clips.
    if (reserve && step < 0) {
      const before = steadyReserve(reserve, frames[i - 1], -1)
      const after = steadyReserve(reserve, frames[i], 1)
      if (before !== null && after !== null && before !== after) {
        switched++
        continue
      }
    }

    const drop = -step
    if (drop > MAX_BURST_PER_STEP) {
      skipped++
      continue
    }

    if (drop === 1) {
      times.push(at(frames[i]))
      continue
    }

    // Several shots in one frame interval: spread them evenly over it, ending at the frame where
    // the new value is visible. Video does not know the exact moments.
    const start = at(frames[i - 1])
    const end = at(frames[i])
    for (let k = 0; k < drop; k++) times.push(start + ((end - start) * (k + 1)) / drop)
  }

  times.sort((a, b) => a - b)
  reloads.sort((a, b) => a - b)
  return { times, reloads, skipped, switched }
}
