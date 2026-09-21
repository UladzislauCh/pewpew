/** Simple linear-interpolation resampler — good enough for short voice/effect clips. */
export function resampleLinear(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (inputRate === outputRate || input.length === 0) return input.slice()
  if (input.length === 1) {
    const outputLength = Math.max(1, Math.round((input.length * outputRate) / inputRate))
    return new Float32Array(outputLength).fill(input[0])
  }

  const outputLength = Math.max(1, Math.round((input.length * outputRate) / inputRate))
  const output = new Float32Array(outputLength)
  const ratio = (input.length - 1) / Math.max(1, outputLength - 1)

  for (let i = 0; i < outputLength; i++) {
    const sourcePosition = i * ratio
    const sourceIndex = Math.floor(sourcePosition)
    const fraction = sourcePosition - sourceIndex
    const a = input[sourceIndex]
    const b = input[Math.min(input.length - 1, sourceIndex + 1)]
    output[i] = a + (b - a) * fraction
  }

  return output
}

/**
 * Adapts a set of channels to a target channel count: duplicates mono to every target channel,
 * or downmixes multi-channel audio to mono (then duplicates) if the counts otherwise mismatch.
 */
export function matchChannelCount(channels: Float32Array[], targetChannelCount: number): Float32Array[] {
  if (channels.length === targetChannelCount) return channels
  if (channels.length === 1) {
    return Array.from({ length: targetChannelCount }, () => channels[0])
  }

  const length = channels[0]?.length ?? 0
  const mono = new Float32Array(length)
  for (const data of channels) {
    for (let i = 0; i < length; i++) mono[i] += data[i] / channels.length
  }
  return Array.from({ length: targetChannelCount }, () => mono)
}
