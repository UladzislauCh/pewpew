/**
 * Trains the final motion classifier on ALL clips and exports the weights.
 *
 *   node eval/exportMotionModel.mjs
 *
 * Training here uses all data with no held-out set — this is a release build, not a
 * measurement. Honest numbers come from cross-validation in zoneFeatures.mjs (2.13x at w=0.5),
 * and the model from here should reproduce them, but quality must not be checked on it itself.
 *
 * Feature order is fixed in the `features` field — the production extractor must emit them
 * in exactly this order, otherwise the weights are meaningless.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadClips, pickPeaks, TOL_MS } from './shotNetLib.mjs'
import { matchDetectionsBurstAware } from '../src/lib/detection/score.ts'
import { fft } from '../src/lib/detection/fft.ts'

const ROOT = new URL('..', import.meta.url).pathname
const ZONE = join(ROOT, '.cache/zonemotion')
const WEAP = join(ROOT, '.cache/weaponmotion')
const OUT = join(ROOT, 'models/motionModel.json')

const CAND_THRESHOLD = 0.3
const HALF_MS = 250
const GRID = 3
const SPEC_N = 32

const raw = JSON.parse(readFileSync(join(ROOT, '.cache/cvcurves/curves.json'), 'utf8'))
const clips = loadClips()

function summarize(sig, f0, f1) {
  let sumAbs = 0, sum = 0, flips = 0, n = 0
  for (let f = f0; f <= f1; f++) {
    sumAbs += Math.abs(sig[f])
    sum += sig[f]
    if (f > f0 && Math.sign(sig[f]) !== Math.sign(sig[f - 1]) && sig[f] !== 0) flips++
    n++
  }
  const mean = sum / n
  let varSum = 0
  for (let f = f0; f <= f1; f++) varSum += (sig[f] - mean) ** 2
  return [sumAbs / n, Math.sqrt(varSum / n), flips / n]
}

/**
 * Trajectory shape: spectrum bands, jaggedness, signed mean.
 * It is the shape that tells firing from walking — by amplitude they do not separate
 * (AUC 0.430 on |dy|, i.e. when walking the weapon moves even more).
 */
function shape(sig, ctr, frames, fps) {
  const f0 = Math.max(1, Math.min(frames - SPEC_N - 1, ctr - (SPEC_N >> 1)))
  const re = new Float32Array(SPEC_N), im = new Float32Array(SPEC_N)
  let mean = 0
  for (let i = 0; i < SPEC_N; i++) mean += sig[f0 + i]
  mean /= SPEC_N
  for (let i = 0; i < SPEC_N; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (SPEC_N - 1)))
    re[i] = (sig[f0 + i] - mean) * w
    im[i] = 0
  }
  fft(re, im)
  const bins = SPEC_N >> 1
  const power = new Float64Array(bins)
  let total = 0
  for (let k = 0; k < bins; k++) { power[k] = re[k] * re[k] + im[k] * im[k]; total += power[k] }
  total = total || 1e-9
  const hz = fps / SPEC_N
  const band = (a, b) => { let e = 0; for (let k = 0; k < bins; k++) { const h = k * hz; if (h >= a && h < b) e += power[k] } return e / total }
  let d2 = 0, amp = 0
  for (let i = f0 + 1; i < f0 + SPEC_N - 1; i++) { d2 += Math.abs(sig[i + 1] - 2 * sig[i] + sig[i - 1]); amp += Math.abs(sig[i] - mean) }
  return [band(0, 3), band(3, 8), band(8, 16), d2 / Math.max(amp, 1e-6), mean]
}

const featureNames = []
for (let z = 0; z < GRID * GRID; z++) {
  for (const axis of ['dy', 'dx']) for (const stat of ['meanAbs', 'sd', 'flips']) featureNames.push(`cam.zone${z}.${axis}.${stat}`)
}
featureNames.push('cam.mismatch.meanAbs', 'cam.mismatch.sd', 'cam.mismatch.flips')
for (const axis of ['dy', 'dx']) for (const stat of ['meanAbs', 'sd', 'flips']) featureNames.push(`weapon.${axis}.${stat}`)
for (const axis of ['dy', 'dx']) for (const stat of ['band0_3', 'band3_8', 'band8_16', 'roughness', 'meanSigned']) featureNames.push(`weapon.${axis}.${stat}`)
featureNames.push('audioConfidence')

