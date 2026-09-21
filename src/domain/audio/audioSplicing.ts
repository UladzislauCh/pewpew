import type { DetectedShot } from '../detection/shotDetection'

export interface SplicePlan {
  insertStartSample: number
  /** Where the replacement clip's own audio stops being written. */
  insertEndSample: number
  /**
   * Where hard silence (zeros) ends. Equal to `insertEndSample` when using post-replacement
   * ducking; may extend further in the decay-based fallback path.
   */
  muteEndSample: number
  /**
   * Where the 0%→100% fade-in of the original ends. Equal to `muteEndSample` when there is
   * no fade region.
   */
  duckEndSample: number
}

const DEFAULT_FADE_SECONDS = 0.012
/** How far past the shot peak we'll scan when measuring the original's decay tail. */
const DEFAULT_MUTE_MAX_SECONDS = 1.2
/**
 * Hard cap on how long past the replacement clip we keep the original silent. Long game-audio
 * tails (AWP reverb) would otherwise mute for close to a second and leave an audible hole after
 * a short meme sound — we only bridge the worst of the leak.
 */
const DEFAULT_MUTE_EXTENSION_SECONDS = 0.25
/**
 * The original is considered to have decayed away once its short-window envelope stays at or
 * below this fraction of the shot peak for `MUTE_HOLD_SECONDS`. Low enough that AWP-style
 * reverb tails (often a few % of peak) stay muted, but above typical clip noise floor.
 */
const DEFAULT_MUTE_DECAY_RATIO = 0.04
const PEAK_SEARCH_RADIUS_SECONDS = 0.01
/** Sliding-max window used as a crude amplitude envelope so zero crossings don't end the mute. */
const ENVELOPE_WINDOW_SECONDS = 0.008
/** How long the envelope must stay below the decay threshold before we treat the tail as gone. */
const MUTE_HOLD_SECONDS = 0.02
/** Gain at the start of the post-replacement fade-in (ramps linearly to 1). */
const POST_DUCK_START_GAIN = 0

function sampleAbsMax(channels: Float32Array[], index: number): number {
  let max = 0
  for (const data of channels) {
    const value = Math.abs(data[index])
    if (value > max) max = value
  }
  return max
}

/**
 * Peak of |sample| over a short window centered on `index`. Using a window (instead of a single
 * sample) keeps oscillatory gunshot waveforms from looking "quiet" at every zero crossing.
 */
function envelopeAt(
  channels: Float32Array[],
  index: number,
  length: number,
  halfWindowSamples: number,
): number {
  const start = Math.max(0, index - halfWindowSamples)
  const end = Math.min(length, index + halfWindowSamples + 1)
  let max = 0
  for (let i = start; i < end; i++) {
    const amplitude = sampleAbsMax(channels, i)
    if (amplitude > max) max = amplitude
  }
  return max
}

/** Finds the exact sample (within `radiusSamples` of `approxIndex`) with the highest amplitude. */
function findLocalPeak(
  channels: Float32Array[],
  approxIndex: number,
  radiusSamples: number,
  length: number,
): { index: number; amplitude: number } {
  const start = Math.max(0, approxIndex - radiusSamples)
  const end = Math.min(length, approxIndex + radiusSamples + 1)
  let peakIndex = approxIndex
  let peakAmplitude = 0
  for (let i = start; i < end; i++) {
    const amplitude = sampleAbsMax(channels, i)
    if (amplitude > peakAmplitude) {
      peakAmplitude = amplitude
      peakIndex = i
    }
  }
  return { index: peakIndex, amplitude: peakAmplitude }
}

/**
 * Finds how far past the shot peak the original sound's audible tail extends, so we know how long
 * to keep it muted even once the replacement clip has finished playing. Game gunshots often carry
 * a reverb/echo tail well past their initial crack, while a user's replacement recording may be
 * much shorter — without this, the original's tail would still play out, unmuffled, right after
 * the replacement.
 *
 * Search starts at the peak (not the onset timestamp) and requires the smoothed envelope to stay
 * below the threshold for a hold period, so brief dips / zero crossings don't cut the mute short.
 */
function findDecayEndSample(
  channels: Float32Array[],
  peakIndex: number,
  peakAmplitude: number,
  length: number,
  maxDurationSamples: number,
  decayRatio: number,
  halfWindowSamples: number,
  holdSamples: number,
): number {
  const limit = Math.min(length, peakIndex + maxDurationSamples)
  if (peakAmplitude === 0) return peakIndex
  const target = peakAmplitude * decayRatio
  let belowCount = 0

  for (let i = peakIndex; i < limit; i++) {
    if (envelopeAt(channels, i, length, halfWindowSamples) <= target) {
      belowCount++
      if (belowCount >= holdSamples) {
        // Mute through the start of the sustained-quiet region (not the end of the hold).
        return i - holdSamples + 1
      }
    } else {
      belowCount = 0
    }
  }
  return limit
}

