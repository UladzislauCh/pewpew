/**
 * Motion model training in TypeScript, validated with folds by clip.
 *
 *   pnpm exec tsx eval/trainMotionModel.ts              # compare schemes
 *   pnpm exec tsx eval/trainMotionModel.ts --export      # plus export weights of the best scheme
 *
 * Port of `eval/legacy/exportMotionModel.mjs`: standardisation, class weights, descent
 * with a decaying step and L2 — all as there, down to the number of iterations. There are
 * two differences, both deliberate.
 *
 * FIRST. Features are extracted by PRODUCTION code (`motionFeaturesAt`), not a copy of the
 * formulas. The legacy script duplicates `summarize` and `shape`, and any divergence from
 * prod would silently devalue the weights.
 *
 * SECOND. Legacy trained on all clips with no held-out set — that is a release build.
 * Here the default is validation with folds BY CLIP: a whole clip is either in training or
 * in test. Candidates within a clip are not independent, and splitting them apart would
 * measure peeking.
 *
 * Four schemes are compared, and the second exists precisely so that the gain from
 * retraining itself is not credited to the new region:
 *
 *   A — the model as currently shipped, no retraining;
 *   B — retrained on weapon features from the HEURISTIC region (control);
 *   C — retrained on weapon features from the HUMAN-LABELLED region;
 *   D — C plus frame-difference features inside that region.
 *
 * The human region lives in `eval/weaponRegions.json`, its series in
 * `eval/.cache/weaponSignals.json` (computed by the page `eval/weaponSignal.html`).
 */
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FIXTURES_DIR, PROJECT_ROOT, loadAllFixtures } from './fixtures'
import { loadClipMotion } from './motionCache'
import { toMono } from '../src/domain/audio/audioTypes'
import { detectShotsWithNet } from '../src/domain/detection/shotNet/detectShotsWithNet'
import { deserializeWeights } from '../src/domain/detection/shotNet/shotNet'
import {
  MOTION_FEATURE_NAMES,
  MOTION_PARAMS,
  motionFeaturesAt,
  scoreMotion,
  type MotionModel,
  type WeaponMotion,
} from '../src/domain/detection/motion/motionFeatures'
import { fieldFeaturesAt, frameAt, FIELD_FEATURE_NAMES } from '../src/domain/detection/motion/fieldFeatures'
import type { FieldSeries } from '../src/domain/detection/motion/weaponField'
import { scoreDetections } from '../src/domain/detection/detectionMetrics'

const TOLERANCE_S = 0.05
const FOLDS = 5
const SPARSE_MAX_OWN = 20
/** Window for frame-difference features. Narrow on purpose: at ±250 ms it catches neighbouring
 *  shots (median interval 88 ms), and AUC drops from 0.695 to 0.579. */
const DIFF_HALF_MS = 40

/** Names of the three extra features of scheme D. */
/** Frame offsets at which field features are taken: an alignment check. */
const FIELD_OFFSETS: readonly number[] = [-2, -1, 0, 1, 2]

const DIFF_FEATURE_NAMES = ['weaponBox.diff.peak', 'weaponBox.diff.local', 'weaponBox.diff.mean'] as const

interface Series { frames: number; fps: number; dx: number[]; dy: number[]; resid: number[]; diff: number[] }

interface Sample {
  slug: string
  time: number
  y: number
  sparse: boolean
  /** Features per scheme: indices follow the order of SCHEMES. */
  auto: Float64Array | null
  human: Float64Array | null
  diff: number[]
  /** Weapon-region field features at frame offsets −2…+2; null if the clip has no series. */
  field: (number[] | null)[]
  /** Production-path score on this candidate; NaN if not found. */
  prod: number
}

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b)
  return s[s.length >> 1] || 1
}

/** Series from the browser cache, fed to the production extractor as ordinary weapon motion. */
function asWeaponMotion(s: Series): WeaponMotion {
  return {
    frames: s.frames,
    fps: s.fps,
    band: { y0: 0, y1: 1 },
    maskPx: 0,
    maskBox: { x0: 0, x1: 0, y0: 0, y1: 0 },
    dx: Float64Array.from(s.dx),
    dy: Float64Array.from(s.dy),
  }
}

