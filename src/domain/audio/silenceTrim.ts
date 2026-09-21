export interface SilenceTrimBounds {
  startSample: number
  endSample: number
}

/**
 * Finds the sample range that excludes near-silent lead-in/trail-off, based on an amplitude
 * threshold relative to the clip's own peak. Recordings almost always have a bit of dead air
 * before/after the actual sound (e.g. a breath before shouting, or delay before/after pressing
 * record) — without trimming it, a replacement window truncated by a following shot (rapid fire)
 * can end up playing nothing but that lead-in silence instead of the actual sound.
 */
export function findSilenceTrimBounds(
  channels: Float32Array[],
  thresholdRatio = 0.08,
): SilenceTrimBounds {
  const length = channels[0]?.length ?? 0
  if (length === 0) return { startSample: 0, endSample: 0 }

  let peak = 0
  for (const data of channels) {
    for (let i = 0; i < length; i++) {
      const abs = Math.abs(data[i])
      if (abs > peak) peak = abs
    }
  }
  if (peak === 0) return { startSample: 0, endSample: length }

  const threshold = peak * thresholdRatio

  let start = 0
  while (start < length && !channels.some((data) => Math.abs(data[start]) >= threshold)) {
    start++
  }

  let end = length
  while (end > start && !channels.some((data) => Math.abs(data[end - 1]) >= threshold)) {
    end--
  }

  return { startSample: start, endSample: end }
}

export function trimSilence(channels: Float32Array[], thresholdRatio = 0.08): Float32Array[] {
  const { startSample, endSample } = findSilenceTrimBounds(channels, thresholdRatio)
  if (startSample === 0 && endSample === (channels[0]?.length ?? 0)) return channels
  return channels.map((data) => data.slice(startSample, endSample))
}
