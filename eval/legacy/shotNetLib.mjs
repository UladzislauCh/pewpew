/**
 * Shared part of ShotNet training and evaluation: used both by the regular run
 * (trainShotNet.mjs) and by the learning curve (shotNetCurve.mjs).
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createWeights, forward, sigmoid } from '../src/lib/detection/shotNet.ts'
import { matchDetections } from '../src/lib/detection/score.ts'
import { backward, createAdamState, adamStep } from './shotNetBackward.mjs'
import { pickPeaks as pickPeaksProd } from '../src/lib/detection/detectShotsWithNet.ts'

const ROOT = new URL('..', import.meta.url).pathname
const LABELS = join(ROOT, 'labels')
const MEL = join(ROOT, '.cache/mel')

export const TOL_MS = 50
// Matches DEFAULT_DETECT_OPTIONS.minGapMs — the cycle of the fastest CS2 weapon.
// Anything closer physically cannot be a separate shot (see eval/sweepMinGap.mjs).
export const MIN_GAP_MS = 50

/** Reads spectrograms and builds per-frame targets. */
export function loadClips({ targetHalfWidth = 1, melDir = null } = {}) {
  const dir = melDir ? join(ROOT, melDir) : MEL
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  const clips = []
  for (const f of readdirSync(LABELS).filter((x) => x.endsWith('.json'))) {
    const label = JSON.parse(readFileSync(join(LABELS, f), 'utf8'))
    if (!label.complete) continue
    const specPath = join(dir, `${label.slug}.f32`)
    if (!existsSync(specPath) || !meta[label.slug]) continue

    const m = meta[label.slug]
    const buf = readFileSync(specPath)
    const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)

    const shots = (label.shots ?? []).filter((s) => s.source === 'own' || s.source === 'enemy')
    const target = new Float32Array(m.frames)
    for (const s of shots) {
      const c = Math.round(s.time * m.frameRate)
      for (let t = c - targetHalfWidth; t <= c + targetHalfWidth; t++) {
        if (t >= 0 && t < m.frames) target[t] = 1
      }
    }
    clips.push({ slug: label.slug, data, bands: m.bands, frames: m.frames, frameRate: m.frameRate, duration: label.duration, shots, target })
  }
  return clips
}

/**
 * Synthetic clips (eval/synthesize.mjs). Fit ONLY for training:
 * evaluating on them is pointless, because their labels are perfect by construction,
 * and what we care about is behaviour on real videos.
 */
export function loadSynthClips({ targetHalfWidth = 1, limit = Infinity } = {}) {
  const SYNTH = join(ROOT, '.cache/synth')
  if (!existsSync(join(SYNTH, 'meta.json'))) return []
  const meta = JSON.parse(readFileSync(join(SYNTH, 'meta.json'), 'utf8'))

  const clips = []
  for (const id of Object.keys(meta).sort()) {
    if (clips.length >= limit) break
    const specPath = join(SYNTH, `${id}.f32`)
    if (!existsSync(specPath)) continue
    const m = meta[id]
    const buf = readFileSync(specPath)
    const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)

    const target = new Float32Array(m.frames)
    for (const s of m.shots) {
      const c = Math.round(s.time * m.frameRate)
      for (let t = c - targetHalfWidth; t <= c + targetHalfWidth; t++) {
        if (t >= 0 && t < m.frames) target[t] = 1
      }
    }
    clips.push({ slug: id, data, bands: m.bands, frames: m.frames, frameRate: m.frameRate, duration: m.duration, shots: m.shots, target, synthetic: true })
  }
  return clips
}

/**
 * Augmented variants of real clips (eval/synthesize.mjs --mode=augment).
 * Each has a source field — the slug of the original clip. A variant may be used for training
 * ONLY if its original clip is not in the test set, otherwise the test video leaks into training.
 */
export function loadAugmentClips({ targetHalfWidth = 1 } = {}) {
  const AUG = join(ROOT, '.cache/augment')
  if (!existsSync(join(AUG, 'meta.json'))) return []
  const meta = JSON.parse(readFileSync(join(AUG, 'meta.json'), 'utf8'))

  const clips = []
  for (const id of Object.keys(meta).sort()) {
    const specPath = join(AUG, `${id}.f32`)
    if (!existsSync(specPath)) continue
    const m = meta[id]
    const buf = readFileSync(specPath)
    const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)

    const target = new Float32Array(m.frames)
    for (const s of m.shots) {
      const c = Math.round(s.time * m.frameRate)
      for (let t = c - targetHalfWidth; t <= c + targetHalfWidth; t++) {
        if (t >= 0 && t < m.frames) target[t] = 1
      }
    }
    clips.push({ slug: id, source: m.source, data, bands: m.bands, frames: m.frames, frameRate: m.frameRate, duration: m.duration, shots: m.shots, target, augmented: true })
  }
  return clips
}

