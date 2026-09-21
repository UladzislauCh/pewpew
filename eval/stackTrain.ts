/**
 * Do the pixels carry what the 74 summaries lack.
 *
 *   pnpm exec tsx eval/stackTrain.ts     # expects eval/.cache/stacks.bin
 *
 * It starts NOT with a convolutional network but with the cheapest test of the same hypothesis.
 *
 * Hypothesis: the current features — summaries of rigid shifts over a window — erase at once
 * WHAT changed, WHERE inside the region and AT WHAT moment. If that is the problem, then plain
 * SPATIAL resolution of the frame difference should already give a gain: the same logistic
 * regression, but the feature is a grid of means instead of a single mean over the region.
 *
 * The point of the order is this. A convolutional network on 4808 examples in pure TypeScript
 * means hours of compute, and it is worth taking on only if the cheap test shows there is
 * information in the pixels at all. If a grid of means does not beat 62.1, the pixels are not
 * the point, and a network will not find it there.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadAllFixtures, PROJECT_ROOT } from './fixtures'
import { loadClipMotion } from './motionCache'
import { motionFeaturesAt, type WeaponMotion } from '../src/domain/detection/motion/motionFeatures'
import { scoreDetections } from '../src/domain/detection/detectionMetrics'

const CACHE = join(PROJECT_ROOT, 'eval/.cache')
const TOL = 0.05
const FOLDS = 5
const SPARSE = 20
const TH = 0.5

interface Index { slug: string; time: number; confidence: number; offset: number }

function fit(X: Float64Array[], y: number[], l2: number) {
  const dim = X[0].length
  const w = new Float64Array(dim)
  let b = 0
  const nPos = y.filter((v) => v === 1).length || 1
  const wP = y.length / (2 * nPos)
  const wN = y.length / (2 * Math.max(1, y.length - nPos))
  const gw = new Float64Array(dim)
  for (let it = 0; it < 400; it++) {
    gw.fill(0)
    let gb = 0
    let tot = 0
    for (let i = 0; i < X.length; i++) {
      let z = b
      for (let k = 0; k < dim; k++) z += w[k] * X[i][k]
      const p = 1 / (1 + Math.exp(-z))
      const cw = y[i] === 1 ? wP : wN
      const g = cw * (p - y[i])
      for (let k = 0; k < dim; k++) gw[k] += g * X[i][k]
      gb += g
      tot += cw
    }
    const st = (0.5 / tot) * (1 - it / 400)
    for (let k = 0; k < dim; k++) w[k] -= st * (gw[k] + l2 * w[k])
    b -= st * gb
  }
  return (v: Float64Array) => {
    let z = b
    for (let k = 0; k < v.length; k++) z += w[k] * v[k]
    return 1 / (1 + Math.exp(-z))
  }
}

/** Grid of mean absolute differences of adjacent frames: grid x grid per pair. */
function gridDiff(stack: Uint8Array, frames: number, size: number, grid: number): number[] {
  const cell = size / grid
  const out: number[] = []
  for (let f = 1; f < frames; f++) {
    const a = (f - 1) * size * size
    const b = f * size * size
    const sums = new Float64Array(grid * grid)
    const counts = new Float64Array(grid * grid)
    for (let yy = 0; yy < size; yy++) {
      const gy = Math.min(grid - 1, Math.floor(yy / cell))
      for (let xx = 0; xx < size; xx++) {
        const gx = Math.min(grid - 1, Math.floor(xx / cell))
        const g = gy * grid + gx
        sums[g] += Math.abs(stack[a + yy * size + xx] - stack[b + yy * size + xx])
        counts[g]++
      }
    }
    for (let g = 0; g < grid * grid; g++) out.push(sums[g] / Math.max(1, counts[g]))
  }
  return out
}

/**
 * The same, but AFTER compensating with the best shift.
 *
 * The raw difference mixes two things: how the whole region moved (camera plus sway) and how
 * the look inside it changed. The first is already described by 54 zone features, the second
 * is the new thing this was all about: bolt travel, ejection port, barrel glow.
 * Without compensation what gets tested is not the hypothesis but its mix with what is already known.
 */
