import type { AudioLike } from '../src/domain/audio/audioTypes'
import { categoryRecall, scoreDetections, type CategoryRecall, type DetectionScore } from '../src/domain/detection/detectionMetrics'
import { computeOnsetCurve } from '../src/domain/detection/onsetDetection'
import { detectShots, type ShotDetectionOptions } from '../src/domain/detection/shotDetection'
import type { Fixture } from './fixtures'

/**
 * The seam every experiment plugs into: anything that turns audio into shot timestamps can be
 * scored, so a candidate pipeline can be compared against the current one on identical fixtures.
 *
 * The fixture comes along because the production scheme is two-stage: the second stage needs the
 * clip's motion signals, which are keyed by slug. Audio alone can no longer describe the detector.
 */
export type Detector = (audio: AudioLike, fixture: Fixture) => number[]

export function createDefaultDetector(options: Partial<ShotDetectionOptions> = {}): Detector {
  return (audio) => detectShots(audio, computeOnsetCurve(audio), options).map((shot) => shot.time)
}

/** Tolerances (seconds) every run reports: the MIREX onset standard, plus a stricter timing check. */
export const TOLERANCES = { loose: 0.05, strict: 0.025 } as const

export interface ClipResult {
  slug: string
  clip: string
  duration: number
  /** Number of target shots — the ones the detector is supposed to find. */
  referenceCount: number
  /** Number of labeled non-target shots (enemy fire), which are scored neither way. */
  ignoredCount: number
  predictedCount: number
  loose: DetectionScore
  strict: DetectionScore
  categories: CategoryRecall[]
  /** Timestamps of detections with no matching label — open the clip here to see what fired. */
  falsePositiveTimes: number[]
  /** Timestamps of labeled shots the detector missed. */
  falseNegativeTimes: number[]
}

export interface AggregateResult {
  clipCount: number
  truePositives: number
  falsePositives: number
  falseNegatives: number
  precision: number
  recall: number
  f1: number
  /** Recall over every shot tagged as buried in noise, pooled across clips. */
  hardRecall: number
  hardTotal: number
  /** Detections that landed on non-target gunfire and were left unscored. */
  ignoredHits: number
  /** Labeled non-target shots available to absorb a detection. */
  ignoredTotal: number
}

export interface EvaluationResult {
  clips: ClipResult[]
  aggregate: AggregateResult
}

export function evaluateFixture(fixture: Fixture, detect: Detector): ClipResult {
  // Assistant goal: seed markers for the viewer's own gunfire. Enemy hits count as false positives
  // (the user must delete them); they are not ignored.
  const targets = fixture.labels.shots.filter((shot) => shot.source === 'own')
  const reference = targets.map((shot) => shot.time).sort((a, b) => a - b)
  const ignored: number[] = []
  const predicted = [...detect(fixture.audio, fixture)].sort((a, b) => a - b)

  const loose = scoreDetections(reference, predicted, TOLERANCES.loose, ignored)
  const strict = scoreDetections(reference, predicted, TOLERANCES.strict, ignored)

  return {
    slug: fixture.labels.slug,
    clip: fixture.labels.clip,
    duration: fixture.audio.duration,
    referenceCount: reference.length,
    ignoredCount: fixture.labels.shots.filter((shot) => shot.source !== 'own').length,
    predictedCount: predicted.length,
    loose,
    strict,
    categories: [categoryRecall('hard', loose.match, reference.length, (i) => targets[i].hard)],
    falsePositiveTimes: loose.falsePositiveIndices.map((index) => predicted[index]),
    falseNegativeTimes: loose.match.missedReferenceIndices.map((index) => reference[index]),
  }
}

/**
 * Pools counts across clips before computing the rates (a "micro" average) rather than averaging
 * each clip's F1: a 60-shot clip should weigh more than a 5-shot one.
 */
export function evaluateAll(fixtures: Fixture[], detect: Detector): EvaluationResult {
  const clips = fixtures.map((fixture) => evaluateFixture(fixture, detect))

  let truePositives = 0
  let falsePositives = 0
  let falseNegatives = 0
  let hardMatched = 0
  let hardTotal = 0
  let ignoredHits = 0
  let ignoredTotal = 0
  for (const clip of clips) {
    truePositives += clip.loose.truePositives
    falsePositives += clip.loose.falsePositives
    falseNegatives += clip.loose.falseNegatives
    ignoredHits += clip.loose.ignoredIndices.length
    ignoredTotal += clip.ignoredCount
    const hard = clip.categories.find((category) => category.label === 'hard')
    if (hard) {
      hardMatched += hard.matched
      hardTotal += hard.total
    }
  }

  const predictedTotal = truePositives + falsePositives
  const referenceTotal = truePositives + falseNegatives
  const precision = predictedTotal === 0 ? (referenceTotal === 0 ? 1 : 0) : truePositives / predictedTotal
  const recall = referenceTotal === 0 ? (predictedTotal === 0 ? 1 : 0) : truePositives / referenceTotal

  return {
    clips,
    aggregate: {
      clipCount: clips.length,
      truePositives,
      falsePositives,
      falseNegatives,
      precision,
      recall,
      f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
      hardRecall: hardTotal === 0 ? 1 : hardMatched / hardTotal,
      hardTotal,
      ignoredHits,
      ignoredTotal,
    },
  }
}
