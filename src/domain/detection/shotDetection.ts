import { compareFingerprints, computeShotFingerprint } from './audioFingerprint'
import { type AudioLike, toMono } from '../audio/audioTypes'
import type { OnsetAnalysis } from './onsetDetection'
import { hasWeaponTemplates, matchWeaponFingerprint, type WeaponMatch } from './weaponTemplates'

export interface DetectedShot {
  /** Precise timestamp (seconds) of the shot's transient peak. */
  time: number
  /** Onset strength (0-1) that triggered detection of this shot. */
  strength: number
  /** Peak sample amplitude near the shot, relative to the loudest point in the whole clip (0-1). */
  relativeLoudness: number
  /**
   * Best-guess weapon match from the reference template library, purely informational (shown in
   * the UI) — not used to reject candidates, since the fingerprint match alone proved too brittle
   * to gate on reliably. Present whenever at least one template exists (see
   * `weapon-samples/README.md`).
   */
  weaponMatch?: WeaponMatch
  /** Combined muzzle-flash + recoil ownership score from video verification (0–1). */
  videoScore?: number
  videoFlashScore?: number
  videoRecoilScore?: number
}

export interface ShotDetectionOptions {
  /**
   * How many robust standard deviations above the local median the onset curve must exceed to arm a
   * candidate. "Local" is the sliding causal window of `thresholdWindowSeconds`, not the whole clip,
   * so a loud explosion no longer raises the bar for quieter fire afterwards.
   */
  thresholdMultiplier: number
  /** Absolute floor for the adaptive threshold, so near-silent clips don't trigger on noise. */
  minThreshold: number
  /**
   * Width (seconds) of the causal (past-only) window the onset curve's local median and spread are
   * estimated over for peak-picking.
   */
  thresholdWindowSeconds: number
  /** Once armed, the curve must fall below (peak value * valleyRatio) before a new shot can be armed. */
  valleyRatio: number
  /**
   * Cosine-similarity floor a candidate must reach against the clip's dominant-weapon template to
   * survive (see `filterBySelfSimilarity`). Set to 0 to disable.
   *
   * Monotonic: raising it can only shrink the kept set.
   */
  selfSimilarityThreshold: number
  /** How many peers back the candidate that seeds the template, and how wide the template's core is. */
  selfSimilarityMinNeighbors: number
  /**
   * After gating, merge detections closer than this many seconds, keeping the stronger onset.
   * Kills echo / double-triggers around one transient without needing a fixed refractory in pickPeaks.
   * Set to 0 to disable. Stay below typical full-auto spacing (~0.09–0.1 s for AK).
   */
  minSeparationSeconds: number
  /**
   * How far (dB) a candidate's peak must stand above the sound level around it. 0 disables it.
   *
   * The gate was removed in commit 2c3c265 without explanation and restored after a measurement
   * showed the removal was a mistake: on 49 clips 6 dB gives F1 50.8 against 50.5 without the gate
   * and precision 58.4 against 57.4. The value was also chosen by measurement and matched the old
   * one: at 9 dB F1 drops to 45.7, at 12 to 29.0.
   *
   * Separately, it is the only thing that covers "find nothing in stationary noise": the onset curve
   * is normalised to the clip's own peak, so in pure noise the loudest ripple always becomes 1.0,
   * and a threshold on the normalised curve cannot express that. Prominence is measured in ABSOLUTE
   * terms — 48 false triggers out of 48 runs become zero.
   *
   * It is measured against the LOCAL background, not the loudest sample of the clip: otherwise a
   * single explosion or music hit raises the bar for all ordinary shots.
   */
  localProminenceDb: number
  /** Half-width (seconds) of the window the background level is taken over. */
  backgroundWindowSeconds: number
  /**
   * When false, skip the informational weapon-template label (expensive over eval sweeps; unused as a
   * hard gate either way).
   */
  matchWeaponTemplates: boolean
}

/**
 * Assistant defaults: seed markers for the viewer's own gunfire with as few user edits as possible.
 *
 * Tuned on the 49 labeled clips. `selfSimilarityThreshold` is the one knob worth moving — it trades
 * precision for recall monotonically, so lowering it surfaces more shots at the cost of more markers
 * to delete. 0.97 is both the F1 optimum and the optimum under any cost model that treats a missed
 * shot as at least as expensive as a spurious marker.
 */
