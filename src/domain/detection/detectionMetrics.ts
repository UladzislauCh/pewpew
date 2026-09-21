/**
 * Scoring for the gunshot detector: matches detected timestamps against human-labeled ground truth
 * and reports precision/recall/F1 plus timing accuracy.
 *
 * Pure and DOM-free, so the same code backs both the offline evaluation harness and the live
 * readout in the labeling tool.
 */

export interface EventMatch {
  referenceIndex: number
  predictedIndex: number
  /** Signed offset (predicted − reference) in seconds. */
  deltaSeconds: number
}

export interface MatchResult {
  matches: EventMatch[]
  /** Indices into `reference` that no prediction covered (false negatives). */
  missedReferenceIndices: number[]
  /** Indices into `predicted` that matched no reference (false positives). */
  spuriousPredictedIndices: number[]
}

/**
 * Maximum-cardinality one-to-one matching between reference and predicted timestamps, where a pair
 * is eligible when it lands within `toleranceSeconds`.
 *
 * Both inputs must be sorted ascending. Each prediction's set of eligible references is then a
 * contiguous run whose bounds only move forward, which makes this a convex bipartite graph — so
 * sweeping predictions in time order and taking the earliest still-free eligible reference is
 * provably optimal. (Matching greedily by smallest offset instead is *not*: with reference
 * [0, 0.05] and predictions [0.04, 0.10] at a 50 ms tolerance it finds one pair where two exist,
 * which would understate the detector on exactly the dense bursts we care about.)
 */
export function matchEvents(
  reference: readonly number[],
  predicted: readonly number[],
  toleranceSeconds: number,
): MatchResult {
  const matches: EventMatch[] = []
  const referenceMatched = Array.from<boolean>({ length: reference.length }).fill(false)
  const predictedMatched = Array.from<boolean>({ length: predicted.length }).fill(false)

  // Lower bound of the eligible reference window; monotonically advances with the prediction time.
  let windowStart = 0

  for (let p = 0; p < predicted.length; p++) {
    const time = predicted[p]
    while (windowStart < reference.length && reference[windowStart] < time - toleranceSeconds) {
      windowStart++
    }
    for (let r = windowStart; r < reference.length; r++) {
      if (reference[r] > time + toleranceSeconds) break
      if (referenceMatched[r]) continue
      referenceMatched[r] = true
      predictedMatched[p] = true
      matches.push({ referenceIndex: r, predictedIndex: p, deltaSeconds: time - reference[r] })
      break
    }
  }

  const missedReferenceIndices: number[] = []
  for (let r = 0; r < reference.length; r++) if (!referenceMatched[r]) missedReferenceIndices.push(r)

  const spuriousPredictedIndices: number[] = []
  for (let p = 0; p < predicted.length; p++) if (!predictedMatched[p]) spuriousPredictedIndices.push(p)

  return { matches, missedReferenceIndices, spuriousPredictedIndices }
}

export interface DetectionScore {
  toleranceSeconds: number
  truePositives: number
  falsePositives: number
  falseNegatives: number
  precision: number
  recall: number
  f1: number
  /** Mean |predicted − reference| over matched pairs, in seconds; NaN when nothing matched. */
  meanAbsDelta: number
  /** Median |predicted − reference| over matched pairs, in seconds; NaN when nothing matched. */
  medianAbsDelta: number
  /** Indices into `predicted` that were scored as false positives. */
  falsePositiveIndices: number[]
  /** Indices into `predicted` that landed on a `ignored` event and so were left unscored. */
  ignoredIndices: number[]
  match: MatchResult
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

/**
 * Scores `predicted` against `reference` (the events we want found), treating `ignored` as neither
 * credit nor penalty.
 *
 * `ignored` exists because a clip contains real gunshots that aren't targets — enemy fire, when the
 * app only replaces the player's own weapon. Counting those as false positives would measure the
 * wrong thing entirely: it would reward a detector for going deaf to gunshots, and it makes a
 * mis-fire on crowd noise indistinguishable from a correct pickup of the wrong shooter's rifle.
 * Targets are matched first, so an own shot is never absorbed by a nearby enemy label.
 *
 * All three inputs must be sorted ascending.
 */
export function scoreDetections(
  reference: readonly number[],
  predicted: readonly number[],
  toleranceSeconds: number,
  ignored: readonly number[] = [],
): DetectionScore {
  const match = matchEvents(reference, predicted, toleranceSeconds)
  const truePositives = match.matches.length
  const falseNegatives = match.missedReferenceIndices.length

  // Absorption is many-to-one, unlike target matching: two detections on one enemy shot are still
  // both unjudged. Splitting a shot in two is a real defect, but it's a defect of coverage we
  // deliberately aren't measuring here, and charging for it would reintroduce the bias above.
  const falsePositiveIndices: number[] = []
  const ignoredIndices: number[] = []
  for (const index of match.spuriousPredictedIndices) {
    const time = predicted[index]
    const absorbed = ignored.some((event) => Math.abs(event - time) <= toleranceSeconds)
    ;(absorbed ? ignoredIndices : falsePositiveIndices).push(index)
  }
  const falsePositives = falsePositiveIndices.length

  // With nothing to find and nothing reported, the detector was perfectly right; the usual 0/0
  // convention of scoring that as zero would drag clip averages down for no reason.
  const judged = truePositives + falsePositives
  const precision = judged === 0 ? (reference.length === 0 ? 1 : 0) : truePositives / judged
  const recall = reference.length === 0 ? (judged === 0 ? 1 : 0) : truePositives / reference.length
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)

  const absDeltas = match.matches.map((entry) => Math.abs(entry.deltaSeconds))
  const meanAbsDelta =
    absDeltas.length === 0 ? Number.NaN : absDeltas.reduce((sum, value) => sum + value, 0) / absDeltas.length

  return {
    toleranceSeconds,
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1,
    meanAbsDelta,
    medianAbsDelta: median(absDeltas),
    falsePositiveIndices,
    ignoredIndices,
    match,
  }
}

export interface CategoryRecall {
  label: string
  total: number
  matched: number
  recall: number
}

/**
 * Recall restricted to a subset of the reference events (e.g. only the shots tagged as buried in
 * noise). The matching itself still runs over the whole clip — scoring a subset in isolation would
 * let predictions belonging to excluded shots stand in for the ones being measured.
 */
export function categoryRecall(
  label: string,
  match: MatchResult,
  referenceCount: number,
  belongsToCategory: (referenceIndex: number) => boolean,
): CategoryRecall {
  let total = 0
  for (let r = 0; r < referenceCount; r++) if (belongsToCategory(r)) total++

  let matched = 0
  for (const entry of match.matches) if (belongsToCategory(entry.referenceIndex)) matched++

  return { label, total, matched, recall: total === 0 ? 1 : matched / total }
}
