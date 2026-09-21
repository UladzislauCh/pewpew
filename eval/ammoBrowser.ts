/**
 * Check of the PRODUCTION counter reader against the Python one.
 *
 * A project rule paid for by five silent bugs: porting a computation between two contexts is
 * checked by DECISIONS, per candidate, on one set. Here it is the same set of clips, the same
 * audio candidates and the same code that will go to the user — the page calls
 * `scoreShotsByMotion`, not its own copy of the logic.
 *
 *   pnpm exec tsx eval/audioCandidates.ts
 *   pnpm exec tsx eval/ammoPrep.ts
 *   pnpm dev          # then /eval/ammoBrowser.html
 *   pnpm exec tsx eval/ammoCompare.ts
 */
import { onAmmoTrace, scoreShotsByMotion } from '../src/domain/detection/motion/detectWithMotion'
import type { AmmoRejection, AmmoResult } from '../src/domain/detection/ammo/detectWithAmmo'
import { saveResult } from './saveResult'

/**
 * Manifest entry from `eval/ammoPrep.ts`. The type is repeated here, not imported:
 * ammoPrep is a Node script, and the import would drag node types into the browser project.
 */
interface AmmoEntry {
  slug: string
  duration: number
  candidates: number[]
}

interface Row {
  slug: string
  covered: boolean
  reason: string | null
  times: number[]
  slot: { x: number; y: number; presence: number; readRate: number } | null
  magazine: number | null
  descents: number
  best: unknown
  slots: unknown
  series: unknown
  readSpans: [number, number][]
  shotsVideo: number[]
  offset: number
  snapped: number
  seconds: number
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
  // ?limit=N — run only the first N clips. Needed to measure pass time
  // without waiting for all forty-five.
  const params = new URLSearchParams(window.location.search)
  const limit = Number(params.get('limit') ?? 0)
  // ?ammo=0 — run with the previous scheme. Needed to measure how much the counter adds,
  // rather than what the whole pass costs.
  const withAmmo = params.get('ammo') !== '0'
  const outName = withAmmo ? 'ammoBrowser.json' : 'ammoBrowser-noammo.json'
  // ?only=substring — a single clip, for analysis.
  const only = params.get('only')
  const all: AmmoEntry[] = manifest.entries
  const picked = only ? all.filter((e) => e.slug.includes(only)) : all
  const entries = limit > 0 ? picked.slice(0, limit) : picked

  const rows: Row[] = []
  for (const [i, entry] of entries.entries()) {
    const started = performance.now()
    // An array, not a variable: the value arrives from a callback, and type narrowing
    // would otherwise consider it null forever.
    const captured: (AmmoResult | AmmoRejection)[] = []
    onAmmoTrace((r) => captured.push(r))

    try {
      const file = await fetch(`/__ammo/${entry.slug}.mp4`).then((r) => r.blob())
      const shots = entry.candidates.map((time) => ({ time, strength: 1, relativeLoudness: 0 }))
      const scored = await scoreShotsByMotion(file, shots, entry.duration, { ammo: withAmmo })
      const t = captured.length ? captured[captured.length - 1] : null
      const covered = t !== null && t.times !== null
      rows.push({
        slug: entry.slug,
        covered,
        reason: covered ? null : ((t as AmmoRejection | null)?.reason ?? 'счётчик не запускался'),
        times: covered ? scored.map((s) => s.time) : [],
        slot: covered ? (t as AmmoResult).slot : null,
        magazine: covered ? (t as AmmoResult).score.magazine : null,
        descents: covered ? (t as AmmoResult).score.descents : 0,
        best: covered ? null : ((t as AmmoRejection | null)?.best ?? null),
        slots: covered ? (t as AmmoResult).slots : ((t as AmmoRejection | null)?.slots ?? null),
        series: covered ? (t as AmmoResult).series : null,
        // Read spans — the label source for each stretch of the video is chosen by them.
        readSpans: covered ? (t as AmmoResult).readSpans : [],
        shotsVideo: covered ? (t as AmmoResult).shotsVideo : [],
        offset: covered ? (t as AmmoResult).alignment.offset : 0,
        snapped: covered ? (t as AmmoResult).alignment.snapped : 0,
        seconds: Math.round((performance.now() - started) / 100) / 10,
      })
      const row = rows[rows.length - 1]
      log(
        `[${i + 1}/${entries.length}] ${covered ? 'да ' : 'НЕТ'} ${entry.slug.slice(0, 38).padEnd(38)} ` +
          `выстрелов=${String(row.times.length).padStart(4)}  ${String(row.seconds).padStart(5)}с  ${row.reason ?? ''}`,
      )
    } catch (error) {
      rows.push({
        slug: entry.slug,
        covered: false,
        reason: String(error),
        times: [],
        slot: null,
        magazine: null,
        descents: 0,
        best: null,
        slots: null,
        series: null,
        readSpans: [],
        shotsVideo: [],
        offset: 0,
        snapped: 0,
        seconds: Math.round((performance.now() - started) / 100) / 10,
      })
      log(`[${i + 1}/${entries.length}] ОШИБКА ${entry.slug}: ${String(error)}`)
    } finally {
      onAmmoTrace(null)
    }
    // Dump after EACH clip: the run is long, and the intermediate result is needed both
    // for analysis and in case the tab gets closed.
    await saveResult(outName, JSON.stringify(rows), 'application/json')
  }

  const message = await saveResult(outName, JSON.stringify(rows), 'application/json')
  log(`\nпокрыто ${rows.filter((r) => r.covered).length} из ${rows.length}; ${message}`)
  log('дальше: pnpm exec tsx eval/ammoCompare.ts')
}

void main()