/**
 * Turns detected shot timestamps into concrete sample-index insertion windows. A window is
 * truncated if the next shot's window would otherwise overlap it (rapid fire), so replacement
 * clips never step on each other.
 *
 * Post-replacement handling (first match wins):
 * - `postDuckBudgetSeconds` — after the clip, fade original from 0%→100% for
 *   `max(0, budget - playedReplacementSeconds)` (product default: 2s).
 * - `muteDurationSeconds` — hard-mute from the shot start for this long (tests / overrides).
 * - otherwise — decay-tail search with a short extension cap.
 */
export function buildSplicePlans(
  shots: DetectedShot[],
  originalChannels: Float32Array[],
  sampleRate: number,
  replacementLengthSamples: number,
  totalLengthSamples: number,
  options: {
    /** Soft-duck budget after each shot (seconds). See module docs. */
    postDuckBudgetSeconds?: number
    /** Total hard-mute window from the shot start (replacement may be shorter). */
    muteDurationSeconds?: number
    muteMaxSeconds?: number
    muteExtensionSeconds?: number
    muteDecayRatio?: number
  } = {},
): SplicePlan[] {
  const muteMaxSamples = Math.round((options.muteMaxSeconds ?? DEFAULT_MUTE_MAX_SECONDS) * sampleRate)
  const muteExtensionSamples = Math.round(
    (options.muteExtensionSeconds ?? DEFAULT_MUTE_EXTENSION_SECONDS) * sampleRate,
  )
  const decayRatio = options.muteDecayRatio ?? DEFAULT_MUTE_DECAY_RATIO
  const peakSearchRadius = Math.round(PEAK_SEARCH_RADIUS_SECONDS * sampleRate)
  const halfWindowSamples = Math.max(1, Math.round((ENVELOPE_WINDOW_SECONDS * sampleRate) / 2))
  const holdSamples = Math.max(1, Math.round(MUTE_HOLD_SECONDS * sampleRate))
  const explicitMuteSamples =
    options.muteDurationSeconds !== undefined
      ? Math.max(0, Math.round(options.muteDurationSeconds * sampleRate))
      : null
  const postDuckBudgetSamples =
    options.postDuckBudgetSeconds !== undefined
      ? Math.max(0, Math.round(options.postDuckBudgetSeconds * sampleRate))
      : null

  const plans: SplicePlan[] = []
  const sortedShots = [...shots].sort((a, b) => a.time - b.time)

  for (let i = 0; i < sortedShots.length; i++) {
    const insertStartSample = Math.round(sortedShots[i].time * sampleRate)
    const nextShotSample =
      i + 1 < sortedShots.length ? Math.round(sortedShots[i + 1].time * sampleRate) : Infinity

    let insertEndSample: number
    let muteEndSample: number
    let duckEndSample: number

    if (postDuckBudgetSamples !== null) {
      insertEndSample = Math.min(
        insertStartSample + replacementLengthSamples,
        nextShotSample,
        totalLengthSamples,
      )
      if (insertEndSample <= insertStartSample) continue
      const playedSamples = insertEndSample - insertStartSample
      const duckSamples = Math.max(0, postDuckBudgetSamples - playedSamples)
      muteEndSample = insertEndSample
      duckEndSample = Math.min(insertEndSample + duckSamples, nextShotSample, totalLengthSamples)
    } else if (explicitMuteSamples !== null) {
      muteEndSample = Math.min(insertStartSample + explicitMuteSamples, nextShotSample, totalLengthSamples)
      insertEndSample = Math.min(
        insertStartSample + replacementLengthSamples,
        muteEndSample,
        nextShotSample,
        totalLengthSamples,
      )
      duckEndSample = muteEndSample
    } else {
      insertEndSample = Math.min(
        insertStartSample + replacementLengthSamples,
        nextShotSample,
        totalLengthSamples,
      )
      if (insertEndSample <= insertStartSample) continue

      const peak = findLocalPeak(originalChannels, insertStartSample, peakSearchRadius, totalLengthSamples)
      const decayEndSample = findDecayEndSample(
        originalChannels,
        peak.index,
        peak.amplitude,
        totalLengthSamples,
        muteMaxSamples,
        decayRatio,
        halfWindowSamples,
        holdSamples,
      )
      muteEndSample = Math.min(
        Math.max(insertEndSample, decayEndSample),
        insertEndSample + muteExtensionSamples,
        nextShotSample,
        totalLengthSamples,
      )
      duckEndSample = muteEndSample
    }

    if (insertEndSample <= insertStartSample) continue
    plans.push({ insertStartSample, insertEndSample, muteEndSample, duckEndSample })
  }

  return plans
}