export function makeRng(seed) {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

/**
 * Weights are returned from the LAST epoch. Picking "the best on test" is not allowed:
 * that is peeking at the held-out set and inflates the reported numbers.
 */
export function trainModel(config, trainClips, { epochs = 50, lr = 2e-3, weightDecay = 1e-4, seed = 1000, onEpoch = null, posWeightScale = 1 } = {}) {
  const rnd = makeRng(seed)
  const weights = createWeights(config, rnd)
  const adam = createAdamState(weights)

  let pos = 0, total = 0
  for (const c of trainClips) {
    for (let t = 0; t < c.frames; t++) { total++; if (c.target[t] === 1) pos++ }
  }
  // Positive frames are about 5%; without weighting the network simply learns "there are no shots".
  // But full balancing overshoots the other way: the model fires constantly.
  // posWeightScale allows weakening the weight (see eval/sweepPosWeight.mjs).
  const posWeight = ((total - pos) / Math.max(1, pos)) * posWeightScale

  for (let epoch = 0; epoch < epochs; epoch++) {
    let lossSum = 0
    const order = trainClips.map((_, i) => i).sort(() => rnd() - 0.5)

    for (const idx of order) {
      const c = trainClips[idx]
      const { activations } = forward(weights, c.data, c.frames)
      const logits = activations[activations.length - 1]

      const dLogits = new Float32Array(c.frames)
      let clipLoss = 0
      for (let t = 0; t < c.frames; t++) {
        const p = sigmoid(logits[t])
        const y = c.target[t]
        const cw = y === 1 ? posWeight : 1
        const pc = Math.min(Math.max(p, 1e-12), 1 - 1e-12)
        clipLoss += -cw * (y * Math.log(pc) + (1 - y) * Math.log(1 - pc))
        // Normalise by clip length, otherwise long videos outweigh short ones.
        dLogits[t] = (cw * (p - y)) / c.frames
      }
      lossSum += clipLoss / c.frames

      adamStep(weights, backward(weights, c.data, activations, dLogits, c.frames), adam, { lr, weightDecay })
    }

    if (onEpoch) onEpoch(epoch, lossSum / trainClips.length, weights)
  }

  return weights
}

/** Probability curves are computed once, then thresholds are swept over them. */
export function predictCurves(weights, clips) {
  return clips.map((c) => {
    const { activations } = forward(weights, c.data, c.frames)
    const logits = activations[activations.length - 1]
    const prob = new Float32Array(c.frames)
    for (let t = 0; t < c.frames; t++) prob[t] = sigmoid(logits[t])
    return prob
  })
}

/** Wrapper over the production function: eval must find peaks with exactly the same code. */
export function pickPeaks(prob, frameRate, threshold) {
  return pickPeaksProd(prob, frameRate, threshold, MIN_GAP_MS).map((p) => p.time)
}

export function evaluate(curves, clips, threshold) {
  let ownTotal = 0, ownTp = 0, allTotal = 0, allTp = 0, det = 0, fp = 0, minutes = 0
  for (let ci = 0; ci < clips.length; ci++) {
    const c = clips[ci]
    const times = pickPeaks(curves[ci], c.frameRate, threshold)
    const { pairs, falsePositives } = matchDetections(times, c.shots, TOL_MS)
    const matched = new Set(pairs.map((p) => p.gtIndex))

    det += times.length
    fp += falsePositives.length
    minutes += c.duration / 60
    for (let i = 0; i < c.shots.length; i++) {
      allTotal++
      if (matched.has(i)) allTp++
      if (c.shots[i].source === 'own') {
        ownTotal++
        if (matched.has(i)) ownTp++
      }
    }
  }
  return {
    ownRecall: ownTp / Math.max(1, ownTotal),
    allRecall: allTp / Math.max(1, allTotal),
    precision: allTp / Math.max(1, det),
    fpPerMin: fp / Math.max(1e-9, minutes),
    det,
  }
}

/**
 * Precision at a given recall on own shots.
 * The only metric by which runs are comparable: "recall at threshold 0.5" is meaningless,
 * because the threshold means different things for different models.
 */
export function precisionAtRecall(curves, clips, targetOwnRecall) {
  let best = null
  for (let thr = 0.02; thr < 0.995; thr += 0.02) {
    const m = evaluate(curves, clips, thr)
    if (m.ownRecall >= targetOwnRecall && (!best || m.precision > best.precision)) best = { ...m, threshold: thr }
  }
  return best
}