export const DEFAULT_SHOT_DETECTION_OPTIONS: ShotDetectionOptions = {
  thresholdMultiplier: 2,
  // Carries real weight now that the adaptive term is robust: on a clean signal the interquartile
  // spread collapses to zero, so this floor — a fraction of the clip's own loudest onset — is the
  // only thing standing between the detector and every ripple in a quiet passage. Under the old
  // mean+kσ term it never once bound, which is why it sat at 0.02.
  minThreshold: 0.05,
  thresholdWindowSeconds: 3,
  valleyRatio: 0.3,
  selfSimilarityThreshold: 0.97,
  selfSimilarityMinNeighbors: 1,
  /**
   * Duplicate merging is on because re-arming produces duplicates all the time.
   *
   * `pickPeaks` disarms on a valley, not on time, and manages to arm a second time on the tail of
   * one transient: on synthetic data every shot was found TWICE — in its place with strength 1.0
   * and 3–7 ms later with strength around 0.1. The default profile — the one the labelling tool and
   * the wizard's emergency fallback run on — was handing these duplicates to the user.
   *
   * 20 ms was chosen by measurement: duplicates sit at 3–7 ms, echoes up to 30 ms, and the fifth
   * percentile of REAL intervals between own shots in the set is 31 ms. On 49 clips this gives
   * precision 57.4 against 54.5 at a cost of 0.6 points of recall, F1 49.7 → 50.5.
   */
  minSeparationSeconds: 0.02,
  localProminenceDb: 6,
  backgroundWindowSeconds: 0.5,
  matchWeaponTemplates: true,
}

/** Recall-first profile — high coverage, many false markers. */
export const RECALL_AUDIO_SHOT_DETECTION_OPTIONS: ShotDetectionOptions = {
  ...DEFAULT_SHOT_DETECTION_OPTIONS,
  valleyRatio: 0.3,
  selfSimilarityThreshold: 0,
}

/** Precision-first profile — fewer markers, more missed shots. */
export const PRECISION_AUDIO_SHOT_DETECTION_OPTIONS: ShotDetectionOptions = {
  ...DEFAULT_SHOT_DETECTION_OPTIONS,
  selfSimilarityThreshold: 0.98,
  minSeparationSeconds: 0.055,
}

/** Consistency factor turning an interquartile range back into a Gaussian-equivalent σ. */
const IQR_TO_SIGMA = 1.349

/**
 * Per-frame peak-picking threshold over a *causal* (past-only) window of the onset curve:
 * `max(minThreshold, median + k·σ̂)`, where `σ̂ = (P75 − P25) / 1.349` is estimated from quartiles.
 *
 * Robust statistics rather than mean/σ, because the events being detected are themselves the
 * loudest thing in the window. Mean and σ are both dragged upward by every shot that just fired, so
 * during sustained fire the detector raised its own bar until it went deaf: measured on the labeled
 * set, the threshold climbed from 0.18 to 0.50 as the preceding second went from silent to 8+ shots,
 * while the shots' own onset strength stayed flat — candidate recall fell from 89% to 47%. Quartiles
 * ignore the top of the distribution, so a burst no longer masks its own tail.
 *
 * Looking only at the past also means a rising transient is compared against the pre-attack floor
 * rather than a window that already contains the peak.
 *
 * Deliberately does *not* subtract or re-normalize the curve (those were tried and hurt F1 on the
 * labeled set); only the comparison bar moves.
 */
export function computeLocalThreshold(
  curve: Float32Array,
  windowFrames: number,
  multiplier: number,
  minThreshold: number,
): Float32Array {
  const threshold = new Float32Array(curve.length)
  const window = Math.max(1, windowFrames)
  const scratch = new Float32Array(window)

  // Quartiles need a populated window to mean anything. Near the clip's start there isn't enough
  // history, and a one- or two-frame window yields a zero spread, which drops the bar to the floor
  // for the whole warm-up — several seconds of audio at a realistic window width. Those frames
  // borrow the earliest full window instead. Strictly this peeks ahead, which is free here because
  // the whole clip is already decoded, and it beats judging the opening of a clip on no evidence.
  const warmUp = Math.min(curve.length, window)

  for (let i = 0; i < curve.length; i++) {
    const from = i >= window ? i - window : 0
    const to = i >= window ? i : warmUp
    const count = Math.max(1, to - from)

    const sample = scratch.subarray(0, count)
    for (let j = 0; j < count; j++) sample[j] = curve[from + j]
    sample.sort()

    const median = sample[count >> 1]
    const spread = (sample[Math.min(count - 1, (count * 3) >> 2)] - sample[count >> 2]) / IQR_TO_SIGMA

    threshold[i] = Math.max(minThreshold, median + multiplier * spread)
  }

  return threshold
}

