/**
 * Run of the production flash stage in a REAL browser.
 *
 * The Python measurement (`python/tools/flash_curve.py`) runs the same model on OpenCV and
 * CPU onnxruntime. That is a DIFFERENT PIPELINE: different video decoding, different scaling,
 * a different executor. The two pipelines' numbers diverge, and putting them in one table is a
 * sure way to confuse what was measured. What is measured here is the code the user will see.
 *
 *   pnpm exec tsx eval/ammoPrep.ts     # if /__ammo/manifest.json does not exist yet
 *   pnpm dev  ->  /eval/flashBrowser.html
 *
 * ?limit=N — first N clips, ?only=substring — a single clip.
 */
import { scoreShotsByFlash, keepConfirmed, DEFAULT_FLASH_THRESHOLD } from '../src/domain/detection/flash/scoreShotsByFlash'
import { saveResult } from './saveResult'

interface Entry {
  slug: string
  duration: number
  candidates: number[]
  confidence?: number[]
}

const out = document.getElementById('out') as HTMLPreElement
const log = (line: string): void => {
  out.textContent += line + '\n'
  window.scrollTo(0, document.body.scrollHeight)
}

async function main(): Promise<void> {
  const manifest = await fetch('/__ammo/manifest.json').then((r) => (r.ok ? r.json() : null))
  if (!manifest) {
    log('нет /__ammo/manifest.json — сначала pnpm exec tsx eval/ammoPrep.ts')
    return
  }
  const params = new URLSearchParams(window.location.search)
  const only = params.get('only')
  // ?mode=peaks — placement by non-maximum suppression instead of a fire-rate grid.
  const mode = params.get('mode') === 'peaks' ? 'peaks' : 'rhythm'
  const limit = Number(params.get('limit') ?? 0)
  const all: Entry[] = manifest.entries
  const picked = only ? all.filter((e) => e.slug.includes(only)) : all
  const entries = limit > 0 ? picked.slice(0, limit) : picked

  const meta = await fetch('/models/flashNet.meta.json').then((r) => (r.ok ? r.json() : null))
  const names: string[] = meta ? Object.values(meta.names) : []
  log(`клипов ${entries.length}, порог ${DEFAULT_FLASH_THRESHOLD}, расстановка «${mode}», классы: ${names.join(', ')}\n`)
  // ALL candidates are saved with their score, not only the kept ones. A threshold and gap
  // sweep then takes seconds and needs no pass over the video — the same trick that paid off
  // for ammo-counter alignment (`eval/ammoRealign.ts`).
  const rows: {
    slug: string
    candidates: number
    kept: number
    times: number[]
    scored: { time: number; score: number; cls: number[]; spot: number[] | null }[]
    seconds: number
  }[] = []

  for (const entry of entries) {
    const started = performance.now()
    try {
      const file = await fetch(`/__ammo/${entry.slug}.mp4`).then((r) => r.blob())
      // The audio confidence must be real: label selection resolves disputes by it,
      // and with a one for everyone the rule silently switches off.
      const shots = entry.candidates.map((time, i) => ({
        time,
        strength: entry.confidence?.[i] ?? 1,
        relativeLoudness: 1,
      }))
      const { shots: scored, intervals } = await scoreShotsByFlash(file, shots)
      const kept = keepConfirmed(scored, intervals, undefined, undefined, mode)
      const seconds = (performance.now() - started) / 1000
      // The tempo the placement ITSELF chose, not one recomputed from the final labels:
      // the latter would show something other than what the product does.
      const spans = intervals.length
      const byPeriod = new Map<string, number>()
      for (const shot of kept) {
        const key = shot.period ? `${(60 / shot.period).toFixed(0)}rpm` : 'одиночные'
        byPeriod.set(key, (byPeriod.get(key) ?? 0) + 1)
      }
      const rhythms = [...byPeriod]
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${n}x${k === 'одиночные' ? ' одиночных' : '@' + k}`)
        .join(' ')
      const filled = kept.filter((s) => s.filled).length
      rows.push({
        slug: entry.slug,
        candidates: shots.length,
        kept: kept.length,
        times: kept.map((s) => Math.round(s.time * 1000) / 1000),
        // Each class score is saved too: without it one cannot check what zoom_flash
        // gives separately from muzzle_flash without rerunning the video.
        scored: scored.map((s) => ({
          time: Math.round(s.time * 1000) / 1000,
          score: Math.round(s.flashScore * 1000) / 1000,
          cls: s.classScores.map((c) => Math.round(c * 1000) / 1000),
          // Box in fractions of the frame: centre and size. As an array, not an object — otherwise
          // the file for five thousand candidates triples in size on field names alone.
          spot: s.spot
            ? [s.spot.cx, s.spot.cy, s.spot.w, s.spot.h].map((v) => Math.round(v * 1000) / 1000)
            : null,
        })),
        seconds,
      })
      log(
        `${entry.slug.slice(0, 42).padEnd(44)} кандидатов ${String(shots.length).padStart(3)}` +
          ` -> ${String(kept.length).padStart(3)} меток` +
          (filled ? ` (+${filled} по ритму)` : '        ') +
          `  ${seconds.toFixed(1)} с  интервалов ${spans}  ${rhythms}`,
      )
    } catch (error) {
      log(`${entry.slug.slice(0, 42).padEnd(44)} ОШИБКА: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // saveResult takes an already serialised body and a type, not an object.
  await saveResult(mode === 'peaks' ? 'flashBrowser-peaks.json' : 'flashBrowser.json', JSON.stringify(rows, null, 1), 'application/json')
  log(`\nготово, записано в eval/.cache/flashBrowser.json`)
}

void main()
