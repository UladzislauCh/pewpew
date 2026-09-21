import { describe, expect, it } from 'vitest'
import { extendChannelsWithOutro, OUTRO_DURATION_SEC, OUTRO_SFX_GAIN } from '../src/domain/audio/outroAudio'

function makeChannels(
  durationSec: number,
  sampleRate = 48000,
  numberOfChannels = 2,
  fill = 0.25,
): Float32Array[] {
  const length = Math.round(durationSec * sampleRate)
  return Array.from({ length: numberOfChannels }, () => new Float32Array(length).fill(fill))
}

describe('extendChannelsWithOutro', () => {
  it('appends silence of the configured outro length', () => {
    const sampleRate = 48000
    const base = makeChannels(1, sampleRate)
    const extended = extendChannelsWithOutro(base, sampleRate, null, null, OUTRO_DURATION_SEC)

    expect(extended).toHaveLength(2)
    expect(extended[0]!.length / sampleRate).toBeCloseTo(1 + OUTRO_DURATION_SEC, 3)
    expect(extended[0]![0]).toBeCloseTo(0.25)
    expect(extended[0]![base[0]!.length]).toBeCloseTo(0)
  })

  it('mixes sfx at the start of the outro window', () => {
    const sampleRate = 48000
    const base = makeChannels(0.5, sampleRate, 1, 0)
    const sfx = makeChannels(0.1, sampleRate, 1, 0.5)
    const extended = extendChannelsWithOutro(base, sampleRate, sfx, sampleRate, OUTRO_DURATION_SEC)

    const baseLength = base[0]!.length
    expect(extended[0]![baseLength]).toBeCloseTo(0.5 * OUTRO_SFX_GAIN)
    expect(extended[0]![baseLength + sfx[0]!.length + 10]).toBeCloseTo(0)
  })
})