/**
 * Pure sample-level splice: copies the original audio, then for every detected shot, fades the
 * original out, writes in the replacement clip (with its own short fade-in/out), and fades the
 * original back in afterwards. Operating directly on Float32Arrays (rather than driving this
 * through an AudioContext graph) keeps this deterministic and unit-testable outside the browser.
 */
export function spliceChannels(
  originalChannels: Float32Array[],
  replacementChannels: Float32Array[],
  shots: DetectedShot[],
  sampleRate: number,
  options: {
    fadeDurationSeconds?: number
    postDuckBudgetSeconds?: number
    muteDurationSeconds?: number
    muteMaxSeconds?: number
    muteExtensionSeconds?: number
    muteDecayRatio?: number
  } = {},
): Float32Array[] {
  const outputChannels = originalChannels.map((data) => data.slice())

  const totalLength = originalChannels[0]?.length ?? 0
  const replacementLength = replacementChannels[0]?.length ?? 0
  if (shots.length === 0 || replacementLength === 0 || totalLength === 0) {
    return outputChannels
  }

  const fadeSamples = Math.max(1, Math.round((options.fadeDurationSeconds ?? DEFAULT_FADE_SECONDS) * sampleRate))
  const plans = buildSplicePlans(shots, originalChannels, sampleRate, replacementLength, totalLength, {
    postDuckBudgetSeconds: options.postDuckBudgetSeconds,
    muteDurationSeconds: options.muteDurationSeconds,
    muteMaxSeconds: options.muteMaxSeconds,
    muteExtensionSeconds: options.muteExtensionSeconds,
    muteDecayRatio: options.muteDecayRatio,
  })

  for (const { insertStartSample, insertEndSample, muteEndSample, duckEndSample } of plans) {
    const windowLength = insertEndSample - insertStartSample
    const localFade = Math.min(fadeSamples, Math.floor(windowLength / 2))
    const duckLength = duckEndSample - muteEndSample

    for (let ch = 0; ch < outputChannels.length; ch++) {
      const output = outputChannels[ch]
      const replacement = replacementChannels[ch]
      // Keep a copy of the original under the mute/duck region so we can restore a ducked version
      // after the replacement clip finishes (hard mute zeros would otherwise wipe it).
      const originalUnderDuck =
        duckLength > 0 ? originalChannels[ch].slice(muteEndSample, duckEndSample) : null

      // Fade the original out right before the insertion point.
      const fadeOutStart = Math.max(0, insertStartSample - fadeSamples)
      const preFadeLength = insertStartSample - fadeOutStart
      for (let i = 0; i < preFadeLength; i++) {
        const gain = 1 - (i + 1) / preFadeLength
        output[fadeOutStart + i] *= gain
      }

      // Overwrite the window with the replacement clip, tapering its own edges.
      for (let j = 0; j < windowLength; j++) {
        let envelope = 1
        if (localFade > 0 && j < localFade) {
          envelope = j / localFade
        } else if (localFade > 0 && j >= windowLength - localFade) {
          envelope = (windowLength - 1 - j) / localFade
        }
        output[insertStartSample + j] = replacement[j] * envelope
      }

      // Hard silence only when mute extends past the replacement (decay / explicit mute paths).
      for (let k = insertEndSample; k < muteEndSample; k++) {
        output[k] = 0
      }

      // Soft fade-in: restore original at 0% and ramp linearly to 100% over the duck window.
      if (originalUnderDuck && duckLength > 0) {
        for (let i = 0; i < duckLength; i++) {
          const t = duckLength === 1 ? 1 : i / (duckLength - 1)
          const gain = POST_DUCK_START_GAIN + (1 - POST_DUCK_START_GAIN) * t
          output[muteEndSample + i] = originalUnderDuck[i] * gain
        }
      } else {
        // No duck region — short fade-in of whatever is already in the buffer after mute.
        const fadeInEnd = Math.min(totalLength, muteEndSample + fadeSamples)
        const postFadeLength = fadeInEnd - muteEndSample
        for (let i = 0; i < postFadeLength; i++) {
          const gain = (i + 1) / postFadeLength
          output[muteEndSample + i] *= gain
        }
      }
    }
  }

  return outputChannels
}