const samples = []
for (const c of clips) {
  const zp = join(ZONE, `${c.slug}.json`)
  const wp = join(WEAP, `${c.slug}.json`)
  if (!existsSync(zp) || !existsSync(wp)) continue

  const vs = JSON.parse(readFileSync(zp, 'utf8'))
  const wm = JSON.parse(readFileSync(wp, 'utf8'))
  const wdx = Float64Array.from(wm.dx)
  const wdy = Float64Array.from(wm.dy)
  const Z = vs.grid * vs.grid
  const dx = vs.dx.map((a) => Float64Array.from(a))
  const dy = vs.dy.map((a) => Float64Array.from(a))

  const curve = Float32Array.from(raw[c.slug])
  const times = pickPeaks(curve, c.frameRate, CAND_THRESHOLD)
  const { pairs } = matchDetectionsBurstAware(times, c.shots, TOL_MS, 200)
  const isOwn = new Array(times.length).fill(false)
  for (const pr of pairs) if (c.shots[pr.gtIndex].source === 'own') isOwn[pr.detIndex] = true

  const top = [], bottom = []
  for (let z = 0; z < Z; z++) {
    const row = (z / vs.grid) | 0
    if (row === 0) top.push(z)
    else if (row === vs.grid - 1) bottom.push(z)
  }

  for (let i = 0; i < times.length; i++) {
    const centre = Math.round(times[i] * vs.fps)
    const r = Math.max(2, Math.round((HALF_MS / 1000) * vs.fps))
    const f0 = Math.max(1, centre - r), f1 = Math.min(vs.frames - 1, centre + r)
    if (f1 - f0 < 4) continue

    const v = []
    for (let z = 0; z < Z; z++) v.push(...summarize(dy[z], f0, f1), ...summarize(dx[z], f0, f1))

    const mismatch = new Float64Array(vs.frames)
    for (let f = f0; f <= f1; f++) {
      let t = 0, b = 0
      for (const z of top) t += dy[z][f]
      for (const z of bottom) b += dy[z][f]
      mismatch[f] = b / bottom.length - t / top.length
    }
    v.push(...summarize(mismatch, f0, f1))

    // The weapon's own motion: summaries and trajectory shape.
    const wc = Math.round(times[i] * wm.fps)
    const wr = Math.max(2, Math.round((HALF_MS / 1000) * wm.fps))
    const wf0 = Math.max(1, wc - wr), wf1 = Math.min(wm.frames - 1, wc + wr)
    v.push(...summarize(wdy, wf0, wf1), ...summarize(wdx, wf0, wf1))
    v.push(...shape(wdy, wc, wm.frames, wm.fps), ...shape(wdx, wc, wm.frames, wm.fps))
    v.push(curve[Math.round(times[i] * c.frameRate)])

    samples.push({ v: Float64Array.from(v), y: isOwn[i] ? 1 : 0 })
  }
}

const DIM = featureNames.length
if (samples[0].v.length !== DIM) throw new Error(`признаков ${samples[0].v.length}, имён ${DIM}`)

const mu = new Float64Array(DIM), sd = new Float64Array(DIM)
for (const s of samples) for (let k = 0; k < DIM; k++) mu[k] += s.v[k]
for (let k = 0; k < DIM; k++) mu[k] /= samples.length
for (const s of samples) for (let k = 0; k < DIM; k++) sd[k] += (s.v[k] - mu[k]) ** 2
for (let k = 0; k < DIM; k++) sd[k] = Math.sqrt(sd[k] / samples.length) || 1
for (const s of samples) for (let k = 0; k < DIM; k++) s.v[k] = (s.v[k] - mu[k]) / sd[k]

const w = new Float64Array(DIM)
let b = 0
const nPos = samples.filter((s) => s.y === 1).length
const wPos = samples.length / (2 * nPos)
const wNeg = samples.length / (2 * (samples.length - nPos))
const gw = new Float64Array(DIM)
for (let it = 0; it < 600; it++) {
  gw.fill(0)
  let gb = 0, total = 0
  for (const s of samples) {
    let z = b
    for (let k = 0; k < DIM; k++) z += w[k] * s.v[k]
    const pr = 1 / (1 + Math.exp(-z))
    const cw = s.y === 1 ? wPos : wNeg
    const g = cw * (pr - s.y)
    for (let k = 0; k < DIM; k++) gw[k] += g * s.v[k]
    gb += g
    total += cw
  }
  const step = (0.5 / total) * (1 - it / 600)
  for (let k = 0; k < DIM; k++) w[k] -= step * (gw[k] + 0.05 * w[k])
  b -= step * gb
}

mkdirSync(join(ROOT, 'models'), { recursive: true })
writeFileSync(OUT, JSON.stringify({
  version: 1,
  note: 'Логистическая регрессия на признаках движения камеры и собственного движения модели оружия. Обучена на всех 49 клипах, без отложенной выборки — мерить качество на ней нельзя. Честная оценка кросс-валидацией: AUC 0.910, сокращение ручной работы 2.20x при w=0.5 и 1.75x при w=1.0.',
  params: { grid: GRID, halfMs: HALF_MS, candidateThreshold: CAND_THRESHOLD, frameSize: 384, specN: SPEC_N },
  features: featureNames,
  mean: Array.from(mu, (v) => +v.toFixed(6)),
  scale: Array.from(sd, (v) => +v.toFixed(6)),
  weights: Array.from(w, (v) => +v.toFixed(6)),
  bias: +b.toFixed(6),
}, null, 1))

const top = featureNames.map((n, i) => ({ n, w: w[i] })).sort((a, b2) => Math.abs(b2.w) - Math.abs(a.w))
console.log(`обучено на ${samples.length} кандидатах (свои ${nPos}), признаков ${DIM}`)
console.log(`сохранено: models/motionModel.json (${(JSON.stringify({ w: Array.from(w) }).length / 1024).toFixed(1)} КБ весов)`)
console.log()
console.log('самые весомые признаки:')
for (const t of top.slice(0, 8)) console.log(`  ${t.w >= 0 ? '+' : ''}${t.w.toFixed(3)}  ${t.n}`)
