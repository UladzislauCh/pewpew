/**
 * Real video frame timestamps for each clip.
 *
 * Python computes frame time as "index divided by fps": OpenCV does not return real timestamps.
 * That is correct only for a strictly constant frame rate and zero track offset, and videos
 * downloaded from YouTube need not satisfy either. Shot labels were placed on the AUDIO waveform,
 * so any error in video time goes straight into the metric.
 *
 * There is one authority on time here — mediabunny, the same demuxer as in the product.
 * Python reads the ready file and knows nothing about containers.
 *
 *   pnpm exec tsx eval/frameTimes.ts
 */
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input } from 'mediabunny'
import { PROJECT_ROOT, LABELS_DIR } from './fixtures'

interface ClipTimes {
  clip: string
  videoStart: number
  audioStart: number
  /** Frame timestamps in PRESENTATION order, seconds. */
  times: number[]
  /** How much the series differs from the ideal index/fps — max and median absolute value, ms. */
  driftMaxMs: number
  driftMedianMs: number
  fps: number
}

function summarize(times: number[]): { fps: number; maxMs: number; medianMs: number } {
  if (times.length < 2) return { fps: 30, maxMs: 0, medianMs: 0 }
  const span = times[times.length - 1] - times[0]
  const fps = span > 0 ? (times.length - 1) / span : 30
  // Compare with the exact model Python uses: start plus index/fps.
  const errors = times.map((t, i) => Math.abs(t - (times[0] + i / fps)) * 1000)
  const sorted = [...errors].sort((a, b) => a - b)
  return { fps, maxMs: sorted[sorted.length - 1], medianMs: sorted[sorted.length >> 1] }
}

async function main(): Promise<void> {
  const out = join(PROJECT_ROOT, 'python/out/frameTimes.json')
  const names = (await readdir(LABELS_DIR)).filter((n) => n.endsWith('.json'))

  const table: Record<string, ClipTimes> = {}
  for (const name of names) {
    const payload: unknown = JSON.parse(await readFile(join(LABELS_DIR, name), 'utf8'))
    const { slug, clip } = payload as { slug: string; clip: string }
    try {
      const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(join(PROJECT_ROOT, 'examples', clip)) })
      const video = await input.getPrimaryVideoTrack()
      if (!video) continue
      const audio = await input.getPrimaryAudioTrack()

      // Metadata only: the frames themselves need not be decoded, only their times.
      const sink = new EncodedPacketSink(video)
      const times: number[] = []
      for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
        times.push(packet.timestamp)
      }
      // PRESENTATION order, not decode order: with B-frames they differ, and the reader
      // receives frames from the decoder in presentation order.
      times.sort((a, b) => a - b)

      const { fps, maxMs, medianMs } = summarize(times)
      table[slug] = {
        clip,
        videoStart: times[0] ?? 0,
        audioStart: audio ? await audio.getFirstTimestamp() : 0,
        times,
        driftMaxMs: Number(maxMs.toFixed(2)),
        driftMedianMs: Number(medianMs.toFixed(2)),
        fps: Number(fps.toFixed(4)),
      }
    } catch {
      // Unreadable clip: Python will not find it in the table and will say so.
    }
  }

  await mkdir(join(PROJECT_ROOT, 'python/out'), { recursive: true })
  await writeFile(out, JSON.stringify(table), 'utf8')

  const rows = Object.entries(table).sort((a, b) => b[1].driftMaxMs - a[1].driftMaxMs)
  console.log('клип                                     кадров    fps   старт   макс.отклонение от index/fps')
  for (const [slug, t] of rows.slice(0, 14)) {
    console.log(
      `${slug.slice(0, 40).padEnd(40)} ${String(t.times.length).padStart(6)} ${t.fps.toFixed(2).padStart(6)} ` +
        `${(t.videoStart * 1000).toFixed(0).padStart(6)}мс ${t.driftMaxMs.toFixed(0).padStart(8)}мс ` +
        `(медиана ${t.driftMedianMs.toFixed(0)}мс)`,
    )
  }
  console.log(`\nвсего клипов ${Object.keys(table).length} -> ${out}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
