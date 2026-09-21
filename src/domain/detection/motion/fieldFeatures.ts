/**
 * Weapon field features around one candidate.
 *
 * One implementation for eval and production — deliberately. In `eval/legacy/exportMotionModel.mjs`
 * the feature formulas were duplicated as a copy, and any divergence from production would silently
 * devalue the weights; here that door is closed.
 *
 * VALUES ARE TAKEN RAW, without normalisation. That is not an omission but a measurement: the series
 * must NOT be normalised over the candidate's neighbourhood, because the ring around it in a
 * firefight contains OTHER shots — the background rises exactly where the shot is, and the z-score
 * suppresses what we are looking for. On the `diff` series: raw 0.794, per-clip normalisation 0.694,
 * per-neighbourhood 0.572. The harm is monotonic in locality.
 *
 * A WINDOW, NOT A FRAME. A single-frame value is weaker: viewmodel recoil lasts 3-4 frames, and the
 * shape of the process is what decides. The difference was measured — 0.768 against 0.777 for the
 * window on one series, and much more on the full set.
 */
import type { FieldSeries, FieldSeriesName } from './weaponField'
import { FIELD_SERIES_NAMES } from './weaponField'

/** Offsets from the candidate frame, in frames. */
export const FIELD_LAGS = [-3, -2, -1, 0, 1, 2, 3] as const

const ZERO_INDEX = FIELD_LAGS.indexOf(0)
const DECAY_INDEX = FIELD_LAGS.indexOf(2)

/** Per-series feature names, in the same order `windowFeatures` computes them. */
export const FIELD_TAIL_NAMES = ['rise', 'decay', 'overMin', 'postPre'] as const

/** The full list of field feature names — for debugging and weight tables. */
export const FIELD_FEATURE_NAMES: readonly string[] = FIELD_SERIES_NAMES.flatMap((name) => [
  ...FIELD_LAGS.map((lag) => `${name}.l${lag}`),
  ...FIELD_TAIL_NAMES.map((tail) => `${name}.${tail}`),
])

/** Features per series. */
export const PER_SERIES = FIELD_LAGS.length + FIELD_TAIL_NAMES.length

function windowFeatures(series: Float64Array, frame: number, out: number[]): void {
  const n = series.length
  let min = Infinity
  let preMax = -Infinity
  let postMax = -Infinity
  const vals: number[] = []
  for (let i = 0; i < FIELD_LAGS.length; i++) {
    const idx = Math.min(n - 1, Math.max(0, frame + FIELD_LAGS[i]))
    const value = series[idx]
    vals.push(value)
    if (value < min) min = value
    if (i < ZERO_INDEX && value > preMax) preMax = value
    if (i > ZERO_INDEX && value > postMax) postMax = value
  }
  const at0 = vals[ZERO_INDEX]
  for (const value of vals) out.push(value)
  out.push(at0 - vals[ZERO_INDEX - 1])
  out.push(at0 - vals[DECAY_INDEX])
  out.push(at0 - min)
  out.push(postMax - preMax)
}

/**
 * Features of all series around the candidate frame.
 *
 * `null` if there are no series at all — then the caller keeps the previous score rather than
 * substituting zeros: zero here is not "no motion" but a different point in feature space.
 */
export function fieldFeaturesAt(series: FieldSeries | null, frame: number): number[] | null {
  if (!series || series.diff.length === 0) return null
  const out: number[] = []
  for (const name of FIELD_SERIES_NAMES) windowFeatures(series[name as FieldSeriesName], frame, out)
  return out
}

/** The frame a moment in time falls on. */
export function frameAt(time: number, fps: number, videoStart = 0): number {
  return Math.round((time - videoStart) * fps)
}
