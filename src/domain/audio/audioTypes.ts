/**
 * Minimal structural view of decoded PCM audio, matching the subset of the browser's `AudioBuffer`
 * that the detection DSP actually reads. A real `AudioBuffer` satisfies this interface as-is, while
 * Node-side tooling (the evaluation harness) supplies its own WAV-backed implementation — so the
 * detection pipeline can be measured offline without a browser or WebCodecs.
 */
export interface AudioLike {
  readonly sampleRate: number
  readonly length: number
  readonly numberOfChannels: number
  readonly duration: number
  getChannelData(channel: number): Float32Array
}

/**
 * Downmixes to a single mono `Float32Array` by averaging channels. For already-mono input the
 * channel data is returned directly; every caller treats the result as read-only.
 */
export function toMono(buffer: AudioLike): Float32Array {
  const { numberOfChannels, length } = buffer
  if (numberOfChannels === 1) return buffer.getChannelData(0)

  const mono = new Float32Array(length)
  for (let channel = 0; channel < numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel)
    for (let i = 0; i < length; i++) mono[i] += data[i] / numberOfChannels
  }
  return mono
}
