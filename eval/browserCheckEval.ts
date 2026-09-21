/**
 * Analysis of the end-to-end check: does a pipeline computed ENTIRELY in the browser give the same numbers.
 *
 *   pnpm exec tsx eval/browserCheckEval.ts        # expects eval/.cache/browserCheck.json
 *
 * Two branches are compared on the same candidates, with one model and THE SAME weapon
 * series. There is exactly one difference — the source of camera motion:
 *
 *   REFERENCE — from the `frametool` cache. All the session's numbers rest on it.
 *   BROWSER   — from mediabunny/WebCodecs. This is what will be in the app.
 *
 * Weapon features are browser-computed in both branches — they were computed that way from the
 * start, there is nothing to check there. The first version of this check took weapon series from
 * different files (top-12 versus top-24) and changed two factors at once; that must not be done.
 *
 * Look at the bottom rows, not the top ones: decoder pixels are known to differ, and per-shift
 * series will diverge. The question is whether the divergence survives to the DECISION,
 * i.e. whether the labels the user sees change.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadAllFixtures, PROJECT_ROOT } from './fixtures'
import { loadClipMotion } from './motionCache'
import { toMono } from '../src/domain/audio/audioTypes'
import { detectShotsWithNet } from '../src/domain/detection/shotNet/detectShotsWithNet'
import { deserializeWeights } from '../src/domain/detection/shotNet/shotNet'
import {
  motionFeaturesAt,
  MOTION_PARAMS,
  type MotionModel,
  type WeaponMotion,
  type ZoneMotion,
} from '../src/domain/detection/motion/motionFeatures'
import { scoreDetections } from '../src/domain/detection/detectionMetrics'

const CACHE = join(PROJECT_ROOT, 'eval/.cache')
const TOLERANCE_S = 0.05
const FOLDS = 5
const SPARSE_MAX_OWN = 20
const DIFF_HALF_MS = 40

interface Series { frames: number; fps: number; dx: number[]; dy: number[]; resid: number[]; diff: number[] }
interface ClipOut {
  frames: number
  fps: number
  zone: { grid: number; frames: number; fps: number; dx: number[][]; dy: number[][] }
  weapon: Series
}

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b)
  return s[s.length >> 1] || 1
}

function asZone(z: ClipOut['zone']): ZoneMotion {
  return { grid: z.grid, frames: z.frames, fps: z.fps, dx: z.dx.map((a) => Float64Array.from(a)), dy: z.dy.map((a) => Float64Array.from(a)) }
}
function asWeapon(s: Series): WeaponMotion {
  return {
    frames: s.frames, fps: s.fps, band: { y0: 0, y1: 1 }, maskPx: 0,
    maskBox: { x0: 0, x1: 0, y0: 0, y1: 0 },
    dx: Float64Array.from(s.dx), dy: Float64Array.from(s.dy),
  }
}

/** Peak and mean of a series in a window — the same three features as in trainMotionModel. */
function windowOf(sig: number[], fps: number, time: number, halfMs: number): { peak: number; mean: number } | null {
  const centre = Math.round(time * fps)
  const r = Math.max(1, Math.round((halfMs / 1000) * fps))
  const f0 = Math.max(1, centre - r)
  const f1 = Math.min(sig.length - 1, centre + r)
  if (f1 < f0) return null
  let peak = -Infinity
  let sum = 0
  for (let f = f0; f <= f1; f++) { peak = Math.max(peak, sig[f]); sum += sig[f] }
  return { peak, mean: sum / (f1 - f0 + 1) }
}

