/**
 * Weapon features from a WEIGHT MAP instead of a rectangle, plus a cache of per-frame block differences.
 *
 * The material is laid out by `eval/weightedPrep.ts`, the analysis is `eval/weightedEval.ts`.
 *
 * Two outputs are computed.
 *
 * FIRST — weighted series: shift, residual and frame difference, where blocks enter with the
 * classifier's weights rather than equally inside a rectangle. The rectangle is a special case
 * of the same: weights 0 and 1. The shift is searched by a weighted sum of costs, so a block
 * the classifier is sure about pulls the search harder.
 *
 * SECOND — a binary file of per-frame differences FOR EVERY block. This is the main bet:
 * after one decoding pass any weighting scheme is computed locally in seconds.
 * Right now each check costs seven minutes in the browser and breaks if the laptop lid is closed.
 *
 * Shift and residual cannot be cached this way — they need a pixel search — but a measurement
 * showed compensation barely pays off: residual 0.771 versus 0.774 for plain frame difference.
 * What gets cached is exactly what matters.
 */
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny'
import { sampleGrayFrame } from '../src/domain/detection/motion/motionFeatures'
import { saveResult } from './saveResult'

interface WeightedEntry {
  slug: string
  duration: number
  weights: number[]
  candidates: { time: number; confidence: number }[]
  ownShots: number[]
  enemyShots: number[]
}

const FRAME = 256
const BLOCK = 16
const MAX_SHIFT = 8
/**
 * How many highest-weight blocks take part in the weighted shift search.
 *
 * Not all 256: the search costs O(blocks × shifts), and on the full grid that is 2.7M operations
 * per frame. Twenty-four blocks are about 9% of the frame, i.e. an area of the same size as the
 * median human box (8%). The cutoff is by weight, not by geometry.
 */
const TOP_BLOCKS = 12

const log = (line: string): void => {
  const out = document.getElementById('out')
  if (out) out.textContent += line + '\n'
  window.scrollTo(0, document.body.scrollHeight)
}

/** Mean absolute block difference at a shift. Every other pixel. */
function blockCost(
  data: Uint8Array, prev: number, cur: number, bx: number, by: number, sx: number, sy: number,
): number {
  const a = prev * FRAME * FRAME
  const b = cur * FRAME * FRAME
  let sum = 0
  let n = 0
  for (let y = by; y < by + BLOCK; y += 2) {
    const ty = y + sy
    if (ty < 0 || ty >= FRAME) continue
    for (let x = bx; x < bx + BLOCK; x += 2) {
      const tx = x + sx
      if (tx < 0 || tx >= FRAME) continue
      sum += Math.abs(data[a + ty * FRAME + tx] - data[b + y * FRAME + x])
      n++
    }
  }
  return n ? sum / n : 0
}

interface ClipResult {
  frames: number
  fps: number
  dx: number[]
  dy: number[]
  resid: number[]
  diff: number[]
}

