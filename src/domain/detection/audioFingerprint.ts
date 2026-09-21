import { createFFT } from '../../shared/lib/fft'

/**
 * A gunshot's "timbre fingerprint": a fixed-length, loudness-independent numeric descriptor of
 * what a shot sounds like, used to compare a candidate onset against a library of known weapons.
 *
 * Layout (42 numbers total):
 *   - 3 "attack" frames (around the transient) + 1 "tail" frame (the decay/reverb tail),
 *     each contributing 10 numbers: 8 log-spaced band-energy ratios + spectral centroid +
 *     spectral flatness.
 *   - 2 global temporal scalars: normalized attack time and decay time.
 *
 * This is plain DSP (FFT + basic statistics) with no Web/DOM APIs, so the exact same function runs
 * both in the browser (matching against live shot candidates) and in the Node-based offline
 * generator script that builds the weapon template library from reference recordings.
 */

const FFT_SIZE = 1024
const NUM_BANDS = 8
/** Band edges in Hz; produces NUM_BANDS ranges together with the implicit 0 and Nyquist bounds. */
const BAND_EDGES_HZ = [150, 300, 600, 1200, 2400, 4800, 9600]

/** Frame start offsets in milliseconds, relative to the shot's peak sample. */
const ATTACK_FRAME_OFFSETS_MS = [-5, 10, 25]
const TAIL_FRAME_OFFSET_MS = 100

const MAX_ATTACK_TIME_SECONDS = 0.05
const MAX_DECAY_TIME_SECONDS = 0.3

const FEATURES_PER_FRAME = NUM_BANDS + 2 // bands + centroid + flatness
const NUM_FRAMES = ATTACK_FRAME_OFFSETS_MS.length + 1 // + tail frame
export const FINGERPRINT_LENGTH = NUM_FRAMES * FEATURES_PER_FRAME + 2 // + attack/decay time

let cachedFFT: ReturnType<typeof createFFT> | null = null
let cachedHannWindow: Float32Array | null = null

function getFFT() {
  if (!cachedFFT) cachedFFT = createFFT(FFT_SIZE)
  return cachedFFT
}

function getHannWindow(): Float32Array {
  if (!cachedHannWindow) {
    const window = new Float32Array(FFT_SIZE)
    for (let i = 0; i < FFT_SIZE; i++) {
      window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)))
    }
    cachedHannWindow = window
  }
  return cachedHannWindow
}

/** Extracts a Hann-windowed frame starting at `startSample`, zero-padding past the array's edges. */
function extractFrame(mono: Float32Array, startSample: number): Float32Array {
  const window = getHannWindow()
  const frame = new Float32Array(FFT_SIZE)
  for (let i = 0; i < FFT_SIZE; i++) {
    const sourceIndex = startSample + i
    const sample = sourceIndex >= 0 && sourceIndex < mono.length ? mono[sourceIndex] : 0
    frame[i] = sample * window[i]
  }
  return frame
}

/** Computes the 10 spectral features (band ratios + centroid + flatness) for one frame. */
function computeFrameFeatures(frame: Float32Array, sampleRate: number, out: Float32Array, offset: number): void {
  const fft = getFFT()
  const re = frame.slice()
  const im = new Float32Array(FFT_SIZE)
  fft.transform(re, im)

  const halfSize = FFT_SIZE / 2
  const magnitude = new Float32Array(halfSize)
  let totalEnergy = 0
  for (let k = 0; k < halfSize; k++) {
    const mag = Math.hypot(re[k], im[k])
    magnitude[k] = mag
    totalEnergy += mag
  }

  const bandEdgeBins = BAND_EDGES_HZ.map((hz) => Math.round((hz / (sampleRate / 2)) * halfSize))

  let bandStart = 0
  for (let band = 0; band < NUM_BANDS; band++) {
    const bandEnd = band < bandEdgeBins.length ? Math.min(halfSize, bandEdgeBins[band]) : halfSize
    let bandEnergy = 0
    for (let k = bandStart; k < bandEnd; k++) bandEnergy += magnitude[k]
    out[offset + band] = totalEnergy > 0 ? bandEnergy / totalEnergy : 0
    bandStart = bandEnd
  }

  // Spectral centroid, normalized to [0, 1] by Nyquist.
  let weightedSum = 0
  for (let k = 0; k < halfSize; k++) weightedSum += k * magnitude[k]
  const centroidBin = totalEnergy > 0 ? weightedSum / totalEnergy : 0
  out[offset + NUM_BANDS] = centroidBin / halfSize

  // Spectral flatness: geometric mean / arithmetic mean of the magnitude spectrum.
  const epsilon = 1e-6
  let logSum = 0
  for (let k = 0; k < halfSize; k++) logSum += Math.log(magnitude[k] + epsilon)
  const geometricMean = Math.exp(logSum / halfSize)
  const arithmeticMean = totalEnergy / halfSize + epsilon
  out[offset + NUM_BANDS + 1] = geometricMean / arithmeticMean
}

