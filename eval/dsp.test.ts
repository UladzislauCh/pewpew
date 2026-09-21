import { describe, expect, it } from 'vitest'
import { createFFT } from '../src/shared/lib/fft'
import { computeOnsetCurve } from '../src/domain/detection/onsetDetection'
import { computeLocalThreshold, pickPeaks } from '../src/domain/detection/shotDetection'
import { mulberry32, synthesizeSignal } from './synth'

/** Straightforward O(n²) DFT, used only as an independent reference for the fast implementation. */
function naiveDft(re: Float32Array, im: Float32Array): { re: Float64Array; im: Float64Array } {
  const size = re.length
  const outRe = new Float64Array(size)
  const outIm = new Float64Array(size)
  for (let k = 0; k < size; k++) {
    for (let n = 0; n < size; n++) {
      const angle = (-2 * Math.PI * k * n) / size
      outRe[k] += re[n] * Math.cos(angle) - im[n] * Math.sin(angle)
      outIm[k] += re[n] * Math.sin(angle) + im[n] * Math.cos(angle)
    }
  }
  return { re: outRe, im: outIm }
}

describe('createFFT', () => {
  it('matches a naive DFT on random input', () => {
    const size = 64
    const random = mulberry32(7)
    const re = new Float32Array(size)
    const im = new Float32Array(size)
    for (let i = 0; i < size; i++) re[i] = random() * 2 - 1

    const expected = naiveDft(re, im)
    createFFT(size).transform(re, im)

    for (let k = 0; k < size; k++) {
      expect(re[k]).toBeCloseTo(expected.re[k], 3)
      expect(im[k]).toBeCloseTo(expected.im[k], 3)
    }
  })

  it('puts a pure sinusoid in the expected bin', () => {
    const size = 64
    const bin = 5
    const re = new Float32Array(size)
    const im = new Float32Array(size)
    for (let i = 0; i < size; i++) re[i] = Math.cos((2 * Math.PI * bin * i) / size)

    createFFT(size).transform(re, im)

    const magnitudes = Array.from({ length: size / 2 }, (_, k) => Math.hypot(re[k], im[k]))
    const loudestBin = magnitudes.indexOf(Math.max(...magnitudes))
    expect(loudestBin).toBe(bin)
  })

  it('rejects sizes that are not powers of two', () => {
    expect(() => createFFT(48)).toThrow()
  })
})

describe('pickPeaks', () => {
  const curve = (values: number[]) => Float32Array.from(values)

  it('emits the maximum of each excursion above the threshold', () => {
    const peaks = pickPeaks(curve([0, 0.1, 0.9, 0.4, 0.05, 0.1, 0.8, 0.2, 0]), 0.5, 0.3)

    expect(peaks).toEqual([2, 6])
  })

  it('closes the final peak when the curve never comes back down', () => {
    const peaks = pickPeaks(curve([0, 0.2, 0.9, 0.85]), 0.5, 0.3)

    expect(peaks).toEqual([2])
  })

  it('merges two transients when the valley between them stays shallow', () => {
    // Documents the current behavior rather than endorsing it: with valleyRatio 0.3 a dip to 0.5 of
    // the running peak is not deep enough to split, so a pair of close shots reads as one.
    const peaks = pickPeaks(curve([0, 0.9, 0.45, 0.85, 0.05]), 0.5, 0.3)

    expect(peaks).toEqual([1])
  })

  it('returns nothing when the curve stays below the threshold', () => {
    expect(pickPeaks(curve([0.1, 0.2, 0.3]), 0.5, 0.3)).toEqual([])
  })

  it('accepts a per-frame threshold curve', () => {
    // High bar over the first peak, low bar over the second — only the second arms.
    const peaks = pickPeaks(
      curve([0, 0.9, 0.1, 0.8, 0]),
      curve([0, 0.95, 0.95, 0.3, 0.3]),
      0.3,
    )

    expect(peaks).toEqual([3])
  })
})

describe('computeLocalThreshold', () => {
  it('drops the bar after a brief loud region so later peaks can clear it', () => {
    // Frames 0–4 quiet, 5–9 loud spike, 10–19 quiet with a small peak at 15. Causal window of 5
    // frames: by frame 15 the spike has left recent history.
    const values = new Float32Array(20)
    for (let i = 5; i < 10; i++) values[i] = 1
    values[15] = 0.25

    const threshold = computeLocalThreshold(values, 5, 2.5, 0.02)

    expect(threshold[7]).toBeGreaterThan(0.5)
    expect(threshold[15]).toBeLessThan(values[15])
  })
})

describe('computeOnsetCurve', () => {
  it('peaks at the transient', () => {
    const audio = synthesizeSignal({ durationSeconds: 1, shots: [{ time: 0.5, amplitude: 1 }], seed: 3 })

    const onset = computeOnsetCurve(audio)
    let loudestFrame = 0
    for (let i = 1; i < onset.onsetStrength.length; i++) {
      if (onset.onsetStrength[i] > onset.onsetStrength[loudestFrame]) loudestFrame = i
    }

    // The analysis window is 1024 samples, so the peak frame is centered within ~12 ms of the shot.
    expect(onset.frameTimes[loudestFrame]).toBeGreaterThan(0.48)
    expect(onset.frameTimes[loudestFrame]).toBeLessThan(0.53)
  })

  it('produces normalized curves', () => {
    const audio = synthesizeSignal({
      durationSeconds: 1,
      shots: [{ time: 0.3, amplitude: 1 }],
      noiseAmplitude: 0.01,
      seed: 4,
    })

    const onset = computeOnsetCurve(audio)
    for (const value of onset.onsetStrength) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
    expect(Math.max(...onset.spectralFlux)).toBeCloseTo(1, 6)
  })

  it('returns an empty analysis for audio shorter than one window', () => {
    const onset = computeOnsetCurve(synthesizeSignal({ durationSeconds: 0.005, shots: [] }))

    expect(onset.frameTimes).toHaveLength(0)
    expect(onset.onsetStrength).toHaveLength(0)
  })
})
