import { computeMelSpectrogram, normalizePerBand, DEFAULT_MEL_OPTIONS, type MelSpectrogramOptions } from './melSpectrogram'
import { predict, type ShotNetWeights } from './shotNet'

export interface DetectShotsOptions {
  /**
   * Probability threshold. Tuned on the precision/recall curve over labelled data
   * (eval/trainShotNet.mjs). Lower means more shots and more false ones.
   */
  threshold?: number
  /**
   * Minimum gap between shots, ms.
   *
   * 50 ms is roughly the cycle of the fastest CS2 weapon, i.e. the limit below which two separate
   * shots are physically impossible. Anything closer is a repeat trigger on one shot (a reverb
   * tail), and it must be merged.
   * Measured: raising it from 25 to 50 ms gives +6 pp precision at the same recall,
   * and at 60 ms real bursts start to be lost.
   */
  minGapMs?: number
  /**
   * Minimum peak prominence: how far it rises above the surrounding troughs.
   *
   * A height threshold is not enough. A gentle bump in noise and the sharp peak of a shot can have
   * the same top, but the shot stands out against its neighbours and the bump does not.
   * Especially important with a long network receptive field: the curve is smoother there, and
   * local maxima in noise become more numerous.
   *
   * 0 disables the check and restores the old behaviour.
   */
  minProminence?: number
  /** Window for finding troughs around a peak when estimating prominence. */
  prominenceWindowMs?: number
  mel?: MelSpectrogramOptions
}

export const DEFAULT_DETECT_OPTIONS: Required<Omit<DetectShotsOptions, 'mel'>> = {
  threshold: 0.5,
  minGapMs: 50,
  minProminence: 0,
  prominenceWindowMs: 400,
}

export interface DetectedShot {
  time: number
  confidence: number
}

/**
 * The full audio shot detection path: mel spectrogram, network, peak picking.
 *
 * A pure function over samples — works in the browser and in Node unchanged.
 * Weights arrive as a separate JSON (see serializeWeights), no inference runtime is needed.
 */
export function detectShotsWithNet(
  samples: Float32Array,
  sampleRate: number,
  weights: ShotNetWeights,
  options: DetectShotsOptions = {},
): DetectedShot[] {
  const opts = { ...DEFAULT_DETECT_OPTIONS, ...options }

  const spec = computeMelSpectrogram(samples, sampleRate, { ...DEFAULT_MEL_OPTIONS, ...options.mel })
  if (spec.frames === 0) return []
  // Normalisation must match the one used in training, otherwise the weights are meaningless.
  normalizePerBand(spec)

  const prob = predict(weights, spec)
  return pickPeaks(prob, spec.frameRate, opts.threshold, opts.minGapMs, opts.minProminence, opts.prominenceWindowMs)
}

/**
 * Peak prominence: how much higher it is than the deepest trough on either side, walking from the
 * peak to where the curve rises above it (or to the window edge). The larger of the two troughs is
 * taken — otherwise a peak on the slope of a big hill would count as prominent.
 */
function prominenceAt(prob: Float32Array, t: number, window: number): number {
  const peak = prob[t]
  let minLeft = peak
  for (let i = t - 1, n = 0; i >= 0 && n < window; i--, n++) {
    if (prob[i] > peak) break
    if (prob[i] < minLeft) minLeft = prob[i]
  }
  let minRight = peak
  for (let i = t + 1, n = 0; i < prob.length && n < window; i++, n++) {
    if (prob[i] > peak) break
    if (prob[i] < minRight) minRight = prob[i]
  }
  return peak - Math.max(minLeft, minRight)
}

/**
 * Peaks of the probability curve: a local maximum above the threshold, no closer than minGapMs to
 * the previous one and prominent enough against its neighbours.
 * Exported separately so peaks can be found on an already computed curve.
 */
export function pickPeaks(
  prob: Float32Array,
  frameRate: number,
  threshold: number,
  minGapMs: number,
  minProminence = 0,
  prominenceWindowMs = 400,
): DetectedShot[] {
  const minGap = Math.max(1, Math.round((minGapMs / 1000) * frameRate))
  const window = Math.max(1, Math.round((prominenceWindowMs / 1000) * frameRate))
  const out: DetectedShot[] = []
  let last = -Infinity

  for (let t = 1; t < prob.length - 1; t++) {
    if (prob[t] < threshold) continue
    if (prob[t] < prob[t - 1] || prob[t] < prob[t + 1]) continue
    if (t - last < minGap) continue
    if (minProminence > 0 && prominenceAt(prob, t, window) < minProminence) continue
    last = t
    out.push({ time: t / frameRate, confidence: prob[t] })
  }

  return out
}