const BACKGROUND_FRAME_SECONDS = 0.01

/**
 * Rolling background level: median RMS over a window around the moment.
 *
 * Median, not mean, so that the shots themselves — short and loud — do not inflate the background
 * they are compared against.
 */
function measureBackground(
  mono: Float32Array,
  sampleRate: number,
  halfWindowSeconds: number,
): (time: number) => number {
  const frameLength = Math.max(1, Math.round(BACKGROUND_FRAME_SECONDS * sampleRate))
  const frameCount = Math.max(1, Math.floor(mono.length / frameLength))

  const rms = new Float32Array(frameCount)
  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * frameLength
    const end = Math.min(mono.length, start + frameLength)
    let energy = 0
    for (let i = start; i < end; i++) energy += mono[i] * mono[i]
    rms[frame] = Math.sqrt(energy / Math.max(1, end - start))
  }

  const halfWindow = Math.max(1, Math.round(halfWindowSeconds / BACKGROUND_FRAME_SECONDS))
  const median = new Float32Array(frameCount)
  const scratch: number[] = []
  for (let frame = 0; frame < frameCount; frame++) {
    const from = Math.max(0, frame - halfWindow)
    const to = Math.min(frameCount, frame + halfWindow + 1)
    scratch.length = 0
    for (let i = from; i < to; i++) scratch.push(rms[i])
    scratch.sort((a, b) => a - b)
    median[frame] = scratch[scratch.length >> 1]
  }

  return (time) => {
    const frame = Math.round((time * sampleRate) / frameLength)
    return median[Math.min(frameCount - 1, Math.max(0, frame))]
  }
}

/**
 * Separates onset events by valleys rather than by a fixed time window: once the curve rises
 * above `threshold` we track its running peak, and only commit that peak as a distinct shot once
 * the curve has fallen back to a fraction (`valleyRatio`) of it. This adapts naturally to bursts
 * of rapid fire (fast valleys) as well as slow single shots (wide valleys), unlike a fixed
 * refractory period.
 *
 * `threshold` may be a single scalar or a per-frame curve of the same length as `curve` (local
 * adaptive thresholding).
 */
export function pickPeaks(
  curve: Float32Array,
  threshold: number | Float32Array,
  valleyRatio: number,
): number[] {
  const peaks: number[] = []
  let armed = false
  let bestIndex = -1
  let bestValue = -Infinity
  const thresholdAt = (i: number) => (typeof threshold === 'number' ? threshold : threshold[i])

  for (let i = 0; i < curve.length; i++) {
    const value = curve[i]
    if (!armed) {
      if (value > thresholdAt(i)) {
        armed = true
        bestIndex = i
        bestValue = value
      }
      continue
    }
    if (value > bestValue) {
      bestValue = value
      bestIndex = i
    }
    if (value < bestValue * valleyRatio) {
      peaks.push(bestIndex)
      armed = false
      bestValue = -Infinity
      bestIndex = -1
    }
  }
  if (armed && bestIndex >= 0) peaks.push(bestIndex)

  return peaks
}

/**
 * Refines an approximate onset time to the exact sample with the highest amplitude nearby.
 *
 * Also used by the labeling tool so hand-placed ground truth snaps to the transient itself rather
 * than to human click precision — otherwise reaction-time jitter of tens of milliseconds would
 * swamp the timing error we're trying to measure.
 */
export function refineToSamplePeak(
  mono: Float32Array,
  approxTime: number,
  sampleRate: number,
  searchRadiusSeconds: number,
): { time: number; amplitude: number } {
  const centerSample = Math.round(approxTime * sampleRate)
  const radius = Math.round(searchRadiusSeconds * sampleRate)
  const start = Math.max(0, centerSample - radius)
  const end = Math.min(mono.length, centerSample + radius)

  let peakIndex = centerSample
  let peakAmplitude = 0
  for (let i = start; i < end; i++) {
    const amplitude = Math.abs(mono[i])
    if (amplitude > peakAmplitude) {
      peakAmplitude = amplitude
      peakIndex = i
    }
  }

  return { time: peakIndex / sampleRate, amplitude: peakAmplitude }
}