/** Logistic regression — the same as in trainMotionModel. */
function train(rows: Float64Array[], y: number[]): { mean: Float64Array; scale: Float64Array; w: Float64Array; b: number } {
  const dim = rows[0].length
  const mean = new Float64Array(dim)
  const scale = new Float64Array(dim)
  const counts = new Float64Array(dim)
  for (const v of rows) for (let k = 0; k < dim; k++) if (!Number.isNaN(v[k])) { mean[k] += v[k]; counts[k]++ }
  for (let k = 0; k < dim; k++) mean[k] /= counts[k] || 1
  for (const v of rows) for (let k = 0; k < dim; k++) if (!Number.isNaN(v[k])) scale[k] += (v[k] - mean[k]) ** 2
  for (let k = 0; k < dim; k++) scale[k] = Math.sqrt(scale[k] / (counts[k] || 1)) || 1
  const X = rows.map((v) => {
    const o = new Float64Array(dim)
    for (let k = 0; k < dim; k++) o[k] = Number.isNaN(v[k]) ? 0 : (v[k] - mean[k]) / scale[k]
    return o
  })
  const w = new Float64Array(dim)
  let b = 0
  const nPos = y.filter((v) => v === 1).length
  const wPos = y.length / (2 * nPos)
  const wNeg = y.length / (2 * (y.length - nPos))
  const gw = new Float64Array(dim)
  const ITERS = 600
  for (let it = 0; it < ITERS; it++) {
    gw.fill(0)
    let gb = 0
    let total = 0
    for (let i = 0; i < X.length; i++) {
      let z = b
      for (let k = 0; k < dim; k++) z += w[k] * X[i][k]
      const p = 1 / (1 + Math.exp(-z))
      const cw = y[i] === 1 ? wPos : wNeg
      const g = cw * (p - y[i])
      for (let k = 0; k < dim; k++) gw[k] += g * X[i][k]
      gb += g
      total += cw
    }
    const step = (0.5 / total) * (1 - it / ITERS)
    for (let k = 0; k < dim; k++) w[k] -= step * (gw[k] + 0.05 * w[k])
    b -= step * gb
  }
  return { mean, scale, w, b }
}
const apply = (m: ReturnType<typeof train>, v: Float64Array): number => {
  let z = m.b
  for (let k = 0; k < v.length; k++) {
    const x = Number.isNaN(v[k]) ? m.mean[k] : v[k]
    z += m.w[k] * ((x - m.mean[k]) / m.scale[k])
  }
  return 1 / (1 + Math.exp(-z))
}

