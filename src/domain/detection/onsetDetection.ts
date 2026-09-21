import { type AudioLike, toMono } from '../audio/audioTypes'
import { createFFT } from '../../shared/lib/fft'
import type { OnsetAnalysis } from './onsetTypes'

export type { OnsetAnalysis } from './onsetTypes'

const DEFAULT_WINDOW_SIZE = 1024
const DEFAULT_HOP_SIZE = 256

function makeHannWindow(size: number): Float32Array {
  const window = new Float32Array(size)
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)))
  }
  return window
}

function normalizeByPeak(values: Float32Array): Float32Array {
  let max = 0
  for (const value of values) {
    if (value > max) max = value
  }
  if (max <= 0) return values

  const result = new Float32Array(values.length)
  for (let i = 0; i < values.length; i++) result[i] = values[i] / max
  return result
}

/**
 * Computes a per-frame "onset strength" curve for an audio buffer, combining spectral flux
 * (sudden broadband energy increase) and the rise in high-frequency content (weighted toward the
 * sharp "crack" of a gunshot's attack). Both are classic onset-detection features from music
 * information retrieval that respond well to short, loud, broadband transients.
 *
 * Full band on purpose. Weighting the curve toward the 300–2000 Hz region where gunshots actually
 * live scores worse, because spectral shape turns out to be useful for judging a candidate but not
 * for locating one — see `eval/README.md`.
 */
export function computeOnsetCurve(
  audioBuffer: AudioLike,
  windowSize = DEFAULT_WINDOW_SIZE,
  hopSize = DEFAULT_HOP_SIZE,
): OnsetAnalysis {
  const mono = toMono(audioBuffer)
  const hannWindow = makeHannWindow(windowSize)
  const fft = createFFT(windowSize)
  const halfSize = windowSize / 2

  const numFrames = Math.max(0, Math.floor((mono.length - windowSize) / hopSize) + 1)

  const frameTimes = new Float32Array(numFrames)
  const spectralFluxRaw = new Float32Array(numFrames)
  const hfcRaw = new Float32Array(numFrames)

  const re = new Float32Array(windowSize)
  const im = new Float32Array(windowSize)
  let prevMagnitude: Float32Array | null = null

  for (let frame = 0; frame < numFrames; frame++) {
    const start = frame * hopSize
    for (let i = 0; i < windowSize; i++) {
      re[i] = mono[start + i] * hannWindow[i]
      im[i] = 0
    }
    fft.transform(re, im)

    const magnitude = new Float32Array(halfSize)
    let flux = 0
    let hfc = 0
    for (let k = 0; k < halfSize; k++) {
      const mag = Math.hypot(re[k], im[k])
      magnitude[k] = mag
      hfc += mag * (k + 1)
      if (prevMagnitude) {
        const diff = mag - prevMagnitude[k]
        if (diff > 0) flux += diff
      }
    }

    frameTimes[frame] = (start + windowSize / 2) / audioBuffer.sampleRate
    spectralFluxRaw[frame] = flux
    hfcRaw[frame] = hfc
    prevMagnitude = magnitude
  }

  const hfcRise = new Float32Array(numFrames)
  for (let i = 1; i < numFrames; i++) hfcRise[i] = Math.max(0, hfcRaw[i] - hfcRaw[i - 1])

  const spectralFlux = normalizeByPeak(spectralFluxRaw)
  const highFrequencyRise = normalizeByPeak(hfcRise)

  const onsetStrength = new Float32Array(numFrames)
  for (let i = 0; i < numFrames; i++) {
    onsetStrength[i] = (spectralFlux[i] + highFrequencyRise[i]) / 2
  }

  return {
    frameTimes,
    spectralFlux,
    highFrequencyRise,
    onsetStrength,
    windowSize,
    hopSize,
    sampleRate: audioBuffer.sampleRate,
  }
}
