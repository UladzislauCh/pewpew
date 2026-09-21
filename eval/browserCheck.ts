/**
 * End-to-end check of the NEW pipeline entirely in the browser.
 *
 * What exactly is checked. Weapon features were already computed by the browser, but camera
 * motion for them came from the `frametool` reference cache (`eval/.cache/motion`). In the product
 * both will come from one source — mediabunny/WebCodecs. That is what is done here: one decoding
 * pass, TWO samples are taken from each frame — 384x384 for camera motion by production code and
 * 256x256 for blocks — and both branches are computed right here.
 *
 * For the old pipeline such a check already passed on all 49 clips and gave a divergence of
 * 0.2 F1 points (docs/HANDOFF-detection.md). The new pipeline is not covered by it: the per-block
 * part appeared later.
 *
 * Block weights come ready from `eval/.cache/blockWeights.json` — they were obtained with folds
 * by clip, i.e. each map is from a model that has not seen its clip. They must not be recomputed
 * here: training goes across clips and has no way to happen in the browser.
 */
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny'
import { computeZoneMotion, sampleGrayFrame, type GrayFrames } from '../src/domain/detection/motion/motionFeatures'
import { saveResult } from './saveResult'

interface WeightedEntry {
  slug: string
  duration: number
  weights: number[]
  candidates: { time: number; confidence: number }[]
  ownShots: number[]
  enemyShots: number[]
}

/** Camera-motion geometry — the same as the model's. Must not change without retraining the weights. */
const ZONE_SIZE = 384
/** Block geometry — the same the classifier weights were computed on. */
const BLOCK_FRAME = 256
const BLOCK = 16
const GRID = BLOCK_FRAME / BLOCK
const MAX_SHIFT = 8
const TOP_BLOCKS = 24

const log = (line: string): void => {
  const out = document.getElementById('out')
  if (out) out.textContent += line + '\n'
  window.scrollTo(0, document.body.scrollHeight)
}

function blockCost(
  data: Uint8Array, prev: number, cur: number, bx: number, by: number, sx: number, sy: number,
): number {
  const a = prev * BLOCK_FRAME * BLOCK_FRAME
  const b = cur * BLOCK_FRAME * BLOCK_FRAME
  let sum = 0
  let n = 0
  for (let y = by; y < by + BLOCK; y += 2) {
    const ty = y + sy
    if (ty < 0 || ty >= BLOCK_FRAME) continue
    for (let x = bx; x < bx + BLOCK; x += 2) {
      const tx = x + sx
      if (tx < 0 || tx >= BLOCK_FRAME) continue
      sum += Math.abs(data[a + ty * BLOCK_FRAME + tx] - data[b + y * BLOCK_FRAME + x])
      n++
    }
  }
  return n ? sum / n : 0
}

interface ClipOut {
  frames: number
  fps: number
  zone: { grid: number; frames: number; fps: number; dx: number[][]; dy: number[][] }
  weapon: { frames: number; fps: number; dx: number[]; dy: number[]; resid: number[]; diff: number[] }
}

