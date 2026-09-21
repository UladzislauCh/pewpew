import { matchChannelCount, resampleLinear } from '../../shared/lib/resample'

/** Branded outro length appended after the original clip (seconds). */
export const OUTRO_DURATION_SEC = 1.5

/** Linear gain applied to the outro sting when mixed onto the end-card. */
export const OUTRO_SFX_GAIN = 0.5

function resampleChannels(
  channels: Float32Array[],
  inputRate: number,
  outputRate: number,
): Float32Array[] {
  if (inputRate === outputRate) return channels
  return channels.map((ch) => resampleLinear(ch, inputRate, outputRate))
}

/**
 * Appends `outroSec` of silence after `baseChannels`, mixing optional SFX at the start of that
 * window. Pure PCM — safe to call from Node (eval harness) without Web Audio / DOM.
 */
export function extendChannelsWithOutro(
  baseChannels: Float32Array[],
  sampleRate: number,
  sfxChannels: Float32Array[] | null,
  sfxSampleRate: number | null,
  outroSec: number,
): Float32Array[] {
  const numberOfChannels = baseChannels.length
  if (numberOfChannels === 0) return []

  const baseLength = baseChannels[0]?.length ?? 0
  const outroFrames = Math.max(1, Math.round(outroSec * sampleRate))
  const result = baseChannels.map((ch) => {
    const out = new Float32Array(baseLength + outroFrames)
    out.set(ch, 0)
    return out
  })

  if (!sfxChannels || sfxChannels.length === 0 || sfxSampleRate == null) return result

  let fitted = resampleChannels(sfxChannels, sfxSampleRate, sampleRate)
  fitted = matchChannelCount(fitted, numberOfChannels)

  for (let ch = 0; ch < numberOfChannels; ch++) {
    const dest = result[ch]!
    const src = fitted[ch]!
    const n = Math.min(src.length, outroFrames)
    const offset = baseLength
    for (let i = 0; i < n; i++) {
      dest[offset + i] = Math.max(
        -1,
        Math.min(1, (dest[offset + i] ?? 0) + (src[i] ?? 0) * OUTRO_SFX_GAIN),
      )
    }
  }

  return result
}