/**
 * Finds gunshot-like transients: causal local-threshold peak picking over the onset curve, a gate
 * on transient prominence over the local background (`localProminenceDb`, 6 dB by default), then a
 * single self-similarity score against the clip's dominant weapon, then optional near-duplicate
 * merging.
 *
 * The prominence gate was once removed and later restored by measurement — see
 * `localProminenceDb`. The stereo-width gate was removed for good after measuring it on the
 * 49 labeled clips: it was worse than useless for this target. The viewer's own weapon is mixed
 * centre (median −13 dB side/mid) while the transients that actually survive to become false
 * positives are wider (−9.6 dB), so requiring a wide image threw away 32% of target shots to remove
 * 22% of enemy fire.
 *
 * Returns an empty array if nothing qualifies — callers should treat that as "no shot found".
 */
export function detectShots(
  audioBuffer: AudioLike,
  onset: OnsetAnalysis,
  options: Partial<ShotDetectionOptions> = {},
): DetectedShot[] {
  const opts = { ...DEFAULT_SHOT_DETECTION_OPTIONS, ...options }

  const curve = onset.onsetStrength
  if (curve.length === 0) return []

  const frameSeconds = onset.hopSize / onset.sampleRate
  const windowFrames = Math.max(1, Math.round(opts.thresholdWindowSeconds / frameSeconds))

  const threshold = computeLocalThreshold(
    curve,
    windowFrames,
    opts.thresholdMultiplier,
    opts.minThreshold,
  )

  const peakIndices = pickPeaks(curve, threshold, opts.valleyRatio)
  if (peakIndices.length === 0) return []

  const mono = toMono(audioBuffer)
  let globalPeakAmplitude = 0
  for (const value of mono) {
    const amplitude = Math.abs(value)
    if (amplitude > globalPeakAmplitude) globalPeakAmplitude = amplitude
  }
  if (globalPeakAmplitude === 0) return []

  const searchRadiusSeconds = onset.windowSize / onset.sampleRate / 2
  const backgroundAt =
    opts.localProminenceDb > 0
      ? measureBackground(mono, audioBuffer.sampleRate, opts.backgroundWindowSeconds)
      : null

  const matchTemplates = opts.matchWeaponTemplates && hasWeaponTemplates()

  const shots: DetectedShot[] = []
  const fingerprints: Float32Array[] = []
  for (const frameIndex of peakIndices) {
    const approxTime = onset.frameTimes[frameIndex]
    const { time, amplitude } = refineToSamplePeak(
      mono,
      approxTime,
      audioBuffer.sampleRate,
      searchRadiusSeconds,
    )

    if (backgroundAt) {
      const background = backgroundAt(time)
      const prominenceDb = 20 * Math.log10((amplitude + 1e-9) / (background + 1e-9))
      if (prominenceDb < opts.localProminenceDb) continue
    }
    const relativeLoudness = amplitude / globalPeakAmplitude
    const peakSampleIndex = Math.round(time * audioBuffer.sampleRate)
    const fingerprint = computeShotFingerprint(mono, audioBuffer.sampleRate, peakSampleIndex)

    let weaponMatch: WeaponMatch | undefined
    if (matchTemplates) {
      weaponMatch = matchWeaponFingerprint(fingerprint) ?? undefined
    }

    fingerprints.push(fingerprint)
    shots.push({ time, strength: curve[frameIndex], relativeLoudness, weaponMatch })
  }

  const clustered = filterBySelfSimilarity(shots, fingerprints, opts)
  return mergeCloseShots(clustered, opts.minSeparationSeconds).sort((a, b) => a.time - b.time)
}

