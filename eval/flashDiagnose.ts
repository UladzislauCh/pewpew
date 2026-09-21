/**
 * Why a flash label diverged from the manual one: a breakdown of EVERY miss by cause.
 *
 * The question this was written for: the user sees a single label where there were two shots.
 * There are two completely different causes, and they are cured in opposite ways:
 *
 *   "no candidate"        — the sound did not hear the second shot. The flash threshold will not
 *                           help at all: there is nothing to confirm. This is the audio stage's ceiling.
 *   "candidate rejected"  — the sound heard it, but the flash did not confirm. This one is cured
 *                           by the threshold and window width, and here it prints what score
 *                           fell short.
 *
 * Until these two cases are separated, turning the threshold is pointless.
 *
 *   pnpm exec tsx eval/flashDiagnose.ts [tolerance]
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseClipLabels } from '../src/domain/detection/labels'
import { LABELS_DIR, PROJECT_ROOT } from './fixtures'
import { DEFAULT_FLASH_THRESHOLD } from '../src/domain/detection/flash/thresholds'

const TOLERANCE_S = Number(process.argv[2] ?? 0.05)
const THRESHOLD = Number(process.argv[3] ?? DEFAULT_FLASH_THRESHOLD)
/** How close shots must be to count as one burst. */
const BURST_GAP_S = 0.25

/**
 * Clips that are NOT COUNTED: a suppressed barrel physically has no flash, and when firing
 * scoped in the scope itself covers it. This is an absence of signal, not a selection error,
 * and mixing them with the rest means measuring the wrong thing. The user's decision.
 *
 * Selection is by clip name, and it is INCOMPLETE: compilation highlights (`biguzera`, `donk-insane`,
 * `kscerato`) cannot be classified by name, any weapon may turn up there.
 */
const EXCLUDED = /^(m4a1s|usp-0|mp5sd|awp|aug|g3sg1|scar20|ssg08|sg553)-/

interface Row {
  slug: string
  scored: { time: number; score: number }[]
}

async function main(): Promise<void> {
  const rows: Row[] = JSON.parse(
    await readFile(join(PROJECT_ROOT, 'eval/.cache/flashBrowser.json'), 'utf8'),
  )

  let own = 0
  let hit = 0
  let noCandidate = 0
  let rejected = 0
  const rejectedScores: number[] = []
  // Bursts: how many shots are in them and how many of those got a label.
  let burstShots = 0
  let burstHit = 0
  const partial: string[] = []

  let skipped = 0
  for (const row of rows) {
    if (!row.scored) continue
    if (EXCLUDED.test(row.slug)) {
      skipped++
      continue
    }
    const raw: unknown = JSON.parse(await readFile(join(LABELS_DIR, `${row.slug}.json`), 'utf8'))
    const labels = parseClipLabels(raw, `labels/${row.slug}.json`)
    if (!labels.complete) continue
    const shots = labels.shots.filter((s) => s.source === 'own').map((s) => s.time).sort((a, b) => a - b)

    const confirmed = row.scored.filter((s) => s.score >= THRESHOLD).map((s) => s.time)
    const near = (times: number[], t: number) => times.filter((x) => Math.abs(x - t) <= TOLERANCE_S)

    // Bursts: consecutive shots with gaps smaller than BURST_GAP_S.
    const groups: number[][] = []
    for (const t of shots) {
      const last = groups[groups.length - 1]
      if (last && t - last[last.length - 1] <= BURST_GAP_S) last.push(t)
      else groups.push([t])
    }

    for (const group of groups) {
      let got = 0
      for (const t of group) {
        own++
        if (near(confirmed, t).length) {
          hit++
          got++
          continue
        }
        const candidates = near(row.scored.map((s) => s.time), t)
        if (!candidates.length) {
          noCandidate++
        } else {
          rejected++
          const best = Math.max(...row.scored.filter((s) => Math.abs(s.time - t) <= TOLERANCE_S).map((s) => s.score))
          rejectedScores.push(best)
        }
      }
      if (group.length >= 2) {
        burstShots += group.length
        burstHit += got
        if (got > 0 && got < group.length) {
          partial.push(`${row.slug.slice(0, 30)}  ${group[0].toFixed(2)}  выстрелов ${group.length}, меток ${got}`)
        }
      }
    }
  }

  const pct = (n: number) => `${((100 * n) / Math.max(1, own)).toFixed(1)}%`
  console.log(`порог ${THRESHOLD}, допуск ${(TOLERANCE_S * 1000).toFixed(0)} мс, своих выстрелов ${own}`)
  console.log(`исключено клипов с глушителем и оптикой: ${skipped}\n`)
  console.log(`найдено             ${String(hit).padStart(4)}  ${pct(hit)}`)
  console.log(`НЕТ КАНДИДАТА       ${String(noCandidate).padStart(4)}  ${pct(noCandidate)}   <- порогом не лечится`)
  console.log(`кандидат отвергнут  ${String(rejected).padStart(4)}  ${pct(rejected)}   <- лечится порогом и окном`)

  if (rejectedScores.length) {
    rejectedScores.sort((a, b) => b - a)
    const q = (p: number) => rejectedScores[Math.floor(rejectedScores.length * p)].toFixed(3)
    console.log(`\nоценки отвергнутых: лучшая ${rejectedScores[0].toFixed(3)}, четверть выше ${q(0.25)},`)
    console.log(`                    медиана ${q(0.5)}, три четверти выше ${q(0.75)}`)
    for (const t of [0.3, 0.2, 0.1, 0.05]) {
      const gain = rejectedScores.filter((s) => s >= t).length
      console.log(`   порог ${t.toFixed(2)} вернул бы ${String(gain).padStart(3)} выстрелов (+${((100 * gain) / own).toFixed(1)} пункта полноты)`)
    }
  }

  console.log(`\nВ ОЧЕРЕДЯХ (выстрелы ближе ${(BURST_GAP_S * 1000).toFixed(0)} мс друг к другу):`)
  console.log(`   выстрелов ${burstShots}, получили метку ${burstHit} (${((100 * burstHit) / Math.max(1, burstShots)).toFixed(1)}%)`)
  console.log(`   очередей размечено НЕ ПОЛНОСТЬЮ: ${partial.length}`)
  for (const line of partial.slice(0, 15)) console.log(`     ${line}`)
}

void main()
