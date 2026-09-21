import type { AudioLike } from '../../audio/audioTypes'
import { toMono } from '../../audio/audioTypes'
import type { DetectedShot } from '../shotDetection'
import { detectShotsWithNet, type DetectShotsOptions } from './detectShotsWithNet'
import { computeMelSpectrogram, normalizePerBand, DEFAULT_MEL_OPTIONS } from './melSpectrogram'
import { deserializeWeights, type ShotNetWeights } from './shotNet'
import { rankWithReference, referenceConfidence } from './refSimilarity'

/**
 * A wrapper around the convolutional detector matching the contract of the existing `detectShots`.
 *
 * It sits NEXT TO the old detector, not instead of it: all measurements were taken on a dataset
 * of 49 clips, and before giving up working code a comparison on live uploads is needed.
 *
 * How it differs from `detectShots`: there peaks are found on spectral flux, i.e. on "energy
 * changed here", and precision is capped at ~13% at full recall. Here the network outputs a
 * "shot here" score for each frame, and peaks are found on that.
 */

const WEIGHTS_URL = '/models/shotNet.json'

let weightsPromise: Promise<ShotNetWeights> | null = null

/** Weights (72 KB JSON) are loaded once and reused. */
export function loadShotNetWeights(url: string = WEIGHTS_URL): Promise<ShotNetWeights> {
  if (!weightsPromise) {
    weightsPromise = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`Не удалось загрузить веса: HTTP ${r.status}`)
        return r.text()
      })
      .then(deserializeWeights)
      .catch((e) => {
        weightsPromise = null // do not cache the failure, otherwise a retry is impossible
        throw e
      })
  }
  return weightsPromise
}

export interface NetDetectionResult {
  shots: DetectedShot[]
  /** The spectrogram is needed for rescoring with a reference — recomputing it is expensive. */
  spectrogram: ReturnType<typeof computeMelSpectrogram>
}

/**
 * Shot detection by the network. `strength` is filled with the network confidence (0..1) —
 * the very field the editor can use to draw label gradation.
 */
export async function detectShotsNet(
  audio: AudioLike,
  options: DetectShotsOptions = {},
): Promise<NetDetectionResult> {
  const weights = await loadShotNetWeights()
  const samples = toMono(audio)
  const { sampleRate } = audio

  const spectrogram = computeMelSpectrogram(samples, sampleRate, {
    ...DEFAULT_MEL_OPTIONS,
    ...options.mel,
  })
  normalizePerBand(spectrogram)

  const detected = detectShotsWithNet(samples, sampleRate, weights, options)

  // relativeLoudness is computed here: the editor and export rely on it.
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i])
    if (v > peak) peak = v
  }
  peak = peak || 1

  const half = Math.round(sampleRate * 0.01)
  const shots: DetectedShot[] = detected.map((d) => {
    const center = Math.round(d.time * sampleRate)
    let local = 0
    for (let i = Math.max(0, center - half); i < Math.min(samples.length, center + half); i++) {
      const v = Math.abs(samples[i])
      if (v > local) local = v
    }
    return { time: d.time, strength: d.confidence, relativeLoudness: local / peak }
  })

  return { shots, spectrogram }
}

export interface ReferenceResult {
  shots: DetectedShot[]
  /**
   * How sharply the similarities split. A low value means the hint does not work on this clip
   * and is better not applied — the spread across clips is huge (from 0.36 to 0.98 by
   * measurement), so it cannot be applied blindly.
   */
  confidence: number
}

/**
 * Rescoring labels after the user has pointed at one reference shot.
 *
 * It works because the reference is from THE SAME clip: reverb, mixing and compression are shared
 * between the reference and the shots being sought, so they cancel out. Matching against clean
 * weapon samples from another recording gave no separation.
 */
export function applyReference(
  spectrogram: NetDetectionResult['spectrogram'],
  shots: DetectedShot[],
  refTime: number,
): ReferenceResult {
  const ranked = rankWithReference(
    spectrogram,
    shots.map((s) => ({ time: s.time, confidence: s.strength })),
    refTime,
  )

  const byTime = new Map(ranked.map((r) => [r.time, r]))
  return {
    shots: shots.map((s) => {
      const r = byTime.get(s.time)
      // score adds network confidence and similarity; bring it back to 0..1,
      // because the editor treats strength as a fraction.
      return r ? { ...s, strength: Math.max(0, Math.min(1, r.score / 1.5)) } : s
    }),
    confidence: referenceConfidence(ranked),
  }
}
