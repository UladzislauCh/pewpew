/**
 * Per-frame confidence curve for ONE clip: time, score, class, box.
 *
 * Written to analyse doubled labels on sixty-frame clips: `pickPeaks` separates labels by a
 * minimum gap of 70 ms (the fastest fire rate in the game), while a flash at 60 fps spans
 * 4–6 frames, i.e. 67–100 ms. It checks whether two adjacent frames of ONE flash really end up
 * further apart than the threshold.
 *
 *   pnpm dev  ->  /eval/frameDump.html?only=substring
 *
 * TRAP: editing any imported module reloads the page via HMR and overwrites the dump.
 * Run first, edit afterwards.
 */
import { detectByFlash } from '../src/domain/detection/flash/detectByFlash'
import { saveResult } from './saveResult'

interface Entry {
  slug: string
  duration: number
  candidates?: number[]
  confidence?: number[]
}

const out = document.getElementById('out') as HTMLPreElement
const log = (line: string): void => {
  out.textContent += line + '\n'
  window.scrollTo(0, document.body.scrollHeight)
}

async function main(): Promise<void> {
  const only = new URLSearchParams(location.search).get('only')
  const manifest = await fetch('/__ammo/manifest.json').then((r) => (r.ok ? r.json() : null))
  if (!manifest) return log('нет /__ammo/manifest.json')
  const entry: Entry | undefined = (manifest.entries as Entry[]).find((e) => e.slug.includes(only ?? ''))
  if (!entry) return log(`нет клипа по подстроке «${only}»`)

  log(`${entry.slug}, ${entry.duration.toFixed(1)} с\n`)
  const file = await fetch(`/__ammo/${entry.slug}.mp4`).then((r) => r.blob())
  const rows: { t: number[]; score: number[]; winner: string[]; w: number[]; h: number[] }
    = { t: [], score: [], winner: [], w: [], h: [] }

  const shots = await detectByFlash(file, {
    audioShots: (entry.candidates ?? []).map((time, k) => ({
      time,
      strength: entry.confidence?.[k] ?? 1,
      relativeLoudness: 1,
    })),
    onFrame: (f) => {
      rows.t.push(Math.round(f.time * 1000) / 1000)
      rows.score.push(Math.round(f.score * 1000) / 1000)
      rows.winner.push(f.winner)
      rows.w.push(Math.round((f.spot?.w ?? 0) * 1e4) / 1e4)
      rows.h.push(Math.round((f.spot?.h ?? 0) * 1e4) / 1e4)
    },
  })

  const fps = rows.t.length > 1 ? (rows.t.length - 1) / (rows.t[rows.t.length - 1] - rows.t[0]) : 0
  log(`кадров ${rows.t.length}, ${fps.toFixed(1)} к/с, меток ${shots.length}`)
  log(`метки: ${shots.map((s) => s.time.toFixed(3)).join(' ')}`)
  await saveResult(`frames-${entry.slug}.json`, JSON.stringify({ slug: entry.slug, fps, shots: shots.map((s) => s.time), rows }), 'application/json')
  log(`\nзаписано в eval/.cache/frames-${entry.slug}.json`)
}

void main()