/**
 * Keeps the candidates that sound like the clip's dominant weapon.
 *
 * Gunshots from one gun in one clip are near-copies of the same game sample; commentary, music and
 * crowd noise are not. That repetition is the only signal measured here that reaches useful
 * precision — every per-candidate feature tried (prominence, stereo width, raw fingerprint match)
 * tops out far lower — so the filter is built around it rather than around any single shot's timbre.
 *
 * The clip's own reference is derived in two steps: the candidate with the strongest peer support
 * seeds a template, which is the element-wise median of that seed and its closest peers (median so
 * one junk peer cannot drag the reference off the weapon). Every candidate is then scored against
 * that one template.
 *
 * Scoring against a shared reference, rather than keeping the largest connected component of a
 * similarity graph, is what makes this monotonic in `selfSimilarityThreshold`: raising the knob can
 * only shrink the kept set. Connected components were not monotonic — past 0.97 the graph fell apart,
 * every candidate survived unfiltered, and precision collapsed from 71% to 30%. Component membership
 * also discarded real shots that simply lacked one strong enough edge, at a measured cost of 17% of
 * all target shots.
 */
function filterBySelfSimilarity(
  shots: DetectedShot[],
  fingerprints: Float32Array[],
  opts: ShotDetectionOptions,
): DetectedShot[] {
  if (opts.selfSimilarityThreshold <= 0 || shots.length < 2) return shots

  const n = shots.length
  const similarity: Float32Array[] = Array.from({ length: n }, () => new Float32Array(n))
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const value = compareFingerprints(fingerprints[i], fingerprints[j])
      similarity[i][j] = value
      similarity[j][i] = value
    }
  }

  const core = findDominantCore(similarity, n)

  // Score every candidate against that core — including the core's own members, so the knob stays
  // the only thing deciding survival. Taking the Nth-best rather than the single best match means a
  // survivor has to resemble several separate firings, not just get lucky against one.
  const peers = Math.max(1, opts.selfSimilarityMinNeighbors)
  const scratch: number[] = []
  return shots.filter((_, index) => {
    scratch.length = 0
    for (const member of core) if (member !== index) scratch.push(similarity[index][member])
    if (scratch.length === 0) return true
    scratch.sort((a, b) => b - a)
    return scratch[Math.min(peers, scratch.length) - 1] >= opts.selfSimilarityThreshold
  })
}

/**
 * Cosine floor for *linking* two candidates into the same group. Deliberately strict and fixed: the
 * group is only ever used as a reference set, so a small pure core beats a large chained one, and
 * keeping it out of the options means `selfSimilarityThreshold` remains the single monotonic knob.
 */
const CORE_LINK_THRESHOLD = 0.975

/**
 * The largest mutually-consistent group of candidates — the viewer's own weapon in a POV clip, which
 * fires far more than anything else in frame. Junk transients link to nothing and form singletons.
 *
 * Falls back to the best-supported single candidate when nothing links, so the caller always has a
 * reference to score against and no clip escapes filtering entirely.
 */
function findDominantCore(similarity: Float32Array[], n: number): number[] {
  const adjacency: number[][] = Array.from({ length: n }, () => [])
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (similarity[i][j] >= CORE_LINK_THRESHOLD) {
        adjacency[i].push(j)
        adjacency[j].push(i)
      }
    }
  }

  const seen = new Array<boolean>(n).fill(false)
  let best: number[] = []
  for (let i = 0; i < n; i++) {
    if (seen[i]) continue
    seen[i] = true
    const stack = [i]
    const component = [i]
    while (stack.length > 0) {
      const u = stack.pop()!
      for (const v of adjacency[u]) {
        if (seen[v]) continue
        seen[v] = true
        stack.push(v)
        component.push(v)
      }
    }
    if (component.length > best.length) best = component
  }

  if (best.length > 1) return best

  let seed = 0
  let bestSupport = -Infinity
  for (let i = 0; i < n; i++) {
    let support = -Infinity
    for (let j = 0; j < n; j++) if (j !== i && similarity[i][j] > support) support = similarity[i][j]
    if (support > bestSupport) {
      bestSupport = support
      seed = i
    }
  }
  return [seed]
}

/** Keeps the stronger onset when two survivors land closer than `minSeparationSeconds`. */
function mergeCloseShots(shots: DetectedShot[], minSeparationSeconds: number): DetectedShot[] {
  if (minSeparationSeconds <= 0 || shots.length < 2) return shots
  const sorted = [...shots].sort((a, b) => a.time - b.time)
  const kept: DetectedShot[] = []
  for (const shot of sorted) {
    const conflict = kept.findIndex((other) => Math.abs(other.time - shot.time) < minSeparationSeconds)
    if (conflict < 0) {
      kept.push(shot)
      continue
    }
    if (shot.strength > kept[conflict].strength) kept[conflict] = shot
  }
  return kept
}