async function main(): Promise<void> {
  if (!existsSync(join(CACHE, 'browserCheck.json'))) {
    console.log('нет eval/.cache/browserCheck.json — сначала /eval/browserCheck.html')
    return
  }
  const browser = JSON.parse(await readFile(join(CACHE, 'browserCheck.json'), 'utf8')).clips as Record<string, ClipOut>
  const { fixtures } = await loadAllFixtures()
  const netWeights = deserializeWeights(await readFile(join(PROJECT_ROOT, 'public/models/shotNet.json'), 'utf8'))
  void ({} as MotionModel)

  interface Row { slug: string; time: number; y: number; sparse: boolean; ref: Float64Array | null; brw: Float64Array | null }
  const rows: Row[] = []
  const slugs: string[] = []
  const ownByClip = new Map<string, number[]>()
  let zoneCorr: number[] = []

  for (const f of fixtures) {
    const slug = f.labels.slug
    const b = browser[slug]
    const ref = await loadClipMotion(slug)
    if (!b || !ref) continue
    // Weapon series are shared by both branches: only the camera-motion source is isolated.
    const refWeapon = b.weapon
    slugs.push(slug)
    const own = f.labels.shots.filter((s) => s.source === 'own').map((s) => s.time).sort((a, b2) => a - b2)
    ownByClip.set(slug, own)
    const sparse = own.length <= SPARSE_MAX_OWN

    // How far the camera-motion series themselves diverged: correlation across all zones.
    const Z = ref.zone.grid * ref.zone.grid
    const bz = asZone(b.zone)
    let corrSum = 0
    let corrN = 0
    for (let z = 0; z < Z; z++) {
      const n = Math.min(ref.zone.frames, bz.frames)
      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0
      for (let i = 0; i < n; i++) {
        const x = ref.zone.dy[z][i], y = bz.dy[z][i]
        sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y
      }
      const num = n * sab - sa * sb
      const den = Math.sqrt((n * saa - sa * sa) * (n * sbb - sb * sb))
      if (den > 0) { corrSum += num / den; corrN++ }
    }
    if (corrN) zoneCorr.push(corrSum / corrN)

    const refScale = median(refWeapon.diff.filter((v) => v > 0))
    const brwScale = median(b.weapon.diff.filter((v) => v > 0))
    const refW = asWeapon(refWeapon)
    const brwW = asWeapon(b.weapon)

    for (const c of detectShotsWithNet(toMono(f.audio), f.audio.sampleRate, netWeights, {
      threshold: MOTION_PARAMS.candidateThreshold,
    })) {
      const y = own.some((t) => Math.abs(t - c.time) <= TOLERANCE_S) ? 1 : 0
      const build = (zone: ZoneMotion, weapon: WeaponMotion, series: Series, scale: number): Float64Array | null => {
        const base = motionFeaturesAt(zone, weapon, c.time, c.confidence)
        if (!base) return null
        const near = windowOf(series.diff, series.fps, c.time, DIFF_HALF_MS)
        const wide = windowOf(series.diff, series.fps, c.time, 250)
        const out = new Float64Array(base.length + 3)
        out.set(base, 0)
        out[base.length] = near ? near.peak / scale : NaN
        out[base.length + 1] = near && wide ? near.peak / Math.max(1e-6, wide.mean) : NaN
        out[base.length + 2] = near ? near.mean / scale : NaN
        return out
      }
      rows.push({
        slug, time: c.time, y, sparse,
        ref: build(ref.zone, refW, refWeapon, refScale),
        brw: build(bz, brwW, b.weapon, brwScale),
      })
    }
  }

  const foldOf = new Map(slugs.map((s, i) => [s, i % FOLDS]))
  const score: Record<'ref' | 'brw', number[]> = { ref: new Array(rows.length).fill(0), brw: new Array(rows.length).fill(0) }
  for (const side of ['ref', 'brw'] as const) {
    for (let k = 0; k < FOLDS; k++) {
      const idx = rows.map((_, i) => i).filter((i) => foldOf.get(rows[i].slug) !== k && rows[i][side])
      const m = train(idx.map((i) => rows[i][side]!), idx.map((i) => rows[i].y))
      rows.forEach((r, i) => { if (foldOf.get(r.slug) === k && r[side]) score[side][i] = apply(m, r[side]!) })
    }
  }

  const quality = (idx: number[], sc: number[]) => {
    const byClip = new Map<string, number[]>()
    for (const i of idx) if (sc[i] >= 0.5) byClip.set(rows[i].slug, [...(byClip.get(rows[i].slug) ?? []), rows[i].time])
    let tp = 0, fp = 0, fn = 0
    for (const slug of new Set(idx.map((i) => rows[i].slug))) {
      const s = scoreDetections(ownByClip.get(slug)!, (byClip.get(slug) ?? []).sort((a, b) => a - b), TOLERANCE_S)
      tp += s.truePositives; fp += s.falsePositives; fn += s.falseNegatives
    }
    const p = tp / Math.max(1, tp + fp), r = tp / Math.max(1, tp + fn)
    return { f1: (2 * p * r) / Math.max(1e-9, p + r), p, r, marks: tp + fp }
  }

  const all = rows.map((_, i) => i)
  const sparseIdx = all.filter((i) => rows[i].sparse)
  const denseIdx = all.filter((i) => !rows[i].sparse)

  console.log(`клипов ${slugs.length}, кандидатов ${rows.length}, своих ${rows.filter((r) => r.y === 1).length}`)
  zoneCorr.sort((a, b) => a - b)
  console.log(`корреляция рядов движения камеры: медиана ${zoneCorr[zoneCorr.length >> 1].toFixed(4)}, минимум ${zoneCorr[0].toFixed(4)}`)
  console.log()
  console.log('  ветка'.padEnd(38), 'F1'.padStart(7), 'точность'.padStart(9), 'полнота'.padStart(8), 'меток'.padStart(7))
  console.log('  ' + '-'.repeat(72))
  for (const [name, side] of [['эталон: камера из кэша frametool', 'ref'], ['браузер: всё из WebCodecs', 'brw']] as const) {
    const m = quality(all, score[side])
    console.log(`  ${name.padEnd(36)}`, (100 * m.f1).toFixed(1).padStart(7), (100 * m.p).toFixed(1).padStart(9), (100 * m.r).toFixed(1).padStart(8), String(m.marks).padStart(7))
  }
  console.log()
  console.log('  по половинам набора:'.padEnd(38), 'разреженные'.padStart(12), 'плотные'.padStart(9))
  for (const [name, side] of [['эталон', 'ref'], ['браузер', 'brw']] as const) {
    console.log(`  ${name.padEnd(36)}`, (100 * quality(sparseIdx, score[side]).f1).toFixed(1).padStart(12), (100 * quality(denseIdx, score[side]).f1).toFixed(1).padStart(9))
  }
  console.log()
  let agree = 0
  let both = 0
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].ref || !rows[i].brw) continue
    both++
    if ((score.ref[i] >= 0.5) === (score.brw[i] >= 0.5)) agree++
  }
  console.log(`решение при пороге 0.5 совпало на ${(100 * agree / both).toFixed(1)}% кандидатов (${both - agree} из ${both} разошлись)`)

  // Is the difference systematic. If the browser loses on about as many clips as it wins,
  // that is decoding noise, not a loss of quality.
  let better = 0
  let worse = 0
  let same = 0
  for (const slug of slugs) {
    const idx = all.filter((i) => rows[i].slug === slug)
    const r = quality(idx, score.ref).f1
    const b = quality(idx, score.brw).f1
    if (b > r + 0.001) better++
    else if (r > b + 0.001) worse++
    else same++
  }
  console.log(`по клипам: браузер лучше на ${better}, хуже на ${worse}, одинаково на ${same}`)
}

void main()
