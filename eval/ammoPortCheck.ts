/**
 * Check of the PORTED counter logic against the Python one on the same series.
 *
 * What is checked is what makes decisions: slot identification, extracting shots from drops,
 * and aligning to the sound. Reading series are taken ready-made from Python
 * (`python/out/seriesDump.json`), so a divergence, if any, lies exactly in the ported logic,
 * not in frame parsing.
 *
 * Frame parsing is checked separately — by the page `eval/ammoBrowser.html`, which runs the
 * production code end to end. ONE factor is isolated here: a project rule paid for by the first
 * check changing the frame source and the selection scheme at once and giving a divergence
 * that meant nothing.
 *
 *   pnpm exec tsx eval/ammoPortCheck.ts
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { align } from '../src/domain/detection/ammo/align'
import { extractShots } from '../src/domain/detection/ammo/events'
import { scoreSeries } from '../src/domain/detection/ammo/identify'
import { PROJECT_ROOT } from './fixtures'

/** How close two moments must be to count as one decision. A millisecond is already different numbers. */
const SAME_S = 0.001

interface Dump {
  slug: string
  fps: number
  startTime: number
  frames: number[]
  values: number[]
  readRate: number
  pythonScore: number
  pythonMagazine: number | null
  pythonShots: number[]
}

async function main(): Promise<void> {
  const dumps: Dump[] = JSON.parse(await readFile(join(PROJECT_ROOT, 'python/out/seriesDump.json'), 'utf8'))
  const candidates: Record<string, { times: number[] }> = JSON.parse(
    await readFile(join(PROJECT_ROOT, 'python/out/audioCandidates.json'), 'utf8'),
  )

  let clipsSame = 0
  const problems: string[] = []
  console.log('клип'.padEnd(36) + 'балл ts/py      магазин     выстрелов ts/py   совпало')

  for (const d of dumps) {
    const series = { frames: d.frames, values: d.values, readRate: d.readRate }
    const score = scoreSeries(series, d.fps)
    const events = extractShots(series, d.fps, d.startTime)
    const aligned = align(events.times, candidates[d.slug]?.times ?? [])

    const used = new Set<number>()
    let same = 0
    for (const t of aligned.times) {
      for (let j = 0; j < d.pythonShots.length; j++) {
        if (used.has(j)) continue
        if (Math.abs(d.pythonShots[j] - t) <= SAME_S) {
          used.add(j)
          same++
          break
        }
      }
    }

    const total = Math.max(aligned.times.length, d.pythonShots.length)
    const ok = same === total && Math.abs(score.score - d.pythonScore) < 0.005 && score.magazine === d.pythonMagazine
    if (ok) clipsSame++
    else {
      if (Math.abs(score.score - d.pythonScore) >= 0.005) {
        problems.push(`${d.slug}: балл ${score.score.toFixed(3)} против ${d.pythonScore.toFixed(3)}`)
      }
      if (score.magazine !== d.pythonMagazine) {
        problems.push(`${d.slug}: магазин ${score.magazine} против ${d.pythonMagazine}`)
      }
      if (same !== total) problems.push(`${d.slug}: решений совпало ${same} из ${total}`)
    }

    console.log(
      d.slug.slice(0, 36).padEnd(36) +
        `${score.score.toFixed(2)}/${d.pythonScore.toFixed(2)}`.padEnd(16) +
        `${String(score.magazine)}/${String(d.pythonMagazine)}`.padEnd(12) +
        `${String(aligned.times.length).padStart(4)} / ${String(d.pythonShots.length).padEnd(4)}` +
        `${String(same).padStart(10)}${ok ? '' : '   <<<'}`,
    )
  }

  console.log(`\nсовпало полностью на ${clipsSame} клипах из ${dumps.length}`)
  if (problems.length) {
    console.log('\n--- расхождения')
    for (const p of problems) console.log('  ' + p)
    process.exit(1)
  } else {
    console.log('расхождений нет — перенесённая логика решает так же')
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
