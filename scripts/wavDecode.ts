/**
 * Minimal WAV (RIFF/PCM) decoder for the Node-based template generator script. Only the browser
 * has `AudioContext.decodeAudioData`, so the offline tooling needs its own tiny decoder — this
 * intentionally supports just what real-world WAV exports commonly use (8/16/24/32-bit integer
 * PCM and 32-bit float), skipping any chunk we don't care about.
 */
export interface DecodedWav {
  sampleRate: number
  channels: Float32Array[]
}

function readChunks(buffer: Buffer): Map<string, { offset: number; length: number }> {
  const chunks = new Map<string, { offset: number; length: number }>()
  let offset = 12 // past "RIFF"<size>"WAVE"
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const length = buffer.readUInt32LE(offset + 4)
    chunks.set(id, { offset: offset + 8, length })
    offset += 8 + length + (length % 2) // chunks are word-aligned
  }
  return chunks
}

export function decodeWavFile(buffer: Buffer): DecodedWav {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file')
  }

  const chunks = readChunks(buffer)
  const fmtChunk = chunks.get('fmt ')
  const dataChunk = chunks.get('data')
  if (!fmtChunk || !dataChunk) {
    throw new Error('Missing fmt or data chunk')
  }

  const formatCode = buffer.readUInt16LE(fmtChunk.offset)
  const numChannels = buffer.readUInt16LE(fmtChunk.offset + 2)
  const sampleRate = buffer.readUInt32LE(fmtChunk.offset + 4)
  const bitsPerSample = buffer.readUInt16LE(fmtChunk.offset + 14)
  // formatCode 0xFFFE (WAVE_FORMAT_EXTENSIBLE) stores the real code at offset +24; treat as PCM/float by bit depth.
  const isFloat = formatCode === 3

  const bytesPerSample = bitsPerSample / 8
  const frameCount = Math.floor(dataChunk.length / (bytesPerSample * numChannels))
  const channels: Float32Array[] = Array.from({ length: numChannels }, () => new Float32Array(frameCount))

  let pos = dataChunk.offset
  for (let frame = 0; frame < frameCount; frame++) {
    for (let ch = 0; ch < numChannels; ch++) {
      let sample: number
      if (isFloat && bitsPerSample === 32) {
        sample = buffer.readFloatLE(pos)
      } else if (bitsPerSample === 8) {
        sample = (buffer.readUInt8(pos) - 128) / 128
      } else if (bitsPerSample === 16) {
        sample = buffer.readInt16LE(pos) / 32768
      } else if (bitsPerSample === 24) {
        const b0 = buffer.readUInt8(pos)
        const b1 = buffer.readUInt8(pos + 1)
        const b2 = buffer.readUInt8(pos + 2)
        let value = b0 | (b1 << 8) | (b2 << 16)
        if (value & 0x800000) value |= ~0xffffff // sign-extend
        sample = value / 8388608
      } else if (bitsPerSample === 32) {
        sample = buffer.readInt32LE(pos) / 2147483648
      } else {
        throw new Error(`Unsupported bit depth: ${bitsPerSample}`)
      }
      channels[ch][frame] = sample
      pos += bytesPerSample
    }
  }

  return { sampleRate, channels }
}
