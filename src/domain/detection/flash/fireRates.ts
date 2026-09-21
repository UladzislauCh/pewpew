/**
 * CS2 weapon fire rates and fitting a burst to their rhythm.
 *
 * WHY. The flash says "the player is firing here", but not HOW MANY times: in a burst the model
 * burns continuously over many frames, and the curve does not dip between shots (tested — merging
 * hot frames into events drops recall from 63 to 50). But the fire rate is set by the weapon and
 * is constant. So shots inside a burst can be placed on a grid with a step equal to the weapon period.
 *
 * This gives two things at once:
 *   - an extra label that does not land on a grid node is discarded;
 *   - a missed shot whose flash no frame caught is filled in.
 */

/** Rounds per minute, by weapon. Duplicates removed — the period matters, not the name. */
export const FIRE_RATES_RPM = [
  857, // P90, MP9
  800, // MAC-10, Negev
  750, // PP-Bizon, MP7, MP5-SD, M249
  666, // FAMAS, Galil, M4A4, AUG, SG 553, UMP-45
  600, // AK-47, M4A1-S, CZ75-Auto
  500, // Dual Berettas, Tec-9
  400, // Five-SeveN, P250
  352, // USP-S, P2000, Glock-18
  267, // Desert Eagle
  240, // SCAR-20, G3SG1
  48, // SSG 08
  41, // AWP
] as const

/** Periods in seconds, from slow to fast: the search goes from coarse grid to fine. */
export const FIRE_PERIODS_S = FIRE_RATES_RPM.map((rpm) => 60 / rpm).sort((a, b) => b - a)

/** The fastest rate in the game — 857 rounds per minute, i.e. 70 ms. */
export const FASTEST_PERIOD_S = 60 / Math.max(...FIRE_RATES_RPM)

/**
 * Fitting tolerance, in seconds.
 *
 * The label moment comes from audio, which places it to within one step of its grid (11.6 ms)
 * plus its own peak error. 25 ms is half the metric tolerance: it cannot be wider, otherwise
 * anything fits a fine-step grid.
 */
export const FIT_TOLERANCE_S = 0.025

/** The gap at which firing is split into bursts. Longer than the slowest automatic weapon. */
export const BURST_GAP_S = 0.4

export interface Rhythm {
  /** Period of the found grid, seconds. */
  period: number
  /** Phase: time of any grid node. */
  phase: number
}

/**
 * Fit the burst rate to the moments.
 *
 * The search goes FROM COARSE GRID TO FINE and takes the first that fits. The order is not
 * accidental: anything fits a fine grid (a 70 ms step explains any two moments), and a search for
 * "the best by residual" would always pick the most frequent. A coarse grid is a stronger claim,
 * and if it explains the moments, it is the one to believe.
 */
export function fitRhythm(times: number[], tolerance = FIT_TOLERANCE_S): Rhythm | null {
  if (times.length < 3) return null
  const sorted = [...times].sort((a, b) => a - b)
  const span = sorted[sorted.length - 1] - sorted[0]

  for (const period of FIRE_PERIODS_S) {
    // The grid must cover the burst: a period longer than the burst itself explains nothing.
    if (period > span) continue
    // The phase is a circular mean: moments modulo the period are angles, and the ordinary mean
    // lies at the wrap-around (0.001 and 0.099 with period 0.1 give the middle instead of the edge).
    let sx = 0
    let sy = 0
    for (const t of sorted) {
      const angle = (2 * Math.PI * (t % period)) / period
      sx += Math.cos(angle)
      sy += Math.sin(angle)
    }
    const phase = (((Math.atan2(sy, sx) / (2 * Math.PI)) * period) + period) % period

    let worst = 0
    for (const t of sorted) {
      const k = Math.round((t - phase) / period)
      worst = Math.max(worst, Math.abs(t - (phase + k * period)))
    }
    if (worst <= tolerance) return { period, phase }
  }
  return null
}

/** Index of the grid node a moment falls into. */
export function slotOf(time: number, rhythm: Rhythm): number {
  return Math.round((time - rhythm.phase) / rhythm.period)
}

/** Time of a grid node. */
export function slotTime(slot: number, rhythm: Rhythm): number {
  return rhythm.phase + slot * rhythm.period
}

/**
 * Weapon period over the WHOLE clip, from the gaps inside bursts.
 *
 * Why separately from `fitRhythm`: a short two-label burst does not determine the rate (two
 * moments fit any grid), and such bursts are the majority in a clip. But there is usually one
 * weapon within a clip, and long bursts set its period for the short ones.
 *
 * Only gaps INSIDE bursts are counted: the pause between bursts has nothing to do with the rate.
 * The phase is not searched here — each burst has its own, the player presses anew.
 *
 * The search goes from coarse period to fine and takes the first that explains most gaps. The
 * order matters: anything fits a fine grid.
 */
export function fitClipPeriod(times: number[], tolerance = FIT_TOLERANCE_S): number | null {
  const sorted = [...times].sort((a, b) => a - b)
  const gaps: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1]
    if (gap <= BURST_GAP_S) gaps.push(gap)
  }
  if (gaps.length < 3) return null

  for (const period of FIRE_PERIODS_S) {
    let fit = 0
    for (const gap of gaps) {
      const k = Math.round(gap / period)
      // k = 0 means the gap is under half a period: such a pair cannot happen with this weapon,
      // and it votes AGAINST this period.
      if (k >= 1 && Math.abs(gap - k * period) <= tolerance) fit++
    }
    if (fit >= Math.ceil(0.6 * gaps.length)) return period
  }
  return null
}

/** Phase of a grid with a known period, as a circular mean over the burst's moments. */
export function phaseFor(times: number[], period: number): number {
  let sx = 0
  let sy = 0
  for (const t of times) {
    const angle = (2 * Math.PI * (t % period)) / period
    sx += Math.cos(angle)
    sy += Math.sin(angle)
  }
  return ((((Math.atan2(sy, sx) / (2 * Math.PI)) * period) % period) + period) % period
}