async function analyse(entry: WeightedEntry): Promise<ClipOut> {
  const blob = await (await fetch(`/__weighted/${entry.slug}.mp4`)).blob()
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track || !(await track.canDecode())) throw new Error('видеодорожка не читается')
    const sink = new CanvasSink(track, { poolSize: 1 })

    const order = entry.weights.map((w, i) => [w, i] as const).sort((a, b) => b[0] - a[0])
    const chosen = order.slice(0, TOP_BLOCKS).map(([, i]) => i)
    const wSum = chosen.reduce((s, i) => s + entry.weights[i], 0) || 1

    const zoneArea = ZONE_SIZE * ZONE_SIZE
    const blockArea = BLOCK_FRAME * BLOCK_FRAME
    const zoneChunks: Uint8Array[] = []
    const blockPair = new Uint8Array(blockArea * 2)
    const wdx: number[] = []
    const wdy: number[] = []
    const resid: number[] = []
    const diff: number[] = []

    let index = 0
    let havePrev = false
    for await (const result of sink.canvases()) {
      if (!result) continue
      const canvas = result.canvas as HTMLCanvasElement | OffscreenCanvas
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | null
      if (!ctx) continue
      const { width, height } = canvas
      const rgba = ctx.getImageData(0, 0, width, height).data

      // 384x384 sample for camera motion — by the same code as in prod.
      const zoneFrame = new Uint8Array(zoneArea)
      sampleGrayFrame(rgba, width, height, { x0: 0, y0: 0, x1: 1, y1: 1 }, ZONE_SIZE, ZONE_SIZE, zoneFrame)
      zoneChunks.push(zoneFrame)

      // And 256x256 for blocks — the same geometry the weights were computed on.
      const slot = index % 2
      sampleGrayFrame(rgba, width, height, { x0: 0, y0: 0, x1: 1, y1: 1 }, BLOCK_FRAME, BLOCK_FRAME, blockPair, slot * blockArea)

      if (!havePrev) {
        wdx.push(0); wdy.push(0); resid.push(0); diff.push(0)
      } else {
        const prev = 1 - slot
        let best = Infinity
        let bdx = 0
        let bdy = 0
        for (let sy = -MAX_SHIFT; sy <= MAX_SHIFT; sy++) {
          for (let sx = -MAX_SHIFT; sx <= MAX_SHIFT; sx++) {
            let cost = 0
            for (const b of chosen) {
              const bx = (b % GRID) * BLOCK
              const by = ((b / GRID) | 0) * BLOCK
              cost += entry.weights[b] * blockCost(blockPair, prev, slot, bx, by, sx, sy)
            }
            cost /= wSum
            if (cost < best) { best = cost; bdx = sx; bdy = sy }
          }
        }
        let atZero = 0
        for (const b of chosen) {
          const bx = (b % GRID) * BLOCK
          const by = ((b / GRID) | 0) * BLOCK
          atZero += entry.weights[b] * blockCost(blockPair, prev, slot, bx, by, 0, 0)
        }
        atZero /= wSum
        wdx.push(bdx); wdy.push(bdy)
        resid.push(+best.toFixed(3)); diff.push(+atZero.toFixed(3))
      }
      havePrev = true
      index++
    }

    const frames = index
    const fps = frames / entry.duration
    const flat = new Uint8Array(frames * zoneArea)
    zoneChunks.forEach((c, i) => flat.set(c, i * zoneArea))
    const gray: GrayFrames = { data: flat, width: ZONE_SIZE, height: ZONE_SIZE, frames, fps }
    const zone = computeZoneMotion(gray)

    return {
      frames,
      fps,
      zone: {
        grid: zone.grid,
        frames: zone.frames,
        fps: zone.fps,
        dx: zone.dx.map((a) => Array.from(a, (v) => +v.toFixed(3))),
        dy: zone.dy.map((a) => Array.from(a, (v) => +v.toFixed(3))),
      },
      weapon: { frames, fps, dx: wdx, dy: wdy, resid, diff },
    }
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
  const { entries } = (await r.json()) as { entries: WeightedEntry[] }
  log(`клипов ${entries.length}: движение камеры ${ZONE_SIZE}x${ZONE_SIZE}, блоки ${GRID}x${GRID} по ${BLOCK} px`)
  log('оба контура из ОДНОГО прохода декодирования, оба из браузерных кадров')
  log('')

  const clips: Record<string, ClipOut> = {}
  const started = performance.now()
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const t0 = performance.now()
    try {
      clips[e.slug] = await analyse(e)
      log(`${String(i + 1).padStart(2)}/${entries.length} ${e.slug.slice(0, 40).padEnd(42)} кадров ${String(clips[e.slug].frames).padStart(4)}, ${((performance.now() - t0) / 1000).toFixed(1)} с`)
    } catch (error) {
      log(`${String(i + 1).padStart(2)}/${entries.length} ${e.slug.slice(0, 40).padEnd(42)} ОШИБКА: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  log('')
  log(`готово за ${((performance.now() - started) / 1000 / 60).toFixed(1)} мин`)
  log(await saveResult('browserCheck.json', JSON.stringify({ zoneSize: ZONE_SIZE, grid: GRID, clips }), 'application/json'))
}

void main()
