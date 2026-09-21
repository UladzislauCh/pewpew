export interface MelFilter {
  startBin: number
  weights: Float32Array
}

const hzToMel = (hz: number) => 2595 * Math.log10(1 + hz / 700)
const melToHz = (mel: number) => 700 * (10 ** (mel / 2595) - 1)

/**
 * Triangular mel filterbank over FFT bins.
 *
 * Mel bands instead of raw bins are needed because CS2 applies a random pitch shift to every
 * shot — on the raw spectrum two shots of the same weapon will not match, while on wide bands the
 * timbre envelope is preserved.
 */
export function buildMelFilterbank(
  numBands: number,
  fftSize: number,
  sampleRate: number,
  fMin: number,
  fMax: number,
): MelFilter[] {
  const bins = fftSize >> 1
  const binHz = sampleRate / fftSize

  const melMin = hzToMel(fMin)
  const melMax = hzToMel(Math.min(fMax, sampleRate / 2))
  // numBands + 2 points: each band rests on the previous and the next vertex.
  const edges: number[] = []
  for (let i = 0; i < numBands + 2; i++) {
    edges.push(melToHz(melMin + ((melMax - melMin) * i) / (numBands + 1)) / binHz)
  }

  const filters: MelFilter[] = []
  for (let b = 0; b < numBands; b++) {
    const left = edges[b]
    const center = edges[b + 1]
    const right = edges[b + 2]

    const startBin = Math.max(0, Math.floor(left))
    const endBin = Math.min(bins - 1, Math.ceil(right))
    const weights = new Float32Array(Math.max(0, endBin - startBin + 1))

    for (let k = startBin; k <= endBin; k++) {
      let w = 0
      if (k >= left && k <= center) w = center > left ? (k - left) / (center - left) : 1
      else if (k > center && k <= right) w = right > center ? (right - k) / (right - center) : 1
      weights[k - startBin] = w
    }
    filters.push({ startBin, weights })
  }

  return filters
}

/** Folding the power spectrum into mel bands. */
export function applyMelFilterbank(power: Float32Array, filters: MelFilter[]): Float32Array {
  const out = new Float32Array(filters.length)
  for (let b = 0; b < filters.length; b++) {
    const { startBin, weights } = filters[b]
    let sum = 0
    for (let i = 0; i < weights.length; i++) {
      const k = startBin + i
      if (k < power.length) sum += power[k] * weights[i]
    }
    out[b] = sum
  }
  return out
}
