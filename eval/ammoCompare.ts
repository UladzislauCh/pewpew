/**
 * Check of two counter-reader implementations: the production one (TypeScript, browser)
 * and the research one (Python).
 *
 * A rule paid for by five silent bugs: check DECISIONS, not intermediate series, and PER
 * CANDIDATE, not by summaries. A summary hides a breakage behind a plausible number —
 * the production path once computed from one camera and gave F1 66.0 against a reference 64.8,
 * i.e. it looked like a success.
 *
 * Look at the sign per clip, not at the mean: "better on 10, worse on 12" is noise,
 * "worse on 30 out of 46" is a loss.
 *
 *   pnpm exec tsx eval/ammoCompare.ts
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PROJECT_ROOT } from './fixtures'

/** How close two moments must be to count as the same decision. */
const SAME_S = 0.005

interface BrowserRow {
  slug: string
  covered: boolean
  reason: string | null
  times: number[]
  slot: { x: number; y: number } | null
  offset: number
  seconds: number
}

interface PythonRow {
  slug: string
  covered: boolean
  shots: number[]
  slot?: { x: number; y: number }
  alignOffset?: number
  rejected?: string | null
}

function matchCount(a: number[], b: number[]): number {
  const used = new Set<number>()
  let hits = 0
  for (const x of a) {
    for (let j = 0; j < b.length; j++) {
      if (used.has(j)) continue
      if (Math.abs(b[j] - x) <= SAME_S) {
        used.add(j)
        hits++
        break
      }
    }
  }
  return hits
}

async function main(): Promise<void> {
  const browser: BrowserRow[] = JSON.parse(
    await readFile(join(PROJECT_ROOT, 'eval/.cache/ammoBrowser.json'), 'utf8'),
  )
  const python: PythonRow[] = JSON.parse(await readFile(join(PROJECT_ROOT, 'python/out/clips.json'), 'utf8'))
  const byPython = new Map(python.map((r) => [r.slug, r]))

  let sameCoverage = 0
  let differentCoverage = 0
  let totalBrowser = 0
  let totalPython = 0
  let totalSame = 0
  const problems: string[] = []

  console.log('клип'.padEnd(40) + 'покрытие      выстрелов     совпало   сдвиг')
  for (const row of browser) {
    const py = byPython.get(row.slug)
    if (!py) continue

    const coverage = row.covered === py.covered ? 'совпало' : `РАЗОШЛОСЬ (бр ${row.covered ? 'да' : 'нет'}, пи ${py.covered ? 'да' : 'нет'})`
    if (row.covered === py.covered) sameCoverage++
    else {
      differentCoverage++
      problems.push(`${row.slug}: покрытие ${coverage}; браузер «${row.reason ?? '—'}», питон «${py.rejected ?? '—'}»`)
    }

    const pyTimes = py.covered ? py.shots : []
    const same = matchCount(row.times, pyTimes)
    totalBrowser += row.times.length
    totalPython += pyTimes.length
    totalSame += same

    const agree = Math.max(row.times.length, pyTimes.length)
    const share = agree ? same / agree : 1
    if (row.covered && py.covered && share < 0.98) {
      problems.push(`${row.slug}: решений совпало ${same} из ${agree} (${(share * 100).toFixed(0)}%)`)
    }

    console.log(
      row.slug.slice(0, 40).padEnd(40) +
        coverage.padEnd(14) +
        `${String(row.times.length).padStart(4)} / ${String(pyTimes.length).padEnd(4)}` +
        `${String(same).padStart(9)}   ` +
        `${(row.offset * 1000).toFixed(0).padStart(5)} / ${((py.alignOffset ?? 0) * 1000).toFixed(0)}`,
    )
  }

  const share = Math.max(totalBrowser, totalPython)
  console.log('\n--- итог')
  console.log(`покрытие совпало на ${sameCoverage} клипах, разошлось на ${differentCoverage}`)
  console.log(
    `решений: браузер ${totalBrowser}, питон ${totalPython}, совпало ${totalSame} ` +
      `(${share ? ((100 * totalSame) / share).toFixed(1) : '—'}%)`,
  )
  console.log(`время: ${browser.reduce((a, r) => a + r.seconds, 0).toFixed(0)}с на ${browser.length} клипов`)

  if (problems.length) {
    console.log('\n--- расхождения')
    for (const p of problems) console.log('  ' + p)
  } else {
    console.log('\nрасхождений нет')
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
