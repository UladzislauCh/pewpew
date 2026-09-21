import { describe, expect, it } from 'vitest'
import { scoreDetections } from '../src/domain/detection/detectionMetrics'
import { computeOnsetCurve } from '../src/domain/detection/onsetDetection'
import { detectShots } from '../src/domain/detection/shotDetection'
import { burst, synthesizeSignal, type SignalSpec } from './synth'

const TOLERANCE = 0.05

function detect(spec: SignalSpec): number[] {
  const audio = synthesizeSignal(spec)
  return detectShots(audio, computeOnsetCurve(audio)).map((shot) => shot.time)
}

function score(spec: SignalSpec) {
  const reference = spec.shots.map((shot) => shot.time).sort((a, b) => a - b)
  return scoreDetections(reference, detect(spec), TOLERANCE)
}

describe('detection on clean signals', () => {
  it('finds an isolated shot with tight timing', () => {
    const result = score({ durationSeconds: 2, shots: [{ time: 1, amplitude: 0.9 }], seed: 11 })

    expect(result.truePositives).toBe(1)
    expect(result.falsePositives).toBe(0)
    expect(result.medianAbsDelta).toBeLessThan(0.005)
  })

  it('separates a five-round burst at AK-47 cadence', () => {
    const result = score({ durationSeconds: 2, shots: burst(0.4, 5, 0.1), seed: 12 })

    expect(result.recall).toBe(1)
    expect(result.falsePositives).toBe(0)
  })

  it('finds nothing in silence', () => {
    expect(detect({ durationSeconds: 2, shots: [] })).toEqual([])
  })

  it('finds nothing in a steady tone', () => {
    const predicted = detect({
      durationSeconds: 2,
      shots: [],
      tone: { amplitude: 0.3, frequencies: [220, 440] },
      seed: 5,
    })

    expect(predicted).toEqual([])
  })
})

describe('detection under interference', () => {
  it('still finds shots buried in broadband noise 20 dB down', () => {
    const result = score({
      durationSeconds: 3,
      shots: burst(0.5, 6, 0.35, 0.8),
      noiseAmplitude: 0.08,
      seed: 14,
    })

    expect(result.recall).toBe(1)
    expect(result.precision).toBe(1)
  })

  it('is not fooled by sustained tonal music', () => {
    const result = score({
      durationSeconds: 3,
      shots: burst(0.5, 4, 0.5, 0.9),
      tone: { amplitude: 0.12, frequencies: [110, 220, 440, 1320] },
      seed: 15,
    })

    expect(result.recall).toBe(1)
    expect(result.falsePositives).toBe(0)
  })

  it('finds nothing in stationary noise, at any level', () => {
    // No transients exist here at all. The clip-wide peak normalization used to guarantee that some
    // frame read 1.0, which cleared mean + 2.5σ on its own against a homogeneous curve.
    for (const noiseAmplitude of [0.01, 0.05, 0.2, 0.6]) {
      for (let seed = 1; seed <= 12; seed++) {
        expect(detect({ durationSeconds: 2, shots: [], noiseAmplitude, seed })).toEqual([])
      }
    }
  })

  it('finds quiet shots in a clip whose noise floor changes partway through', () => {
    const quiet = synthesizeSignal({
      durationSeconds: 3,
      shots: burst(0.4, 3, 0.4, 0.25),
      noiseAmplitude: 0.005,
      seed: 17,
    })
    const loud = synthesizeSignal({
      durationSeconds: 3,
      shots: burst(0.4, 3, 0.4, 0.95),
      noiseAmplitude: 0.15,
      seed: 18,
    })

    // Concatenate: three quiet shots, then three loud ones over a much higher noise floor.
    const samples = new Float32Array(quiet.length + loud.length)
    samples.set(quiet.getChannelData(0), 0)
    samples.set(loud.getChannelData(0), quiet.length)
    const audio = {
      sampleRate: quiet.sampleRate,
      length: samples.length,
      numberOfChannels: 1,
      duration: samples.length / quiet.sampleRate,
      getChannelData: () => samples,
    }

    const reference = [
      ...burst(0.4, 3, 0.4).map((shot) => shot.time),
      ...burst(0.4, 3, 0.4).map((shot) => shot.time + quiet.duration),
    ]
    const predicted = detectShots(audio, computeOnsetCurve(audio)).map((shot) => shot.time)

    expect(scoreDetections(reference, predicted, TOLERANCE).recall).toBe(1)
  })
})