function gridResidual(stack: Uint8Array, frames: number, size: number, grid: number, maxShift = 3): number[] {
  const cell = size / grid
  const out: number[] = []
  for (let f = 1; f < frames; f++) {
    const a = (f - 1) * size * size
    const b = f * size * size
    let best = Infinity
    let bdx = 0
    let bdy = 0
    for (let sy = -maxShift; sy <= maxShift; sy++) {
      for (let sx = -maxShift; sx <= maxShift; sx++) {
        let sum = 0
        let n = 0
        for (let yy = Math.max(0, -sy); yy < Math.min(size, size - sy); yy += 2) {
          for (let xx = Math.max(0, -sx); xx < Math.min(size, size - sx); xx += 2) {
            sum += Math.abs(stack[a + (yy + sy) * size + (xx + sx)] - stack[b + yy * size + xx])
            n++
          }
        }
        if (n && sum / n < best) { best = sum / n; bdx = sx; bdy = sy }
      }
    }
    const sums = new Float64Array(grid * grid)
    const counts = new Float64Array(grid * grid)
    for (let yy = Math.max(0, -bdy); yy < Math.min(size, size - bdy); yy++) {
      const gy = Math.min(grid - 1, Math.floor(yy / cell))
      for (let xx = Math.max(0, -bdx); xx < Math.min(size, size - bdx); xx++) {
        const g = gy * grid + Math.min(grid - 1, Math.floor(xx / cell))
        sums[g] += Math.abs(stack[a + (yy + bdy) * size + (xx + bdx)] - stack[b + yy * size + xx])
        counts[g]++
      }
    }
    for (let g = 0; g < grid * grid; g++) out.push(counts[g] ? sums[g] / counts[g] : 0)
  }
  return out
}