async function analyse(
  entry: WeightedEntry,
  grid: number,
  perBlock: Uint8Array[],
): Promise<ClipResult> {
  const blob = await (await fetch(`/__weighted/${entry.slug}.mp4`)).blob()
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track || !(await track.canDecode())) throw new Error('видеодорожка не читается')
    const sink = new CanvasSink(track, { poolSize: 1 })

    const nBlocks = grid * grid
    const order = entry.weights.map((w, i) => [w, i] as const).sort((a, b) => b[0] - a[0])
    const chosen = order.slice(0, TOP_BLOCKS).map(([, i]) => i)
    const wSum = chosen.reduce((s, i) => s + entry.weights[i], 0) || 1

    const area = FRAME * FRAME
    const pair = new Uint8Array(area * 2)
    const out: ClipResult = { frames: 0, fps: 0, dx: [], dy: [], resid: [], diff: [] }
    const blockRows: Uint8Array[] = []

    let index = 0
    let havePrev = false
    for await (const result of sink.canvases()) {
      if (!result) continue
      const canvas = result.canvas as HTMLCanvasElement | OffscreenCanvas
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | null
      if (!ctx) continue
      const { width, height } = canvas
      const rgba = ctx.getImageData(0, 0, width, height).data
      const slot = index % 2
      sampleGrayFrame(rgba, width, height, { x0: 0, y0: 0, x1: 1, y1: 1 }, FRAME, FRAME, pair, slot * area)

      if (!havePrev) {
        out.dx.push(0); out.dy.push(0); out.resid.push(0); out.diff.push(0)
        blockRows.push(new Uint8Array(nBlocks))
      } else {
        const prev = 1 - slot

        // Per-frame difference of EVERY block goes to the cache. Scale of 4 units per brightness level:
        // differences are almost always below 60, and the fractional part matters for small values.
        const row = new Uint8Array(nBlocks)
        for (let b = 0; b < nBlocks; b++) {
          const bx = (b % grid) * BLOCK
          const by = ((b / grid) | 0) * BLOCK
          row[b] = Math.min(255, Math.round(blockCost(pair, prev, slot, bx, by, 0, 0) * 4))
        }
        blockRows.push(row)

        // Weighted shift search: a block the classifier is sure about pulls harder.
        let best = Infinity
        let bdx = 0
        let bdy = 0
        for (let sy = -MAX_SHIFT; sy <= MAX_SHIFT; sy++) {
          for (let sx = -MAX_SHIFT; sx <= MAX_SHIFT; sx++) {
            let cost = 0
            for (const b of chosen) {
              const bx = (b % grid) * BLOCK
              const by = ((b / grid) | 0) * BLOCK
              cost += entry.weights[b] * blockCost(pair, prev, slot, bx, by, sx, sy)
            }
            cost /= wSum
            if (cost < best) { best = cost; bdx = sx; bdy = sy }
          }
        }
        let atZero = 0
        for (const b of chosen) atZero += entry.weights[b] * (row[b] / 4)
        atZero /= wSum

        out.dx.push(bdx); out.dy.push(bdy)
        out.resid.push(+best.toFixed(3)); out.diff.push(+atZero.toFixed(3))
      }
      havePrev = true
      index++
    }

    out.frames = index
    out.fps = index / entry.duration
    // Block rows are concatenated into one chunk — any weighting is later computed from it.
    const flat = new Uint8Array(index * nBlocks)
    blockRows.forEach((r, i) => flat.set(r, i * nBlocks))
    perBlock.push(flat)
    return out
  } finally {
    input.dispose()
  }
}

async function main(): Promise<void> {
  const r = await fetch('/__weighted/manifest.json')
  if (!r.ok) {
    log('нет /__weighted/manifest.json — сначала pnpm exec tsx eval/weightedPrep.ts')
    return
  }
  const { grid, entries } = (await r.json()) as { grid: number; entries: WeightedEntry[] }
  log(`клипов ${entries.length}, сетка ${grid}x${grid}, во взвешенном поиске ${TOP_BLOCKS} блоков`)
  log('')

  const clips: Record<string, ClipResult> = {}
  const index: { slug: string; frames: number; offset: number }[] = []
  const blobs: Uint8Array[] = []
  let offset = 0
  const started = performance.now()

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const t0 = performance.now()
    try {
      const res = await analyse(e, grid, blobs)
      clips[e.slug] = res
      index.push({ slug: e.slug, frames: res.frames, offset })
      offset += res.frames * grid * grid
      log(`${String(i + 1).padStart(2)}/${entries.length} ${e.slug.slice(0, 40).padEnd(42)} кадров ${String(res.frames).padStart(4)}, ${((performance.now() - t0) / 1000).toFixed(1)} с`)
    } catch (error) {
      log(`${String(i + 1).padStart(2)}/${entries.length} ${e.slug.slice(0, 40).padEnd(42)} ОШИБКА: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  log('')
  log(`готово за ${((performance.now() - started) / 1000 / 60).toFixed(1)} мин`)

  log(await saveResult('weightedSignals.json', JSON.stringify({ grid, topBlocks: TOP_BLOCKS, clips }), 'application/json'))
  log(await saveResult('blockDiffs.json', JSON.stringify({ grid, scale: 4, index }), 'application/json'))
  const total = blobs.reduce((s, b) => s + b.length, 0)
  const flat = new Uint8Array(total)
  let at = 0
  for (const b of blobs) { flat.set(b, at); at += b.length }
  log(await saveResult('blockDiffs.bin', flat, 'application/octet-stream'))
}

void main()
