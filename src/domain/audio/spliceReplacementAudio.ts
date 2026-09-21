import type { AudioLike } from './audioTypes'
import type { DetectedShot } from '../detection/shotDetection'
import { matchChannelCount, resampleLinear } from '../../shared/lib/resample'
import { trimSilence } from './silenceTrim'
import { spliceChannels } from './audioSplicing'
import {
  DEFAULT_SILENCE_THRESHOLD_RATIO,
  POST_DUCK_BUDGET_SECONDS,
  REPLACEMENT_LEAD_SECONDS,
} from './spliceDefaults'

export {
  DEFAULT_SILENCE_THRESHOLD_RATIO,
  POST_DUCK_BUDGET_SECONDS,
  REPLACEMENT_LEAD_SECONDS,
} from './spliceDefaults'

/**
 * Browser-facing wrapper: resamples/channel-matches the replacement clip to the original's format,
 * splices it in at every detected shot, and wraps the result back into a playable `AudioBuffer`.
 *
 * Kept out of `audioSplicing.ts` so the Node eval harness can import the pure splice helpers
 * without pulling in DOM `AudioBuffer` / `BaseAudioContext` types.
 */
export function spliceReplacementAudio(
  /** Also `AudioLike`: only channels, sample rate and length are read from it. */
  originalBuffer: AudioLike,
  /**
   * `AudioLike`, not `AudioBuffer`: only channels, sample rate and channel count are
   * read from it. The narrower type lets the store keep decoded audio in a form that
   * must also run without a DOM — together with its own tests.
   */
  replacementBuffer: AudioLike,
  shots: DetectedShot[],
  audioContext: BaseAudioContext,
  options: {
    fadeDurationSeconds?: number
    silenceThresholdRatio?: number
    /** Soft-duck budget after each shot (defaults to {@link POST_DUCK_BUDGET_SECONDS}). */
    postDuckBudgetSeconds?: number
    muteDurationSeconds?: number
    muteMaxSeconds?: number
    muteExtensionSeconds?: number
    muteDecayRatio?: number
    /** How much earlier than the moment to place the sound (defaults to {@link REPLACEMENT_LEAD_SECONDS}). */
    leadSeconds?: number
  } = {},
): AudioBuffer {
  const { numberOfChannels, length, sampleRate } = originalBuffer

  const originalChannels: Float32Array[] = []
  for (let ch = 0; ch < numberOfChannels; ch++) originalChannels.push(originalBuffer.getChannelData(ch))

  const replacementSourceChannels: Float32Array[] = []
  for (let ch = 0; ch < replacementBuffer.numberOfChannels; ch++) {
    replacementSourceChannels.push(replacementBuffer.getChannelData(ch))
  }
  const resampledReplacementChannels = replacementSourceChannels.map((data) =>
    resampleLinear(data, replacementBuffer.sampleRate, sampleRate),
  )
  const channelMatchedReplacement = matchChannelCount(resampledReplacementChannels, numberOfChannels)
  // Trim silence so a truncated window (rapid fire, shots closer together than the replacement
  // clip) always starts right at the actual sound instead of dead air at the front of the recording.
  const replacementChannels = trimSilence(
    channelMatchedReplacement,
    options.silenceThresholdRatio ?? DEFAULT_SILENCE_THRESHOLD_RATIO,
  )

  // The shift is applied HERE, not to the labels: the muting of the original sound moves
  // along with the splice, and it's that muting that hides the start of the real shot.
  const lead = options.leadSeconds ?? REPLACEMENT_LEAD_SECONDS
  const placed = lead ? shots.map((s) => ({ ...s, time: Math.max(0, s.time - lead) })) : shots

  const outputChannels = spliceChannels(originalChannels, replacementChannels, placed, sampleRate, {
    fadeDurationSeconds: options.fadeDurationSeconds,
    postDuckBudgetSeconds: options.postDuckBudgetSeconds ?? POST_DUCK_BUDGET_SECONDS,
    muteDurationSeconds: options.muteDurationSeconds,
    muteMaxSeconds: options.muteMaxSeconds,
    muteExtensionSeconds: options.muteExtensionSeconds,
    muteDecayRatio: options.muteDecayRatio,
  })

  const result = audioContext.createBuffer(numberOfChannels, length, sampleRate)
  for (let ch = 0; ch < numberOfChannels; ch++) {
    // These arrays are always backed by a plain ArrayBuffer (created via `new Float32Array`/`.slice()`),
    // but TS's DOM lib types `copyToChannel` against the newer ArrayBuffer-specific generic.
    result.copyToChannel(outputChannels[ch] as Float32Array<ArrayBuffer>, ch)
  }
  return result
}
