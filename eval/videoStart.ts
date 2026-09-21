/**
 * Real time of the first video frame for each clip.
 *
 * Why a separate step. OpenCV in Python reports frame time as "index divided by fps" and
 * silently ignores the track's start offset in the container. In this set's clips the video
 * track starts not at zero but one frame later, while the audio starts at zero. Shot labels
 * were placed on the audio waveform, so a one-frame error goes straight into the metric.
 *
 * There is one authority on time here — mediabunny, the same demuxer as in the product.
 * Python reads the ready file and knows nothing about containers.
 *
 *   pnpm exec tsx eval/videoStart.ts
 */
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ALL_FORMATS, FilePathSource, Input } from 'mediabunny'
import { PROJECT_ROOT, LABELS_DIR } from './fixtures'

async function main(): Promise<void> {
  const out = join(PROJECT_ROOT, 'python/out/videoStart.json')
  const names = (await readdir(LABELS_DIR)).filter((n) => n.endsWith('.json'))

  const table: Record<string, { clip: string; videoStart: number; audioStart: number }> = {}
  for (const name of names) {
    const payload: unknown = JSON.parse(await readFile(join(LABELS_DIR, name), 'utf8'))
    const { slug, clip } = payload as { slug: string; clip: string }
    try {
      const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(join(PROJECT_ROOT, 'examples', clip)) })
      const video = await input.getPrimaryVideoTrack()
      const audio = await input.getPrimaryAudioTrack()
      if (!video) continue
      const videoStart = await video.getFirstTimestamp()
      const audioStart = audio ? await audio.getFirstTimestamp() : 0
      table[slug] = { clip, videoStart, audioStart }
    } catch {
      // A clip without a video track or an unreadable one — Python simply will not find it in the table
      // and will stay at zero, saying so.
    }
  }

  await mkdir(join(PROJECT_ROOT, 'python/out'), { recursive: true })
  await writeFile(out, JSON.stringify(table, null, 2), 'utf8')

  const offsets = Object.values(table).map((t) => t.videoStart - t.audioStart)
  const uniq = [...new Set(offsets.map((o) => o.toFixed(4)))].sort()
  console.log(`клипов ${Object.keys(table).length}, смещений видео-звук: ${uniq.join(', ')}`)
  console.log(`-> ${out}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