/** Finds the first index (from `startSearch`) where the envelope crosses `targetRatio` of `peakAmplitude`. */
function findCrossing(
  mono: Float32Array,
  startSearch: number,
  step: 1 | -1,
  limit: number,
  peakAmplitude: number,
  targetRatio: number,
): number | null {
  const target = peakAmplitude * targetRatio
  for (let i = startSearch; step > 0 ? i < limit : i > limit; i += step) {
    if (Math.abs(mono[i]) <= target) return i
  }
  return null
}

/** Computes the two global temporal features: normalized attack time and decay time. */
function computeTemporalFeatures(mono: Float32Array, peakIndex: number, sampleRate: number): [number, number] {
  const peakAmplitude = Math.abs(mono[peakIndex])
  if (peakAmplitude === 0) return [0, 0]

  const searchBack = Math.max(0, peakIndex - Math.round(MAX_ATTACK_TIME_SECONDS * sampleRate))
  const tenPercentIndex = findCrossing(mono, peakIndex, -1, searchBack, peakAmplitude, 0.1)
  const attackSamples = tenPercentIndex !== null ? peakIndex - tenPercentIndex : peakIndex - searchBack
  const attackTime = Math.min(1, attackSamples / sampleRate / MAX_ATTACK_TIME_SECONDS)

  const searchForward = Math.min(mono.length, peakIndex + Math.round(MAX_DECAY_TIME_SECONDS * sampleRate))
  const twentyPercentIndex = findCrossing(mono, peakIndex, 1, searchForward, peakAmplitude, 0.2)
  const decaySamples = twentyPercentIndex !== null ? twentyPercentIndex - peakIndex : searchForward - peakIndex
  const decayTime = Math.min(1, decaySamples / sampleRate / MAX_DECAY_TIME_SECONDS)

  return [attackTime, decayTime]
}

/**
 * Computes the fixed-length timbre fingerprint of a shot centered at `peakIndex` within `mono`.
 * `peakIndex` should be the exact sample of the transient's peak amplitude.
 */
export function computeShotFingerprint(mono: Float32Array, sampleRate: number, peakIndex: number): Float32Array {
  const out = new Float32Array(FINGERPRINT_LENGTH)

  let offset = 0
  for (const offsetMs of ATTACK_FRAME_OFFSETS_MS) {
    const startSample = peakIndex + Math.round((offsetMs / 1000) * sampleRate)
    const frame = extractFrame(mono, startSample)
    computeFrameFeatures(frame, sampleRate, out, offset)
    offset += FEATURES_PER_FRAME
  }

  const tailStartSample = peakIndex + Math.round((TAIL_FRAME_OFFSET_MS / 1000) * sampleRate)
  const tailFrame = extractFrame(mono, tailStartSample)
  computeFrameFeatures(tailFrame, sampleRate, out, offset)
  offset += FEATURES_PER_FRAME

  const [attackTime, decayTime] = computeTemporalFeatures(mono, peakIndex, sampleRate)
  out[offset] = attackTime
  out[offset + 1] = decayTime

  return out
}

/**
 * Cosine similarity between two fingerprints, in [-1, 1] (in practice close to [0, 1] since all
 * features are non-negative). 1 means identical timbre shape, regardless of overall loudness.
 */
export function compareFingerprints(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0
  let normA = 0
  let normB = 0
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** Averages multiple fingerprints into one (used to combine several reference recordings of the same weapon). */
export function averageFingerprints(vectors: Float32Array[]): Float32Array {
  const out = new Float32Array(FINGERPRINT_LENGTH)
  if (vectors.length === 0) return out
  for (const vector of vectors) {
    for (let i = 0; i < FINGERPRINT_LENGTH; i++) out[i] += vector[i] / vectors.length
  }
  return out
}