async function main(): Promise<void> {
  for (const f of ['stacks.bin', 'stacks.json']) {
    if (!existsSync(join(CACHE, f))) {
      console.log(`нет eval/.cache/${f} — сначала pnpm exec tsx eval/stackPrep.ts, затем /eval/stacks.html`)
      return
    }
  }
  const meta = JSON.parse(await readFile(join(CACHE, 'stacks.json'), 'utf8')) as {
    offsets: number[]
    size: number
    index: Index[]
  }
  const bin = new Uint8Array(await readFile(join(CACHE, 'stacks.bin')))
  const sig = JSON.parse(await readFile(join(CACHE, 'blockSignals.json'), 'utf8')).clips as Record<
    string,
    { frames: number; fps: number; dx: number[]; dy: number[] }
  >
  const { fixtures } = await loadAllFixtures()

  const frames = meta.offsets.length
  const size = meta.size
  const stackBytes = frames * size * size

  const ownBy = new Map<string, number[]>()
  const sparseBy = new Map<string, boolean>()
  const baseBy = new Map<string, (time: number, conf: number) => Float64Array | null>()
  for (const f of fixtures) {
    const m = await loadClipMotion(f.labels.slug)
    const s = sig[f.labels.slug]
    if (!m || !s) continue
    const own: number[] = f.labels.shots.filter((x) => x.source === 'own').map((x) => x.time).sort((a, b) => a - b)
    ownBy.set(f.labels.slug, own)
    sparseBy.set(f.labels.slug, own.length <= SPARSE)
    const weapon: WeaponMotion = {
      frames: s.frames, fps: s.fps, band: { y0: 0, y1: 1 }, maskPx: 0,
      maskBox: { x0: 0, x1: 0, y0: 0, y1: 0 },
      dx: Float64Array.from(s.dx), dy: Float64Array.from(s.dy),
    }
    baseBy.set(f.labels.slug, (time, conf) => motionFeaturesAt(m.zone, weapon, time, conf))
  }

  interface Row { slug: string; time: number; y: number; sparse: boolean; base: Float64Array; stack: Uint8Array }
  const rows: Row[] = []
  for (const e of meta.index) {
    const own = ownBy.get(e.slug)
    const base = baseBy.get(e.slug)?.(e.time, e.confidence)
    if (!own || !base) continue
    rows.push({
      slug: e.slug, time: e.time, sparse: sparseBy.get(e.slug)!,
      y: own.some((t) => Math.abs(t - e.time) <= TOL) ? 1 : 0,
      base,
      stack: bin.subarray(e.offset, e.offset + stackBytes),
    })
  }

  const slugs = [...new Set(rows.map((r) => r.slug))]
  const foldOf = new Map(slugs.map((s, i) => [s, i % FOLDS]))

  const run = (name: string, build: (r: Row) => number[], l2: number) => {
    const X = rows.map((r) => Float64Array.from(build(r)))
    const dim = X[0].length
    const mean = new Float64Array(dim)
    const scale = new Float64Array(dim)
    const cnt = new Float64Array(dim)
    for (const v of X) for (let k = 0; k < dim; k++) if (!Number.isNaN(v[k])) { mean[k] += v[k]; cnt[k]++ }
    for (let k = 0; k < dim; k++) mean[k] /= cnt[k] || 1
    for (const v of X) for (let k = 0; k < dim; k++) if (!Number.isNaN(v[k])) scale[k] += (v[k] - mean[k]) ** 2
    for (let k = 0; k < dim; k++) scale[k] = Math.sqrt(scale[k] / (cnt[k] || 1)) || 1
    const Z = X.map((v) => {
      const o = new Float64Array(dim)
      for (let k = 0; k < dim; k++) o[k] = Number.isNaN(v[k]) ? 0 : (v[k] - mean[k]) / scale[k]
      return o
    })

    const score = new Array<number>(rows.length).fill(0)
    for (let k = 0; k < FOLDS; k++) {
      const tr = rows.map((_, i) => i).filter((i) => foldOf.get(rows[i].slug) !== k)
      const model = fit(tr.map((i) => Z[i]), tr.map((i) => rows[i].y), l2)
      rows.forEach((r, i) => { if (foldOf.get(r.slug) === k) score[i] = model(Z[i]) })
    }

    const acc = { all: [0, 0, 0], sparse: [0, 0, 0], dense: [0, 0, 0] }
    for (const slug of slugs) {
      const own = ownBy.get(slug)!
      const marks = rows.map((_, i) => i).filter((i) => rows[i].slug === slug && score[i] >= TH).map((i) => rows[i].time).sort((a, b) => a - b)
      const s = scoreDetections(own, marks, TOL)
      const add = (kk: 'all' | 'sparse' | 'dense') => { acc[kk][0] += s.truePositives; acc[kk][1] += s.falsePositives; acc[kk][2] += s.falseNegatives }
      add('all'); add(sparseBy.get(slug) ? 'sparse' : 'dense')
    }
    const f1 = (v: number[]) => { const p = v[0] / Math.max(1, v[0] + v[1]), r = v[0] / Math.max(1, v[0] + v[2]); return 100 * (2 * p * r) / Math.max(1e-9, p + r) }
    console.log(`  ${name.padEnd(38)}`, String(dim).padStart(6), f1(acc.all).toFixed(1).padStart(8), f1(acc.sparse).toFixed(1).padStart(10), f1(acc.dense).toFixed(1).padStart(9))
  }

  console.log(`стопок ${rows.length}, из них на своих выстрелах ${rows.filter((r) => r.y === 1).length}`)
  console.log(`стопка ${frames} кадров по ${size}x${size}\n`)
  console.log('  представление'.padEnd(40), 'призн.'.padStart(6), 'F1 всё'.padStart(8), 'разреж.'.padStart(10), 'плотные'.padStart(9))
  console.log('  ' + '-'.repeat(76))
  run('74 сводки (что есть сейчас)', (r) => [...r.base], 0.05)
  run('разница кадров, одно среднее', (r) => gridDiff(r.stack, frames, size, 1), 0.05)
  run('разница кадров, сетка 2x2', (r) => gridDiff(r.stack, frames, size, 2), 0.5)
  run('разница кадров, сетка 4x4', (r) => gridDiff(r.stack, frames, size, 4), 2)
  run('разница кадров, сетка 8x8', (r) => gridDiff(r.stack, frames, size, 8), 8)
  run('74 сводки + сетка 4x4', (r) => [...r.base, ...gridDiff(r.stack, frames, size, 4)], 2)
  console.log()
  run('НЕВЯЗКА после компенсации, одно среднее', (r) => gridResidual(r.stack, frames, size, 1), 0.05)
  run('невязка, сетка 2x2', (r) => gridResidual(r.stack, frames, size, 2), 0.5)
  run('невязка, сетка 4x4', (r) => gridResidual(r.stack, frames, size, 4), 2)
  run('74 сводки + невязка 2x2', (r) => [...r.base, ...gridResidual(r.stack, frames, size, 2)], 0.5)
  run('74 сводки + невязка 4x4', (r) => [...r.base, ...gridResidual(r.stack, frames, size, 4)], 2)
}

void main()
