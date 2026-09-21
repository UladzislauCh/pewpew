import { describe, expect, it } from 'vitest'
import { categoryRecall, matchEvents, scoreDetections } from '../src/domain/detection/detectionMetrics'

/**
 * The scorer is the measuring instrument for every future change to the detector, so it gets
 * tested harder than the thing it measures — a silently wrong matcher would make every subsequent
 * experiment meaningless.
 */
describe('matchEvents', () => {
  it('pairs each reference with the prediction inside the tolerance', () => {
    const result = matchEvents([1, 2, 3], [1.01, 2.02, 2.99], 0.05)

    expect(result.matches.map((entry) => [entry.referenceIndex, entry.predictedIndex])).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ])
    expect(result.missedReferenceIndices).toEqual([])
    expect(result.spuriousPredictedIndices).toEqual([])
  })

  it('reports predictions outside the tolerance as spurious', () => {
    const result = matchEvents([1], [1.06], 0.05)

    expect(result.matches).toEqual([])
    expect(result.missedReferenceIndices).toEqual([0])
    expect(result.spuriousPredictedIndices).toEqual([0])
  })

  it('never matches one reference to two predictions', () => {
    const result = matchEvents([1], [0.99, 1.01], 0.05)

    expect(result.matches).toHaveLength(1)
    expect(result.spuriousPredictedIndices).toHaveLength(1)
  })

  it('finds the maximum number of pairs when greedy-by-distance would not', () => {
    // Matching the closest pair first would take (0.05, 0.04) and strand both remaining events;
    // the correct answer pairs 0 with 0.04 and 0.05 with 0.10.
    const result = matchEvents([0, 0.05], [0.04, 0.1], 0.05)

    expect(result.matches).toHaveLength(2)
    expect(result.missedReferenceIndices).toEqual([])
    expect(result.spuriousPredictedIndices).toEqual([])
  })

  it('keeps pairings in time order across a dense burst', () => {
    const reference = [0, 0.1, 0.2, 0.3, 0.4]
    const predicted = reference.map((time) => time + 0.02)

    const result = matchEvents(reference, predicted, 0.05)

    expect(result.matches.map((entry) => entry.referenceIndex)).toEqual([0, 1, 2, 3, 4])
    for (const entry of result.matches) expect(entry.deltaSeconds).toBeCloseTo(0.02, 6)
  })

  it('handles empty inputs on either side', () => {
    expect(matchEvents([], [], 0.05).matches).toEqual([])
    expect(matchEvents([1, 2], [], 0.05).missedReferenceIndices).toEqual([0, 1])
    expect(matchEvents([], [1, 2], 0.05).spuriousPredictedIndices).toEqual([0, 1])
  })
})

describe('scoreDetections', () => {
  it('computes precision, recall and F1 from the match', () => {
    // Two hits, one miss, one false alarm.
    const score = scoreDetections([1, 2, 3], [1.01, 2.01, 9], 0.05)

    expect(score.truePositives).toBe(2)
    expect(score.falseNegatives).toBe(1)
    expect(score.falsePositives).toBe(1)
    expect(score.precision).toBeCloseTo(2 / 3, 6)
    expect(score.recall).toBeCloseTo(2 / 3, 6)
    expect(score.f1).toBeCloseTo(2 / 3, 6)
  })

  it('reports timing error over matched pairs only', () => {
    const score = scoreDetections([1, 2, 3], [1.01, 2.03, 3.02], 0.05)

    expect(score.medianAbsDelta).toBeCloseTo(0.02, 6)
    expect(score.meanAbsDelta).toBeCloseTo(0.02, 6)
  })

  it('scores an empty clip with no detections as perfect', () => {
    const score = scoreDetections([], [], 0.05)

    expect(score.precision).toBe(1)
    expect(score.recall).toBe(1)
    expect(score.f1).toBe(1)
  })

  it('scores detections on a clip with no shots as zero precision', () => {
    const score = scoreDetections([], [1, 2], 0.05)

    expect(score.precision).toBe(0)
    expect(score.f1).toBe(0)
  })

  it('tightening the tolerance can only lose matches', () => {
    const reference = [1, 2, 3]
    const predicted = [1.01, 2.04, 3.001]

    expect(scoreDetections(reference, predicted, 0.05).truePositives).toBe(3)
    expect(scoreDetections(reference, predicted, 0.025).truePositives).toBe(2)
  })
})

describe('scoreDetections with non-target events', () => {
  it('charges nothing for a detection that lands on a non-target shot', () => {
    const score = scoreDetections([1], [1.01, 5.02], 0.05, [5])

    expect(score.truePositives).toBe(1)
    expect(score.falsePositives).toBe(0)
    expect(score.ignoredIndices).toEqual([1])
    expect(score.precision).toBe(1)
    expect(score.f1).toBe(1)
  })

  it('still charges for a detection that lands on neither', () => {
    const score = scoreDetections([1], [1.01, 5.02, 9], 0.05, [5])

    expect(score.falsePositives).toBe(1)
    expect(score.falsePositiveIndices).toEqual([2])
    expect(score.precision).toBeCloseTo(1 / 2, 6)
  })

  it('gives targets first refusal when a non-target sits within tolerance', () => {
    // A single detection between an own shot and an enemy shot has to count as finding the own one,
    // or a nearby enemy label could silently erase a true positive and depress recall.
    const score = scoreDetections([1], [1.02], 0.05, [1.04])

    expect(score.truePositives).toBe(1)
    expect(score.ignoredIndices).toEqual([])
    expect(score.recall).toBe(1)
  })

  it('absorbs every detection piled onto one non-target shot', () => {
    const score = scoreDetections([], [4.98, 5.0, 5.03], 0.05, [5])

    expect(score.falsePositives).toBe(0)
    expect(score.ignoredIndices).toEqual([0, 1, 2])
    expect(score.precision).toBe(1)
  })

  it('does not let a non-target absorb a missed target', () => {
    const score = scoreDetections([1, 5], [5.01], 0.05, [9])

    expect(score.truePositives).toBe(1)
    expect(score.falseNegatives).toBe(1)
    expect(score.recall).toBeCloseTo(1 / 2, 6)
  })
})

describe('categoryRecall', () => {
  it('measures a subset of the reference against the clip-wide match', () => {
    const reference = [1, 2, 3, 4]
    const predicted = [1.01, 3.01]
    const isHard = (index: number) => index === 1 || index === 3

    const match = scoreDetections(reference, predicted, 0.05).match
    const hard = categoryRecall('hard', match, reference.length, isHard)
    const easy = categoryRecall('easy', match, reference.length, (index) => !isHard(index))

    expect(hard).toMatchObject({ total: 2, matched: 0, recall: 0 })
    expect(easy).toMatchObject({ total: 2, matched: 2, recall: 1 })
  })

  it('treats an absent category as perfect rather than zero', () => {
    const match = scoreDetections([1], [1], 0.05).match

    expect(categoryRecall('hard', match, 1, () => false).recall).toBe(1)
  })
})
