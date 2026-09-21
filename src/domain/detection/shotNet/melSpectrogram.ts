import { fft } from './fft'
import { buildMelFilterbank, applyMelFilterbank } from './mel'

export interface MelSpectrogramOptions {
  fftSize?: number
  /** Step between frames. 512 at 44.1 kHz = 11.6 ms — the network's time resolution. */
  hopSize?: number
  melBands?: number
  fMin?: number
  fMax?: number
}

export const DEFAULT_MEL_OPTIONS: Required<MelSpectrogramOptions> = {
  fftSize: 1024,
  hopSize: 512,
  melBands: 40,
  fMin: 60,
  fMax: 20000,
}

export interface MelSpectrogram {
  /** A bands x frames matrix, row per band: data[band * frames + frame]. */
  data: Float32Array
  bands: number
  frames: number
  /** Frames per second. */
  frameRate: number
}

/**
 * Log mel spectrogram — the input of the convolutional network.
 *
 * The layout is band after band (band-major), not per frame: convolution runs over time and bands
 * act as channels, so this way the data is contiguous for each channel.
 */
export function computeMelSpectrogram(
  samples: Float32Array,
  sampleRate: number,
  options: MelSpectrogramOptions = {},
): MelSpectrogram {
  const opts = { ...DEFAULT_MEL_OPTIONS, ...options }
  const { fftSize, hopSize, melBands } = opts

  const frames = Math.max(0, Math.floor((samples.length - fftSize) / hopSize) + 1)
  const data = new Float32Array(melBands * frames)
  if (frames === 0) {
    return { data, bands: melBands, frames: 0, frameRate: sampleRate / hopSize }
  }

  const window = new Float32Array(fftSize)
  for (let i = 0; i < fftSize; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1)))
  }

  const filters = buildMelFilterbank(melBands, fftSize, sampleRate, opts.fMin, opts.fMax)
  const bins = fftSize >> 1
  const re = new Float32Array(fftSize)
  const im = new Float32Array(fftSize)
  const power = new Float32Array(bins)

  for (let f = 0; f < frames; f++) {
    const off = f * hopSize
    for (let i = 0; i < fftSize; i++) {
      re[i] = samples[off + i] * window[i]
      im[i] = 0
    }
    fft(re, im)
    for (let k = 0; k < bins; k++) power[k] = re[k] * re[k] + im[k] * im[k]

    const mel = applyMelFilterbank(power, filters)
    for (let b = 0; b < melBands; b++) {
      data[b * frames + f] = Math.log(mel[b] + 1e-10)
    }
  }

  return { data, bands: melBands, frames, frameRate: sampleRate / hopSize }
}

/**
 * Per-clip normalisation: each band has its own mean subtracted and is divided by its own SD.
 *
 * Without this the network would compare the loudness of clips with each other. We normalise per
 * band rather than globally because mel bands differ in average level by orders of magnitude.
 * Modifies the spectrogram in place.
 */
export function normalizePerBand(spec: MelSpectrogram): void {
  const { data, bands, frames } = spec
  if (frames === 0) return
  for (let b = 0; b < bands; b++) {
    const off = b * frames
    let mean = 0
    for (let f = 0; f < frames; f++) mean += data[off + f]
    mean /= frames
    let variance = 0
    for (let f = 0; f < frames; f++) variance += (data[off + f] - mean) ** 2
    const sd = Math.sqrt(variance / frames) || 1
    for (let f = 0; f < frames; f++) data[off + f] = (data[off + f] - mean) / sd
  }
}