/**
 * The stereo-width gate is REMOVED, and this is confirmed by measurement, not taken
 * on faith.
 *
 * It was deleted in commit 2c3c265 without explanation, but the tests for it remained
 * and were failing. The gate was restored and measured on 49 labeled clips — it hurts
 * at every threshold:
 *
 *   no gate        F1 50.5, precision 57.4, recall 45.1
 *   −20 dB         F1 49.5, precision 58.7, recall 42.8
 *   −17 dB         F1 48.1, precision 58.7, recall 40.8
 *   −15 dB         F1 45.9, precision 59.2, recall 37.5
 *   −13 dB         F1 39.4, precision 56.9, recall 30.2
 *
 * It raises precision by a point or so and drops recall by 2-15 points; in terms of
 * manual editing volume that's also a net loss. The original rationale ("gunfire is
 * wide, commentators are centered") doesn't reproduce on this set — probably because
 * the clips went through YouTube re-encoding and editing, both of which narrow the
 * stereo image.
 *
 * A neighboring gate from the same commit — convexity above the local background —
 * was checked the same way and RESTORED: it gives F1 50.8 vs 50.5 and is the only one
 * that closes off "detect nothing in stationary noise".
 */

/**
 * Gunfire repeats the same sample. Assistant defaults keep the largest fingerprint cluster.
 * When no pair clears the floor, `selfSimilarityWhenNoCluster` decides keep vs drop.
 */
describe('self-similarity gate', () => {
  it('keeps a burst of matching shots', () => {
    const result = score({ durationSeconds: 2, shots: burst(0.4, 5, 0.1), seed: 31 })

    expect(result.recall).toBe(1)
    expect(result.falsePositives).toBe(0)
  })

  it('keeps a single isolated shot, where peer matching cannot apply', () => {
    const result = score({ durationSeconds: 2, shots: [{ time: 1, amplitude: 0.9 }], seed: 32 })

    expect(result.truePositives).toBe(1)
  })

  it('keeps dissimilar pairs when no cluster forms (assistant default)', () => {
    const result = score({
      durationSeconds: 4,
      shots: [
        { time: 1, amplitude: 0.9, decaySeconds: 0.02 },
        { time: 3, amplitude: 0.5, decaySeconds: 0.08 },
      ],
      seed: 33,
    })
    expect(result.truePositives).toBeGreaterThanOrEqual(1)
  })

  it('can drop candidates when no pair clears the floor and whenNoCluster is drop', () => {
    const audio = synthesizeSignal({
      durationSeconds: 4,
      shots: [
        { time: 1, amplitude: 0.9, decaySeconds: 0.02 },
        { time: 3, amplitude: 0.5, decaySeconds: 0.08 },
      ],
      seed: 33,
    })
    // Threshold above any possible cosine similarity → no peer edges → drop path.
    const predicted = detectShots(audio, computeOnsetCurve(audio), {
      selfSimilarityThreshold: 1.1,
      selfSimilarityMinNeighbors: 1,
    }).map((shot) => shot.time)
    expect(predicted).toEqual([])
  })
})

describe('shots after a louder event', () => {
  /**
   * Peak-picking uses a sliding local mean+kσ threshold on the onset curve, not one clip-wide bar.
   * A loud explosion only raises the threshold while it sits inside the window; quieter fire
   * afterwards sees a normal local baseline and is still found.
   */
  it('keeps finding ordinary shots after a much louder explosion', () => {
    const result = score({
      durationSeconds: 4,
      shots: [
        { time: 0.5, amplitude: 1, decaySeconds: 0.4 },
        ...burst(2, 5, 0.15, 0.15),
      ],
      noiseAmplitude: 0.01,
      seed: 16,
    })

    expect(result.recall).toBe(1)
  })
})
