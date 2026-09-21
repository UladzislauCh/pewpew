/**
 * Exports weapon-region frame stacks for every candidate — the input for a pixel model.
 *
 * The material is laid out by `eval/stackPrep.ts`, training is done by `eval/stackTrain.ts`.
 *
 * This export is what it was all for: after one decoding pass any architecture is checked
 * locally in seconds. The same trick as with `blockDiffs.bin` — it paid off instantly,
 * sweeping fourteen weighting schemes took seconds instead of an hour.
 *
 * Frames are taken by TIME, not by index: clips are 30 and 60 fps, and a stack must mean
 * the same thing in both cases, otherwise the network will learn the frame rate.
 * For that, the frames nearest to the required moments are picked, not consecutive ones.
 */
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny'
import { sampleGrayFrame } from '../src/domain/detection/motion/motionFeatures'
import { saveResult } from './saveResult'

interface StackEntry {
  slug: string
  duration: number
  box: { x0: number; y0: number; x1: number; y1: number }
  candidates: { time: number; confidence: number }[]
  ownShots: number[]
}

const log = (line: string): void => {
  const out = document.getElementById('out')
  if (out) out.textContent += line + '\n'
  window.scrollTo(0, document.body.scrollHeight)
}

async function main(): Promise<void> {
  const r = await fetch('/__stacks/manifest.json')
  if (!r.ok) {
    log('нет /__stacks/manifest.json — сначала pnpm exec tsx eval/stackPrep.ts')
    return
  }
  const { offsets, size, entries } = (await r.json()) as {
    offsets: number[]
    size: number
    entries: StackEntry[]
  }
  const stackBytes = offsets.length * size * size
  log(`клипов ${entries.length}, стопка ${offsets.length} кадров по ${size}x${size}`)
  log('')

  const index: { slug: string; time: number; confidence: number; offset: number }[] = []
  const chunks: Uint8Array[] = []
  let written = 0
  const started = performance.now()

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const t0 = performance.now()
    try {
      const blob = await (await fetch(`/__stacks/${e.slug}.mp4`)).blob()
      const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) })
      try {
        const track = await input.getPrimaryVideoTrack()
        if (!track || !(await track.canDecode())) throw new Error('видеодорожка не читается')
        const sink = new CanvasSink(track)

        // Required moments: one per candidate and offset. We ask the decoder for them
        // sorted — otherwise it would jump back to keyframes.
        const wanted: { key: number; t: number }[] = []
        e.candidates.forEach((c, ci) => {
          offsets.forEach((ms, oi) => {
            const t = Math.max(0, Math.min(e.duration - 0.001, c.time + ms / 1000))
            wanted.push({ key: ci * offsets.length + oi, t })
          })
        })
        wanted.sort((a, b) => a.t - b.t)

        const buffers = new Map<number, Uint8Array>()
        let k = 0
        for await (const result of sink.canvasesAtTimestamps(wanted.map((w) => w.t))) {
          const want = wanted[k++]
          if (!result) continue
          const canvas = result.canvas as HTMLCanvasElement | OffscreenCanvas
          const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | null
          if (!ctx) continue
          const { width, height } = canvas
          const rgba = ctx.getImageData(0, 0, width, height).data
          const buf = new Uint8Array(size * size)
          sampleGrayFrame(rgba, width, height, e.box, size, size, buf)
          buffers.set(want.key, buf)
        }

        e.candidates.forEach((c, ci) => {
          const stack = new Uint8Array(stackBytes)
          let filled = 0
          offsets.forEach((_, oi) => {
            const buf = buffers.get(ci * offsets.length + oi)
            if (buf) { stack.set(buf, oi * size * size); filled++ }
          })
          // A candidate at the very edge of the clip: some frames do not exist. Such ones are skipped,
          // otherwise the network would learn on black frames.
          if (filled < offsets.length) return
          index.push({ slug: e.slug, time: c.time, confidence: c.confidence, offset: written })
          chunks.push(stack)
          written += stackBytes
        })
      } finally {
        input.dispose()
      }
      log(`${String(i + 1).padStart(2)}/${entries.length} ${e.slug.slice(0, 40).padEnd(42)} кандидатов ${String(e.candidates.length).padStart(3)}, ${((performance.now() - t0) / 1000).toFixed(1)} с`)
    } catch (error) {
      log(`${String(i + 1).padStart(2)}/${entries.length} ${e.slug.slice(0, 40).padEnd(42)} ОШИБКА: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  log('')
  log(`готово за ${((performance.now() - started) / 1000 / 60).toFixed(1)} мин, стопок ${index.length}`)

  const flat = new Uint8Array(written)
  let at = 0
  for (const c of chunks) { flat.set(c, at); at += c.length }
  log(await saveResult('stacks.json', JSON.stringify({ offsets, size, index }), 'application/json'))
  log(await saveResult('stacks.bin', flat, 'application/octet-stream'))
}

void main()
