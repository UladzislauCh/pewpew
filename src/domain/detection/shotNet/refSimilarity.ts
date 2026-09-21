import type { MelSpectrogram } from './melSpectrogram'

/**
 * Reference hint: the user points at one own shot, the rest are found by similarity.
 *
 * It works because the reference is taken FROM THE SAME clip. Matching against clean weapon
 * samples from another recording gave no separation (AUC 0.71) — reverb, mixing and compression
 * ate the timbre difference. Here all that interference is shared between the reference and the
 * shots being sought, so it cancels out.
 *
 * Measured on 45 clips: closeness to the reference as a feature gives AUC 0.743, and combined with
 * the network score it reduces the volume of manual edits more than either feature alone.
 */

export interface RefSimilarityOptions {
  /** Patch frames before the shot moment. */
  before?: number
  /** Frames after. By default covers both attack and decay. */
  after?: number
  /**
   * Tolerance for position inaccuracy, in frames. A label cannot be placed tick-perfect,
   * so similarity is taken as the max over a small shift.
   */
  jitter?: number
}

export const DEFAULT_REF_OPTIONS: Required<RefSimilarityOptions> = {
  before: 2,
  after: 12,
  jitter: 2,
}

/**
 * A spectrogram patch around a frame, normalised to unit length with zero mean.
 * Normalisation is mandatory: otherwise cosine measures loudness, not the shape of the event.
 */
export function patchAt(spec: MelSpectrogram, frame: number, opts: Required<RefSimilarityOptions>): Float32Array {
  const len = opts.before + opts.after + 1
  const out = new Float32Array(spec.bands * len)
  let p = 0
  for (let b = 0; b < spec.bands; b++) {
    for (let f = frame - opts.before; f <= frame + opts.after; f++) {
      const ff = Math.min(Math.max(f, 0), spec.frames - 1)
      out[p++] = spec.data[b * spec.frames + ff]
    }
  }
  let mean = 0
  for (const v of out) mean += v
  mean /= out.length
  let norm = 0
  for (let i = 0; i < out.length; i++) {
    out[i] -= mean
    norm += out[i] * out[i]
  }
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < out.length; i++) out[i] /= norm
  return out
}

function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** Similarity of a moment to a set of references: max over references and over a small shift. */
export function similarityAt(
  spec: MelSpectrogram,
  refs: Float32Array[],
  time: number,
  options: RefSimilarityOptions = {},
): number {
  const opts = { ...DEFAULT_REF_OPTIONS, ...options }
  const center = Math.round(time * spec.frameRate)
  let best = -1
  for (let d = -opts.jitter; d <= opts.jitter; d++) {
    const f = center + d
    if (f < 0 || f >= spec.frames) continue
    const patch = patchAt(spec, f, opts)
    for (const ref of refs) {
      const s = cosine(ref, patch)
      if (s > best) best = s
    }
  }
  return best
}

export interface RankedCandidate {
  time: number
  /** Network score, 0..1. */
  confidence: number
  /** Similarity to the reference, −1..1. NaN if there is no reference. */
  similarity: number
  /** Final score used for sorting and cutoff. */
  score: number
}

export interface RankOptions extends RefSimilarityOptions {
  /**
   * Weight of similarity in the final score. Measured: 0.5 gives the best result,
   * beyond that increasing the weight starts to hurt.
   */
  similarityWeight?: number
  /**
   * How many similar candidates to add to the reference automatically.
   * The user points at one shot, and the system expands the set by itself —
   * this consistently improves the result.
   */
  expandBy?: number
}

export const DEFAULT_RANK_OPTIONS: Required<Pick<RankOptions, 'similarityWeight' | 'expandBy'>> = {
  similarityWeight: 0.5,
  expandBy: 3,
}

/**
 * Recomputes candidate scores taking the user-specified reference into account.
 *
 * refTime is the moment of the shot the user pointed at. It need not coincide with a candidate:
 * the exact position is refined within the jitter tolerance.
 */
export function rankWithReference(
  spec: MelSpectrogram,
  candidates: { time: number; confidence: number }[],
  refTime: number,
  options: RankOptions = {},
): RankedCandidate[] {
  const opts = { ...DEFAULT_REF_OPTIONS, ...DEFAULT_RANK_OPTIONS, ...options }
  const refFrame = Math.round(refTime * spec.frameRate)
  const refs = [patchAt(spec, refFrame, opts)]

  // Self-enrichment: a few of the most similar candidates become additional references.
  if (opts.expandBy > 0 && candidates.length > 1) {
    const first = candidates
      .map((c) => ({ c, s: similarityAt(spec, refs, c.time, opts) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, opts.expandBy)
    for (const { c } of first) {
      refs.push(patchAt(spec, Math.round(c.time * spec.frameRate), opts))
    }
  }

  return candidates.map((c) => {
    const similarity = similarityAt(spec, refs, c.time, opts)
    return {
      time: c.time,
      confidence: c.confidence,
      similarity,
      score: c.confidence + opts.similarityWeight * similarity,
    }
  })
}

/**
 * How confidently similarities split into "similar" and "dissimilar".
 *
 * Needed so as not to apply the hint blindly: quality varies hugely across clips (from 0.36 to
 * 0.98), and the system must know which mode it is in. Computed without labels — from the gap
 * between large and small values relative to the overall spread.
 * Returns 0..1, higher means a sharper split.
 */
export function referenceConfidence(ranked: RankedCandidate[]): number {
  const sims = ranked.map((r) => r.similarity).filter((s) => Number.isFinite(s)).sort((a, b) => a - b)
  if (sims.length < 6) return 0

  const span = sims[sims.length - 1] - sims[0]
  if (span <= 1e-6) return 0

  // Otsu threshold: find the cut that best separates the values into two groups.
  let bestGap = 0
  for (let i = 1; i < sims.length; i++) {
    const lo = sims.slice(0, i)
    const hi = sims.slice(i)
    const mLo = lo.reduce((a, b) => a + b, 0) / lo.length
    const mHi = hi.reduce((a, b) => a + b, 0) / hi.length
    const between = (lo.length * hi.length * (mHi - mLo) ** 2) / (sims.length * sims.length)
    if (between > bestGap) bestGap = between
  }
  return Math.min(1, (4 * bestGap) / (span * span))
}
