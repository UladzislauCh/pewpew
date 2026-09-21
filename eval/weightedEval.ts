/**
 * Analysis of weighted features and a sweep of weighting schemes FROM THE CACHE, without touching video.
 *
 *   pnpm exec tsx eval/weightedEval.ts             # sweep weighting schemes
 *   pnpm exec tsx eval/weightedEval.ts --emit      # plus write eval/.cache/weaponSignals.json
 *                                            # (next: pnpm exec tsx eval/trainMotionModel.ts)
 *
 * The `blockDiffs.bin` cache was built for this script: the per-frame difference for every block
 * is on disk, so any weighting scheme is computed locally in seconds. Before, each such check
 * cost seven minutes of a browser run and broke if the laptop lid was closed.
 *
 * The weighting scheme is not a tuning detail. The rectangle used before is its extreme case:
 * weight 1 inside, 0 outside, and no difference between a block the classifier is sure about
 * and a block it hit by chance.
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PROJECT_ROOT } from './fixtures'

const CACHE = join(PROJECT_ROOT, 'eval/.cache')
const TOL = 0.05
const HALF_MS = 40
const SPARSE_MAX_OWN = 20

interface Series { frames: number; fps: number; dx: number[]; dy: number[]; resid: number[]; diff: number[] }

function auc(pos: number[], neg: number[]): number {
  if (pos.length < 3 || neg.length < 3) return NaN
  const all = [...pos.map((v) => [v, 1] as const), ...neg.map((v) => [v, 0] as const)].sort((a, b) => a[0] - b[0])
  let r = 0
  let i = 0
  while (i < all.length) {
    let j = i
    while (j < all.length && all[j][0] === all[i][0]) j++
    const a = (i + j + 1) / 2
    for (let k = i; k < j; k++) if (all[k][1]) r += a
    i = j
  }
  return (r - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length)
}
const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b)
  return s[s.length >> 1] || 1
}

/** Weighting schemes: how a block's probability turns into its weight. */
const SCHEMES: { name: string; weight: (_p: number[], i: number, ranked: number[]) => number }[] = [
  { name: 'прямоугольник (что было)', weight: (_p, i, r) => (r[i] >= 0.906 ? 1 : 0) },
  { name: 'сырая вероятность', weight: (_p, i) => _p[i] },
  { name: 'вероятность в квадрате', weight: (_p, i) => _p[i] ** 2 },
  { name: 'вероятность в кубе', weight: (_p, i) => _p[i] ** 3 },
  { name: 'ранг блока', weight: (_p, i, r) => r[i] },
  { name: 'ранг в кубе', weight: (_p, i, r) => r[i] ** 3 },
  { name: 'топ-24, взвешенно', weight: (p, i, r) => (r[i] >= 0.906 ? p[i] : 0) },
  { name: 'топ-12, взвешенно', weight: (p, i, r) => (r[i] >= 0.953 ? p[i] : 0) },
  { name: 'топ-48, взвешенно', weight: (p, i, r) => (r[i] >= 0.813 ? p[i] : 0) },
  { name: 'топ-12, БЕЗ весов', weight: (_p, i, r) => (r[i] >= 0.953 ? 1 : 0) },
  { name: 'топ-8, взвешенно', weight: (p, i, r) => (r[i] >= 0.969 ? p[i] : 0) },
  { name: 'топ-6, взвешенно', weight: (p, i, r) => (r[i] >= 0.977 ? p[i] : 0) },
  { name: 'топ-4, взвешенно', weight: (p, i, r) => (r[i] >= 0.985 ? p[i] : 0) },
  { name: 'топ-2, взвешенно', weight: (p, i, r) => (r[i] >= 0.992 ? p[i] : 0) },
]

function ranks(v: number[]): number[] {
  const order = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0])
  const out = new Array<number>(v.length).fill(0)
  order.forEach(([, i], k) => { out[i] = k / Math.max(1, v.length - 1) })
  return out
}

function peakAt(sig: number[], fps: number, time: number, halfMs = HALF_MS): number | null {
  const centre = Math.round(time * fps)
  const r = Math.max(1, Math.round((halfMs / 1000) * fps))
  const f0 = Math.max(1, centre - r)
  const f1 = Math.min(sig.length - 1, centre + r)
  if (f1 < f0) return null
  let peak = -Infinity
  for (let f = f0; f <= f1; f++) peak = Math.max(peak, sig[f])
  return peak
}

