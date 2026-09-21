/**
 * Identifying the ammo slot among HUD numbers — by BEHAVIOUR, not by position.
 *
 * Why not by position: there are at least three layouts (native HUD, tournament broadcast,
 * cropped framing), and coordinates cannot be a constant.
 *
 * Why not by appearance: health and armour are drawn in the same font at the same size.
 * An earlier attempt in the project's history failed exactly here — it COUNTED CHANGES, and a
 * change looks the same for ammo and for health. Here VALUES are read, and then the difference
 * is obvious:
 *
 *     ammo       drops by exactly 1 per shot, jumps back to the magazine size
 *     health     drops by any amount (5..40), does not return to the maximum
 *     armour     the same
 *     timer      also drops by 1, but EXACTLY once a second
 *
 * The timer is the only real competitor, and it is separated by irregularity: in firing the
 * intervals between decrements are ragged, in a timer they are constant.
 *
 * WHAT WAS TRIED AND REJECTED. Weeding out "jittery" series — those that go up and down by one —
 * looked right: real ammo decreases, and goes up rarely and straight to the magazine size. The
 * measurement said otherwise: 2 clips worse, none better. The target `ssg08` was not fixed (another
 * wrong series gets picked there next), and `r8-revolver` dropped out of coverage.
 *
 * Ported from `python/ammo/identify.py`.
 */
import type { Series } from './reader'

/** Magazine sizes in CS2: from 5 (revolver, shotguns) to 150 (Negev). */
const MIN_MAGAZINE = 5
const MAX_MAGAZINE = 150

/**
 * Share of decrements that must be small (1..3). Not 1.0, because in fast fire several shots
 * fall into one frame interval.
 */
const MIN_SMALL_STEP_RATIO = 0.65

/**
 * How many small decrements there must be IN ABSOLUTE COUNT for a series with a low share of them
 * to still reach the audio check.
 *
 * The small-decrement share protects against health and armour, which drop by any amount. But it
 * also kills the real counter on weapon switches: on `ssg08` the player jumps between a sniper
 * rifle (10) and a pistol (12), the returns produce decrements of 11-12, the share falls to 0.55,
 * and the slot is rejected BEFORE audio gets to look at it — although it is read on 100% of frames.
 *
 * A backbone of five small decrements means the series behaves like ammo at least in places.
 * Let audio decide from there: an own shot always makes a sound, while health and timer
 * decrements do not land on audio candidates.
 */
const MIN_SMALL_DROPS = 5

/** Spread of intervals between decrements below which the series is regular, i.e. a timer. */
const TIMER_REGULARITY = 0.35

export interface SlotScore {
  score: number
  magazine: number | null
  descents: number
  smallStepRatio: number
  intervalSpread: number
  reason: string
  /**
   * The score below the threshold came ONLY from large decrements, while a backbone of small ones exists.
   * Such a slot is let through to the audio check instead of being dropped — see `MIN_SMALL_DROPS`.
   */
  switchLike: boolean
}

const NOTHING = (reason: string, descents = 0): SlotScore => ({
  score: 0,
  magazine: null,
  descents,
  smallStepRatio: 0,
  intervalSpread: 0,
  reason,
  switchLike: false,
})

/** How much the series looks like ammo. 0 — not at all, 1 — confidently it. */
export function scoreSeries(series: Series, fps: number): SlotScore {
  const { values, frames } = series
  if (values.length < 20) return NOTHING('слишком короткий ряд')

  let max = -Infinity
  let min = Infinity
  for (const v of values) {
    if (v > max) max = v
    if (v < min) min = v
  }
  if (max < MIN_MAGAZINE || max > MAX_MAGAZINE) return NOTHING(`диапазон ${min}..${max}`)

  const drops: number[] = []
  const descentFrames: number[] = []
  const ups: number[] = []
  for (let i = 1; i < values.length; i++) {
    const step = values[i] - values[i - 1]
    if (step < 0) {
      drops.push(-step)
      descentFrames.push(frames[i])
    } else if (step > 0) ups.push(values[i])
  }
  if (drops.length < 3) return NOTHING('спусков почти нет')

  const small = drops.filter((d) => d <= 3).length / drops.length

  const gaps: number[] = []
  for (let i = 1; i < descentFrames.length; i++) gaps.push(descentFrames[i] - descentFrames[i - 1])
  let spread = 1
  if (gaps.length >= 3) {
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
    if (mean > 0) {
      const variance = gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length
      spread = Math.sqrt(variance) / mean
    }
  }

  // Reload: a jump up, and to the same value each time. Health has no upward jumps at all, a timer
  // does, but to different values and once per round.
  let magazine: number | null = null
  if (ups.length) {
    const counts = new Map<number, number>()
    for (const v of ups) counts.set(v, (counts.get(v) ?? 0) + 1)
    // In ASCENDING order of value, not order of appearance: on equal frequencies the choice would
    // otherwise depend on which value was seen first, and the Python version (argmax over sorted)
    // gave a different answer. The discrepancy was caught by reconciliation on the sg553 clip:
    // 30 against 19.
    let bestValue = 0
    let bestCount = 0
    for (const v of [...counts.keys()].sort((a, b) => a - b)) {
      const c = counts.get(v) ?? 0
      if (c > bestCount) {
        bestCount = c
        bestValue = v
      }
    }
    if (bestCount >= 2 && bestValue >= MIN_MAGAZINE && bestValue <= MAX_MAGAZINE) magazine = bestValue
  }

  // Timer: drops by one, but regularly, and the step is close to a second.
  const steady = spread < TIMER_REGULARITY && gaps.length >= 5
  const meanGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0
  const nearSecond = steady && meanGap >= 0.7 * fps && meanGap <= 1.4 * fps
  if (nearSecond && magazine === null) {
    return { ...NOTHING('равномерно раз в секунду — таймер', drops.length), smallStepRatio: small, intervalSpread: spread }
  }

  const smallDrops = drops.filter((d) => d <= 3).length
  // Large decrements are a WEAPON SWITCH, not garbage, if there is a backbone of small ones beneath.
  // Such a slot must not be dropped here: on `ssg08` that lost the real counter, read on 100% of
  // frames, and the tournament scoreboard at the top of the frame won. Let audio decide.
  const switchLike = small < MIN_SMALL_STEP_RATIO && smallDrops >= MIN_SMALL_DROPS

  if (small < MIN_SMALL_STEP_RATIO && !switchLike) {
    return {
      ...NOTHING(`спуски крупные (${Math.round(small * 100)}% мелких)`, drops.length),
      smallStepRatio: small,
      intervalSpread: spread,
      magazine,
    }
  }

  let score = 0.45 * small
  score += 0.3 * Math.min(1, spread / TIMER_REGULARITY)
  if (magazine !== null) score += 0.25

  return {
    score,
    magazine,
    descents: drops.length,
    smallStepRatio: small,
    intervalSpread: spread,
    reason: switchLike
      ? `крупные спуски, но ${smallDrops} мелких — на проверку звуком`
      : score >= 0.6
        ? 'похоже на боезапас'
        : 'слабо',
    switchLike,
  }
}
