/**
 * Computes per-frame series inside the weapon region — the human and the heuristic one at once.
 *
 * The material is laid out by `eval/weaponSignalPrep.ts`, the analysis is `eval/weaponSignalEval.ts`.
 * The page is a browser one out of necessity: Node has no WebCodecs.
 *
 * What is computed per frame inside the region:
 *
 *  - `dx`, `dy` — the best RIGID shift relative to the previous frame. The same thing prod
 *    computes, only over the right region.
 *  - `resid` — what remains AFTER compensating by that shift. Bolt travel, an opened ejection
 *    port and barrel glow are not explained by a rigid shift and settle here. According to the
 *    journal this is the strongest single feature: AUC 0.884 "shot versus lull" and 0.949
 *    "own versus enemy" — versus 0.910 for the whole 74-feature model.
 *  - `diff` — frame difference WITHOUT compensation (0.857). Kept for comparison: if resid
 *    does not beat diff, compensation gives nothing and the complexity does not pay off.
 *  - `bright` — mean brightness of the region. "The weapon model gets lighter" is an observation
 *    from the glock review; according to the journal, as a single feature it is 0.492, i.e. a coin
 *    toss, but it costs one summation pass.
 *
 * Both regions are computed from ONE decoding pass: otherwise the difference between regions
 * would be mixed with a difference in decoding.
 */
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny'
import { sampleGrayFrame, type CropRect } from '../src/domain/detection/motion/motionFeatures'
import { saveResult } from './saveResult'

interface Rect { x0: number; y0: number; x1: number; y1: number }

interface SignalEntry {
  slug: string
  duration: number
  human: Rect | null
  humanNote: string
  auto: Rect | null
  ownShots: number[]
  enemyShots: number[]
  candidates: { time: number; confidence: number }[]
}

/** The region is scaled to a square — just as prod scales the frame to 384x384. */
const BOX_SIZE = 128
/** Shift search limit, in region pixels. More than prod's 6: the region is smaller, the shift larger. */
const MAX_SHIFT = 8

interface Signals {
  frames: number
  fps: number
  dx: number[]
  dy: number[]
  resid: number[]
  diff: number[]
  bright: number[]
}

const log = (line: string): void => {
  const out = document.getElementById('out')
  if (out) out.textContent += line + '\n'
  window.scrollTo(0, document.body.scrollHeight)
}

/**
 * The best rigid shift between frames and the remainder after it.
 *
 * Every other pixel is taken — twice as fast, and in prod it did not affect the score either.
 */
function shiftAndResidual(
  data: Uint8Array,
  size: number,
  prev: number,
  cur: number,
): { dx: number; dy: number; resid: number; diff: number } {
  const area = size * size
  const a = prev * area
  const b = cur * area
  let best = Infinity
  let bx = 0
  let by = 0
  let atZero = Infinity

  for (let sy = -MAX_SHIFT; sy <= MAX_SHIFT; sy++) {
    for (let sx = -MAX_SHIFT; sx <= MAX_SHIFT; sx++) {
      let sum = 0
      let n = 0
      for (let y = Math.max(0, -sy); y < Math.min(size, size - sy); y += 2) {
        const rowA = (y + sy) * size
        const rowB = y * size
        for (let x = Math.max(0, -sx); x < Math.min(size, size - sx); x += 2) {
          sum += Math.abs(data[a + rowA + x + sx] - data[b + rowB + x])
          n++
        }
      }
      if (!n) continue
      const cost = sum / n
      if (sx === 0 && sy === 0) atZero = cost
      if (cost < best) {
        best = cost
        bx = sx
        by = sy
      }
    }
  }
  return { dx: bx, dy: by, resid: best, diff: atZero }
}