async function main(): Promise<void> {
  const need = ['blockDiffs.bin', 'blockDiffs.json', 'blockWeights.json', 'weightedSignals.json']
  for (const f of need) {
    if (!existsSync(join(CACHE, f))) {
      console.log(`нет eval/.cache/${f}`)
      console.log('Сначала: pnpm exec tsx eval/weightedPrep.ts, затем /eval/weighted.html, файлы положить в eval/.cache/')
      return
    }
  }

  const meta = JSON.parse(await readFile(join(CACHE, 'blockDiffs.json'), 'utf8')) as {
    grid: number
    scale: number
    index: { slug: string; frames: number; offset: number }[]
  }
  const bin = new Uint8Array(await readFile(join(CACHE, 'blockDiffs.bin')))
  const weights = JSON.parse(await readFile(join(CACHE, 'blockWeights.json'), 'utf8')).clips as Record<string, number[]>
  const signals = JSON.parse(await readFile(join(CACHE, 'weightedSignals.json'), 'utf8')).clips as Record<string, Series>
  const { entries } = JSON.parse(await readFile(join(PROJECT_ROOT, 'fixtures/__weighted/manifest.json'), 'utf8')) as {
    entries: { slug: string; duration: number; ownShots: number[]; candidates: { time: number; confidence: number }[] }[]
  }

  const nBlocks = meta.grid * meta.grid
  const byslug = new Map(meta.index.map((e) => [e.slug, e]))

  /** Weighted frame-difference series for a clip under the given scheme. */
  const seriesFor = (slug: string, w: number[]): number[] | null => {
    const e = byslug.get(slug)
    if (!e) return null
    const sum = w.reduce((a, b) => a + b, 0)
    if (sum <= 0) return null
    const out = new Array<number>(e.frames).fill(0)
    for (let f = 0; f < e.frames; f++) {
      let acc = 0
      const base = e.offset + f * nBlocks
      for (let b = 0; b < nBlocks; b++) acc += w[b] * bin[base + b]
      out[f] = acc / sum / meta.scale
    }
    return out
  }

  console.log(`клипов ${meta.index.length}, блоков ${nBlocks}, кэш ${(bin.length / 1024 / 1024).toFixed(1)} МБ`)
  console.log(`окно ±${HALF_MS} мс\n`)
  console.log('  схема взвешивания'.padEnd(30), 'AUC всё'.padStart(9), 'разреженные'.padStart(12), 'плотные'.padStart(9))
  console.log('  ' + '-'.repeat(62))

  let best = { name: '', auc: 0, w: null as null | ((slug: string) => number[]) }
  for (const scheme of SCHEMES) {
    const pos: number[] = [], neg: number[] = []
    const posS: number[] = [], negS: number[] = [], posD: number[] = [], negD: number[] = []
    for (const e of entries) {
      const p = weights[e.slug]
      const sig = signals[e.slug]
      if (!p || !sig) continue
      const r = ranks(p)
      const w = p.map((_, i) => scheme.weight(p, i, r))
      const series = seriesFor(e.slug, w)
      if (!series) continue
      const scale = median(series.filter((v) => v > 0))
      const sparse = e.ownShots.length <= SPARSE_MAX_OWN
      for (const c of e.candidates) {
        const peak = peakAt(series, sig.fps, c.time)
        if (peak === null) continue
        const v = peak / scale
        const own = e.ownShots.some((t) => Math.abs(t - c.time) <= TOL)
        ;(own ? pos : neg).push(v)
        if (sparse) (own ? posS : negS).push(v)
        else (own ? posD : negD).push(v)
      }
    }
    const a = auc(pos, neg)
    console.log(`  ${scheme.name.padEnd(28)}`, a.toFixed(3).padStart(9), auc(posS, negS).toFixed(3).padStart(12), auc(posD, negD).toFixed(3).padStart(9))
    if (a > best.auc) best = { name: scheme.name, auc: a, w: (slug) => { const p = weights[slug]; const r = ranks(p); return p.map((_, i) => scheme.weight(p, i, r)) } }
  }
  console.log(`\nлучшая схема: «${best.name}», AUC ${best.auc.toFixed(3)}`)
  console.log('для сравнения: рамка человека 0.695, рамка автопоиска — эта же таблица, строка «прямоугольник»')

  if (process.argv.includes('--emit') && best.w) {
    // Shift and residual come from the browser pass: they cannot be recovered from the cache.
    // The frame-difference series comes from the best weighting scheme.
    const out: Record<string, { human: Series; auto: null; note: string }> = {}
    for (const e of entries) {
      const sig = signals[e.slug]
      if (!sig) continue
      const series = seriesFor(e.slug, best.w(e.slug))
      out[e.slug] = {
        human: { ...sig, diff: series ? series.map((v) => +v.toFixed(3)) : sig.diff },
        auto: null,
        note: `карта весов, схема «${best.name}»`,
      }
    }
    await writeFile(join(CACHE, 'weaponSignals.json'), JSON.stringify({ boxSize: 0, maxShift: 8, clips: out }))
    console.log('\nзаписано eval/.cache/weaponSignals.json — дальше pnpm exec tsx eval/trainMotionModel.ts')
  }
}

void main()