function windowOf(sig: number[], fps: number, time: number, halfMs: number): { peak: number; mean: number } | null {
  const centre = Math.round(time * fps)
  const r = Math.max(1, Math.round((halfMs / 1000) * fps))
  const f0 = Math.max(1, centre - r)
  const f1 = Math.min(sig.length - 1, centre + r)
  if (f1 < f0) return null
  let peak = -Infinity
  let sum = 0
  for (let f = f0; f <= f1; f++) {
    peak = Math.max(peak, sig[f])
    sum += sig[f]
  }
  return { peak, mean: sum / (f1 - f0 + 1) }
}

/** Logistic regression with class weights — ported from legacy, constants included. */
function train(rows: Float64Array[], y: number[]): { mean: Float64Array; scale: Float64Array; w: Float64Array; b: number } {
  const dim = rows[0].length
  const mean = new Float64Array(dim)
  const scale = new Float64Array(dim)
  const counts = new Float64Array(dim)

  // NaN does not take part in the statistics: it means "no data", not a value.
  for (const v of rows) for (let k = 0; k < dim; k++) if (!Number.isNaN(v[k])) { mean[k] += v[k]; counts[k]++ }
  for (let k = 0; k < dim; k++) mean[k] /= counts[k] || 1
  for (const v of rows) for (let k = 0; k < dim; k++) if (!Number.isNaN(v[k])) scale[k] += (v[k] - mean[k]) ** 2
  for (let k = 0; k < dim; k++) scale[k] = Math.sqrt(scale[k] / (counts[k] || 1)) || 1

  const X = rows.map((v) => {
    const out = new Float64Array(dim)
    for (let k = 0; k < dim; k++) out[k] = Number.isNaN(v[k]) ? 0 : (v[k] - mean[k]) / scale[k]
    return out
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

/** One-vs-rest AUC. Rank-based, with mean rank for ties. */
function auc(samples: Sample[], scores: number[], idx: number[]): number {
  const pos = idx.filter((i) => samples[i].y === 1)
  const neg = idx.filter((i) => samples[i].y === 0)
  if (!pos.length || !neg.length) return NaN
  const order = [...idx].sort((a, b) => scores[a] - scores[b])
  const rank = new Map<number, number>()
  for (let i = 0; i < order.length; ) {
    let j = i
    while (j + 1 < order.length && scores[order[j + 1]] === scores[order[i]]) j++
    const mean = (i + j + 2) / 2
    for (let k = i; k <= j; k++) rank.set(order[k], mean)
    i = j + 1
  }
  let sum = 0
  for (const i of pos) sum += rank.get(i)!
  return (sum - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length)
}

function extrasAtRecall(samples: Sample[], scores: number[], recall: number): number {
  const order = samples.map((_, i) => i).sort((a, b) => scores[b] - scores[a])
  const total = samples.filter((s) => s.y === 1).length
  let tp = 0
  let fp = 0
  for (const i of order) {
    if (samples[i].y === 1) tp++
    else fp++
    if (tp / total >= recall) return fp / Math.max(1, tp)
  }
  return fp / Math.max(1, tp)
}

async function main(): Promise<void> {
  const signals = JSON.parse(await readFile(join(PROJECT_ROOT, 'eval/.cache/weaponSignals.json'), 'utf8')).clips as Record<
    string,
    { human: Series | null }
  >
  const { fixtures } = await loadAllFixtures()
  const netWeights = deserializeWeights(await readFile(join(PROJECT_ROOT, 'public/models/shotNet.json'), 'utf8'))
  const shipped: MotionModel = JSON.parse(await readFile(join(FIXTURES_DIR, 'models/motionModel.json'), 'utf8'))

  // Field series are computed by PRODUCTION code on the page eval/motionScores.html — here
  // they are only read. There is deliberately no copy of the formulas: in the legacy script
  // the features were duplicated, and a divergence from prod would silently devalue the weights.
  const fieldByClip = new Map<string, { fps: number; series: FieldSeries; start: number }>()
  /** PRODUCTION-path score per candidate: block region, block weights, browser. */
  const prodByClip = new Map<string, { time: number; score: number }[]>()
  try {
    const cached = JSON.parse(await readFile(join(PROJECT_ROOT, 'eval/.cache/motionScores.json'), 'utf8')) as {
      slug: string
      fps: number
      field: Record<string, number[]> | null
      scores: { time: number; score: number }[]
    }[]
    // Time of the first video frame: field series live in VIDEO time, candidates in audio time.
    // The error here is exactly one frame, the feature peak sits on the candidate's frame, and the offset would smear it.
    const starts = JSON.parse(await readFile(join(PROJECT_ROOT, 'python/out/videoStart.json'), 'utf8')) as Record<
      string,
      { videoStart: number; audioStart: number }
    >
    for (const row of cached) {
      if (!row.field || !row.fps) continue
      const series = Object.fromEntries(
        Object.entries(row.field).map(([k, v]) => [k, Float64Array.from(v)]),
      ) as unknown as FieldSeries
      const st = starts[row.slug]
      fieldByClip.set(row.slug, { fps: row.fps, series, start: st ? st.videoStart - st.audioStart : 0 })
      prodByClip.set(row.slug, row.scores ?? [])
    }
  } catch {
    console.log('нет eval/.cache/motionScores.json — схема E будет пустой (см. eval/motionScores.html)')
  }

  const samples: Sample[] = []
  const ownByClip = new Map<string, number[]>()
  const slugs: string[] = []

  for (const f of fixtures) {
    const motion = await loadClipMotion(f.labels.slug)
    if (!motion) continue
    slugs.push(f.labels.slug)
    const own = f.labels.shots.filter((s) => s.source === 'own').map((s) => s.time).sort((a, b) => a - b)
    ownByClip.set(f.labels.slug, own)
    const sparse = own.length <= SPARSE_MAX_OWN

    const series = signals[f.labels.slug]?.human ?? null
    const humanWeapon = series ? asWeaponMotion(series) : null
    const diffScale = series ? median(series.diff.filter((v) => v > 0)) : 1

    for (const c of detectShotsWithNet(toMono(f.audio), f.audio.sampleRate, netWeights, {
      threshold: MOTION_PARAMS.candidateThreshold,
    })) {
      const auto = motionFeaturesAt(motion.zone, motion.weapon, c.time, c.confidence)
      if (!auto) continue
      const human = motionFeaturesAt(motion.zone, humanWeapon, c.time, c.confidence)

      // Three frame-difference features: peak in a narrow window, the same peak relative
      // to the local ±250 ms background, and the mean. The local background is needed because
      // the difference level depends on how fast the camera is being moved at that moment.
      let diff = [NaN, NaN, NaN]
      if (series) {
        const near = windowOf(series.diff, series.fps, c.time, DIFF_HALF_MS)
        const wide = windowOf(series.diff, series.fps, c.time, 250)
        if (near && wide) diff = [near.peak / diffScale, near.peak / Math.max(1e-6, wide.mean), near.mean / diffScale]
      }

      const fieldEntry = fieldByClip.get(f.labels.slug)
      // Candidates in Node and in the browser come from the same detector, but the score must
      // be looked up by time: the order does not always match, and one extra candidate would shift everything.
      let prod = NaN
      for (const row of prodByClip.get(f.labels.slug) ?? []) {
        if (Math.abs(row.time - c.time) <= 0.005) { prod = row.score; break }
      }
      samples.push({
        slug: f.labels.slug,
        time: c.time,
        y: own.some((t) => Math.abs(t - c.time) <= TOLERANCE_S) ? 1 : 0,
        sparse,
        auto,
        human,
        diff,
        // The feature peak sits on the candidate's frame and is narrow, so a one-frame
        // alignment error would smear it. Offsets are computed side by side so that this is
        // visible as a measurement, not an assumption.
        field: FIELD_OFFSETS.map((d) =>
          fieldEntry
            ? fieldFeaturesAt(fieldEntry.series, frameAt(c.time, fieldEntry.fps, fieldEntry.start) + d)
            : null,
        ),
        prod,
      })
    }
  }

  const build = (s: Sample, scheme: string): Float64Array => {
    if (scheme === 'B') return s.auto!
    // P and F — the trick from `eval/weaponRegionGain.ts`: the feature is put on top of the
    // current model's SCORE, and the honest baseline is the same regression on that score alone.
    // Otherwise the recalibration gain would be credited to the new features. This also removes
    // overfitting: 67 features instead of 140 on forty-five clips.
    if (scheme === 'P') return Float64Array.from([s.prod])
    if (scheme.startsWith('F')) {
      const field = s.field[FIELD_OFFSETS.indexOf(Number(scheme.slice(1)) || 0)]
      const out = new Float64Array(1 + FIELD_FEATURE_NAMES.length)
      out[0] = s.prod
      out.fill(NaN, 1)
      if (field) for (let i = 0; i < field.length; i++) out[1 + i] = field[i]
      return out
    }
    if (scheme === 'E') {
      // Field features on top of THE SAME features as scheme B: otherwise the gain would mix
      // with the gain from changing the region.
      const base = s.auto!
      const field = s.field[FIELD_OFFSETS.indexOf(0)]
      const out = new Float64Array(base.length + FIELD_FEATURE_NAMES.length)
      out.set(base, 0)
      // NaN where there are no series: `train` replaces them with the training-set mean, like
      // other gaps — zero would mean "the field is still", which is a different claim.
      out.fill(NaN, base.length)
      if (field) for (let i = 0; i < field.length; i++) out[base.length + i] = field[i]
      return out
    }
    const base = s.human ?? s.auto!
    if (scheme === 'C') return base
    const out = new Float64Array(base.length + DIFF_FEATURE_NAMES.length)
    out.set(base, 0)
    for (let i = 0; i < DIFF_FEATURE_NAMES.length; i++) out[base.length + i] = s.diff[i]
    return out
  }

  const foldOf = new Map(slugs.map((s, i) => [s, i % FOLDS]))
  const scores: Record<string, number[]> = {
    A: samples.map((s) => scoreMotion(shipped, s.auto!)),
    'B*': new Array(samples.length).fill(0),
    B: new Array(samples.length).fill(0),
    C: new Array(samples.length).fill(0),
    D: new Array(samples.length).fill(0),
    E: new Array(samples.length).fill(0),
    P: new Array(samples.length).fill(0),
    ...Object.fromEntries(FIELD_OFFSETS.map((d) => [`F${d}`, new Array(samples.length).fill(0)])),
  }

  for (const scheme of ['B', 'C', 'D', 'E', 'P', ...FIELD_OFFSETS.map((d) => `F${d}`)]) {
    for (let k = 0; k < FOLDS; k++) {
      const trainIdx = samples.map((_, i) => i).filter((i) => foldOf.get(samples[i].slug) !== k)
      const m = train(trainIdx.map((i) => build(samples[i], scheme)), trainIdx.map((i) => samples[i].y))
      samples.forEach((s, i) => {
        if (foldOf.get(s.slug) === k) scores[scheme][i] = apply(m, build(s, scheme))
      })
    }
  }

  const quality = (idx: number[], sc: number[]) => {
    const byClip = new Map<string, number[]>()
    for (const i of idx) if (sc[i] >= 0.5) byClip.set(samples[i].slug, [...(byClip.get(samples[i].slug) ?? []), samples[i].time])
    let tp = 0, fp = 0, fn = 0
    const clips = new Set(idx.map((i) => samples[i].slug))
    for (const slug of clips) {
      const s = scoreDetections(ownByClip.get(slug)!, (byClip.get(slug) ?? []).sort((a, b) => a - b), TOLERANCE_S)
      tp += s.truePositives; fp += s.falsePositives; fn += s.falseNegatives
    }
    const p = tp / Math.max(1, tp + fp), r = tp / Math.max(1, tp + fn)
    return { f1: (2 * p * r) / Math.max(1e-9, p + r), p, r, marks: tp + fp }
  }

  // Peeking control. The shipped model is trained on ALL clips and checked on the same
  // clips — its number is inflated, and the weights file itself says so ("do not measure
  // quality on it"). Scheme B*, trained the same way without a held-out set, shows how much
  // this peeking is worth: the gap between B* and B is the price of honest validation,
  // and A cannot be compared with B, C and D directly.
  {
    const m = train(samples.map((s) => build(s, 'B')), samples.map((s) => s.y))
    scores['B*'] = samples.map((s) => apply(m, build(s, 'B')))
  }

  const NAMES: Record<string, string> = {
    A: 'A — как отгружено сейчас',
    'B*': 'B* — эвристика, без отложенной',
    B: 'B — переобучено, область эвристики',
    C: 'C — переобучено, область человека',
    D: 'D — C + разница кадров',
    E: 'E — B + поле области оружия',
    P: 'P — оценка продуктового пути (база)',
    ...Object.fromEntries(FIELD_OFFSETS.map((d) => [
      `F${d}`, `F${d >= 0 ? '+' : ''}${d} — P + поле, сдвиг ${d >= 0 ? '+' : ''}${d} кадра`,
    ])),
  }
  const all = samples.map((_, i) => i)

  console.log(`клипов ${slugs.length}, кандидатов ${samples.length}, своих ${samples.filter((s) => s.y === 1).length}`)
  console.log(`с областью человека ${new Set(samples.filter((s) => s.human).map((s) => s.slug)).size} клипов, ` +
    `проверка ${FOLDS} фолдами по клипам`)
  console.log()
  console.log('  схема'.padEnd(36), 'F1'.padStart(7), 'точность'.padStart(9), 'полнота'.padStart(8),
    'меток'.padStart(7), 'AUC'.padStart(7), 'AUC в клипе'.padStart(12))
  console.log('  ' + '-'.repeat(90))
  for (const k of ['A', 'B*', 'B', 'C', 'D', 'E', 'P', ...FIELD_OFFSETS.map((d) => `F${d}`)]) {
    const m = quality(all, scores[k])
    const perClip = slugs
      .map((slug) => auc(samples, scores[k], all.filter((i) => samples[i].slug === slug)))
      .filter((v) => !Number.isNaN(v))
      .sort((a, b) => a - b)
    console.log(`  ${NAMES[k].padEnd(34)}`, (100 * m.f1).toFixed(1).padStart(7), (100 * m.p).toFixed(1).padStart(9),
      (100 * m.r).toFixed(1).padStart(8), String(m.marks).padStart(7),
      auc(samples, scores[k], all).toFixed(3).padStart(7),
      (perClip[perClip.length >> 1] ?? NaN).toFixed(3).padStart(12))
  }

  console.log()
  console.log('лишних меток на один свой выстрел:')
  console.log('  схема'.padEnd(36), 'полнота 90%'.padStart(12), '80%'.padStart(8), '70%'.padStart(8))
  console.log('  ' + '-'.repeat(66))
  for (const k of ['A', 'B*', 'B', 'C', 'D', 'E', 'P', ...FIELD_OFFSETS.map((d) => `F${d}`)]) {
    const at = (r: number) => extrasAtRecall(samples, scores[k], r).toFixed(2)
    console.log(`  ${NAMES[k].padEnd(34)}`, at(0.9).padStart(12), at(0.8).padStart(8), at(0.7).padStart(8))
  }

  // Ammo-counter clips are labelled PER FRAME and not by hand. Field features give a narrow
  // peak on the candidate's frame, and hand labels that drift by half a frame smear it.
  // If the gain shows up only here, the labels are the limit, not the features.
  let ammoSlugs = new Set<string>()
  try {
    const rows = JSON.parse(await readFile(join(PROJECT_ROOT, 'eval/.cache/ammoBrowser.json'), 'utf8')) as {
      slug: string
      covered: boolean
    }[]
    ammoSlugs = new Set(rows.filter((r) => r.covered).map((r) => r.slug))
  } catch { /* the ammo cache may be missing */ }
  if (ammoSlugs.size) {
    const idx = all.filter((i) => ammoSlugs.has(samples[i].slug))
    console.log()
    console.log(`только клипы со счётчиком (${ammoSlugs.size} шт., метки покадровые):`)
    console.log('  схема'.padEnd(36), 'F1'.padStart(7), 'AUC'.padStart(8), 'AUC в клипе'.padStart(12),
      'лишних при 80%'.padStart(15))
    console.log('  ' + '-'.repeat(82))
    for (const k of ['A', 'P', ...FIELD_OFFSETS.map((d) => `F${d}`)]) {
      const m = quality(idx, scores[k])
      const perClip = [...ammoSlugs]
        .map((slug) => auc(samples, scores[k], idx.filter((i) => samples[i].slug === slug)))
        .filter((v) => !Number.isNaN(v))
        .sort((a, b) => a - b)
      const sub = idx.map((i) => samples[i])
      const subScores = idx.map((i) => scores[k][i])
      console.log(`  ${NAMES[k].padEnd(34)}`, (100 * m.f1).toFixed(1).padStart(7),
        auc(samples, scores[k], idx).toFixed(3).padStart(8),
        (perClip[perClip.length >> 1] ?? NaN).toFixed(3).padStart(12),
        extrasAtRecall(sub, subScores, 0.8).toFixed(2).padStart(15))
    }
  }

  console.log()
  console.log('по половинам набора, F1 при пороге 0.5:')
  console.log('  схема'.padEnd(36), 'разреженные'.padStart(12), 'плотные'.padStart(9))
  console.log('  ' + '-'.repeat(58))
  for (const k of ['A', 'B*', 'B', 'C', 'D', 'E', 'P', ...FIELD_OFFSETS.map((d) => `F${d}`)]) {
    const sp = quality(all.filter((i) => samples[i].sparse), scores[k])
    const dn = quality(all.filter((i) => !samples[i].sparse), scores[k])
    console.log(`  ${NAMES[k].padEnd(34)}`, (100 * sp.f1).toFixed(1).padStart(12), (100 * dn.f1).toFixed(1).padStart(9))
  }

  if (process.argv.includes('--export')) {
    // Scheme C is exported — 74 features on signals from the selected blocks.
    //
    // Not D. On CONSISTENT top-12 signals (both shift and frame difference over the same blocks)
    // the three difference features add nothing: 62.3 vs 62.3, and on sparse clips they
    // drop 39.3 to 38.0. The gain D used to give came from the shift being computed over
    // top-24 and the difference over top-12: the difference feature was fixing someone else's
    // inaccuracy. Remove that, and it turns out to be redundant.
    const rows = samples.map((s) => build(s, 'C'))
    const m = train(rows, samples.map((s) => s.y))
    const names = [...MOTION_FEATURE_NAMES]
    const out = {
      version: 2,
      note:
        'Признаки оружия сняты в двенадцати блоках, отобранных классификатором blockModel.json, ' +
        'а не в полосе изменчивости. Обучено на всех клипах без отложенной выборки — мерить ' +
        'качество на этих весах нельзя; честная проверка фолдами: pnpm exec tsx eval/trainMotionModel.ts.',
      params: { ...shipped.params },
      features: names,
      mean: Array.from(m.mean, (v) => +v.toFixed(6)),
      scale: Array.from(m.scale, (v) => +v.toFixed(6)),
      weights: Array.from(m.w, (v) => +v.toFixed(6)),
      bias: +m.b.toFixed(6),
    }
    await writeFile(join(FIXTURES_DIR, 'models/motionModel.blocks.json'), JSON.stringify(out, null, 1))
    console.log('\nвеса выгружены в public/models/motionModel.blocks.json')
    const top = names.map((n, i) => ({ n, w: m.w[i] })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
    console.log('самые весомые признаки:')
    for (const t of top.slice(0, 10)) console.log(`  ${t.w >= 0 ? '+' : ''}${t.w.toFixed(3)}  ${t.n}`)
  }
}

void main()