function computeSignals(data: Uint8Array, size: number, frames: number, fps: number): Signals {
  const out: Signals = { frames, fps, dx: [], dy: [], resid: [], diff: [], bright: [] }
  const area = size * size
  for (let f = 0; f < frames; f++) {
    let sum = 0
    for (let i = 0; i < area; i += 2) sum += data[f * area + i]
    out.bright.push(+(sum / (area / 2)).toFixed(2))
    if (f === 0) {
      out.dx.push(0); out.dy.push(0); out.resid.push(0); out.diff.push(0)
      continue
    }
    const r = shiftAndResidual(data, size, f - 1, f)
    out.dx.push(r.dx); out.dy.push(r.dy)
    out.resid.push(+r.resid.toFixed(3)); out.diff.push(+r.diff.toFixed(3))
  }
  return out
}

/** Decodes the clip ONCE and picks both regions from every frame right away. */
async function decodeBoth(
  blob: Blob,
  crops: (CropRect | null)[],
  size: number,
): Promise<{ data: (Uint8Array | null)[]; frames: number }> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track || !(await track.canDecode())) throw new Error('видеодорожка не читается')
    const sink = new CanvasSink(track, { poolSize: 1 })

    const chunks: (Uint8Array[] | null)[] = crops.map((c) => (c ? [] : null))
    for await (const result of sink.canvases()) {
      if (!result) continue
      const canvas = result.canvas as HTMLCanvasElement | OffscreenCanvas
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | null
      if (!ctx) continue
      const { width, height } = canvas
      const rgba = ctx.getImageData(0, 0, width, height).data
      crops.forEach((crop, i) => {
        if (!crop) return
        const buf = new Uint8Array(size * size)
        sampleGrayFrame(rgba, width, height, crop, size, size, buf)
        chunks[i]!.push(buf)
      })
    }

    const frames = chunks.find(Boolean)?.length ?? 0
    if (!frames) throw new Error('не удалось декодировать ни одного кадра')
    const data = chunks.map((list) => {
      if (!list) return null
      const flat = new Uint8Array(list.length * size * size)
      list.forEach((c, i) => flat.set(c, i * size * size))
      return flat
    })
    return { data, frames }
  } finally {
    input.dispose()
  }
}

async function main(): Promise<void> {
  const r = await fetch('/__signal/manifest.json')
  if (!r.ok) {
    log('нет /__signal/manifest.json — сначала pnpm exec tsx eval/weaponSignalPrep.ts')
    return
  }
  const { entries } = (await r.json()) as { entries: SignalEntry[] }
  log(`клипов ${entries.length}, область масштабируется в ${BOX_SIZE}x${BOX_SIZE}, предел сдвига ${MAX_SHIFT}`)
  log('')

  const result: Record<string, { human: Signals | null; auto: Signals | null; note: string }> = {}
  const started = performance.now()

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const t0 = performance.now()
    try {
      if (!e.human && !e.auto) {
        result[e.slug] = { human: null, auto: null, note: e.humanNote }
        log(`${String(i + 1).padStart(2)}/${entries.length} ${e.slug.slice(0, 40).padEnd(42)} обеих областей нет`)
        continue
      }
      const blob = await (await fetch(`/__signal/${e.slug}.mp4`)).blob()
      const { data, frames } = await decodeBoth(blob, [e.human, e.auto], BOX_SIZE)
      const fps = frames / e.duration
      result[e.slug] = {
        human: data[0] ? computeSignals(data[0], BOX_SIZE, frames, fps) : null,
        auto: data[1] ? computeSignals(data[1], BOX_SIZE, frames, fps) : null,
        note: e.humanNote,
      }
      const secs = (performance.now() - t0) / 1000
      log(
        `${String(i + 1).padStart(2)}/${entries.length} ${e.slug.slice(0, 40).padEnd(42)} ` +
          `кадров ${String(frames).padStart(4)}, ${fps.toFixed(1)} fps, ${secs.toFixed(1)} с`,
      )
    } catch (error) {
      log(`${String(i + 1).padStart(2)}/${entries.length} ${e.slug.slice(0, 40).padEnd(42)} ОШИБКА: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  log('')
  log(`готово за ${((performance.now() - started) / 1000 / 60).toFixed(1)} мин`)

  log(await saveResult('weaponSignals.json', JSON.stringify({ boxSize: BOX_SIZE, maxShift: MAX_SHIFT, clips: result }), 'application/json'))
}

void main()
