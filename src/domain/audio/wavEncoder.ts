import type { AudioLike } from './audioTypes'

const FORMAT_PCM = 1
const FORMAT_IEEE_FLOAT = 3

function encodeWav(buffer: AudioLike, bitsPerSample: 16 | 32, formatCode: number): Blob {
  const { numberOfChannels, sampleRate, length } = buffer
  const bytesPerSample = bitsPerSample / 8
  const blockAlign = numberOfChannels * bytesPerSample
  const dataSize = length * blockAlign
  const arrayBuffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(arrayBuffer)

  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, formatCode, true)
  view.setUint16(22, numberOfChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  writeString(36, 'data')
  view.setUint32(40, dataSize, true)

  const channelData: Float32Array[] = []
  for (let ch = 0; ch < numberOfChannels; ch++) channelData.push(buffer.getChannelData(ch))

  let offset = 44
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const sample = channelData[ch][i]
      if (formatCode === FORMAT_IEEE_FLOAT) {
        view.setFloat32(offset, sample, true)
      } else {
        const clamped = Math.max(-1, Math.min(1, sample))
        view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
      }
      offset += bytesPerSample
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' })
}

/** Encodes an AudioBuffer as a 16-bit PCM WAV Blob, purely for in-browser preview playback. */
export function audioBufferToWavBlob(buffer: AudioLike): Blob {
  return encodeWav(buffer, 16, FORMAT_PCM)
}

/**
 * Encodes an AudioBuffer as a 32-bit float WAV Blob. Used to cache decoded clip audio for the
 * offline evaluation harness: keeping the samples bit-identical to what the browser decoder
 * produced means offline scores describe the pipeline itself, not a quantization artifact.
 */
export function audioBufferToFloat32WavBlob(buffer: AudioLike): Blob {
  return encodeWav(buffer, 32, FORMAT_IEEE_FLOAT)
}
