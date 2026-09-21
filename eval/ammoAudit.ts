/**
 * Checks manual labels against the ammo counter — a report for the human who will go and
 * fix the labels.
 *
 * The comparison goes BY FIRING EPISODE, not by individual labels, and this is essential:
 * the counter reliably knows the NUMBER of shots in a burst, but the moment only to within
 * a frame. The proof is right in the report: "27 -> 24" means three shots, nothing to argue about.
 *
 * WHY NOT `python/tools/audit_labels.py`. It reads `python/out/clips.json`, and its reader
 * lags the production one by six fixes: splitting large and small glyphs, reserve ammo as a
 * weapon-switch cue, the read-share threshold, the fixed slot for `ssg08`. A report from the
 * outdated reader would send the human to fix labels according to readings the product
 * no longer produces.
 *
 * WHAT IS MISSING HERE, unlike the Python report. The browser run does not save the spans
 * where the counter was read, so the read share PER EPISODE is unknown. Instead the read
 * share for the whole clip is printed, and episodes without a single reading are marked
 * separately: a mismatch there does NOT mean a labelling error.
 *
 *   pnpm exec tsx eval/ammoAudit.ts                 # clips where the counter is readable
 *   pnpm exec tsx eval/ammoAudit.ts --clip nova     # a single clip
 *   pnpm exec tsx eval/ammoAudit.ts --all           # including already relabelled ones
 */
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseClipLabels } from '../src/domain/detection/labels'
import { LABELS_DIR, PROJECT_ROOT } from './fixtures'

/** Gap at which firing is cut into episodes: longer than the slowest automatic rifle,
 *  shorter than a typical pause between bursts. */
const EPISODE_GAP_S = 0.4
/** A drop larger than this per series step is not a burst but a read error ("12 -> 1 -> 11"). */
const MAX_STEP = 3
/** The commit in which 22 clips were relabelled by a human after checking against the counter. */
const RELABEL_COMMIT = '77b6d3b'

interface Row {
  slug: string
  covered: boolean
  times: number[]
  slot: { readRate: number; presence: number; y: number } | null
  series: [number, number][]
}

function episodes(times: number[], gap = EPISODE_GAP_S): [number, number][] {
  if (!times.length) return []
  const out: [number, number][] = []
  let start = times[0]
  let prev = times[0]
  for (const t of times.slice(1)) {
    if (t - prev > gap) {
      out.push([start, prev])
      start = t
    }
    prev = t
  }
  out.push([start, prev])
  return out
}

function merge(spans: [number, number][], gap = EPISODE_GAP_S): [number, number][] {
  if (!spans.length) return []
  const sorted = [...spans].sort((a, b) => a[0] - b[0])
  const out: [number, number][] = [[...sorted[0]] as [number, number]]
  for (const [a, b] of sorted.slice(1)) {
    if (a - out[out.length - 1][1] <= gap) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b)
    else out.push([a, b])
  }
  return out
}

/** What the counter showed in the episode and how many shots that is, or null if it cannot be trusted. */
function ammoChange(series: [number, number][], start: number, end: number): { path: string; shots: number | null } {
  // The value IN EFFECT at entry. Taking the last one "no later than the start" is wrong: the
  // first shot changes the counter almost simultaneously with the episode start, and its drop would be lost.
  const before = series.filter(([t]) => t <= start - 0.1)
  const inside = series.filter(([t]) => t > start - 0.1 && t <= end + 0.2)
  if (!inside.length) return { path: 'счётчик молчал', shots: null }

  const values = (before.length ? [before[before.length - 1][1]] : []).concat(inside.map(([, v]) => v))
  let shots = 0
  let reloaded = false
  let broken = false
  for (let i = 1; i < values.length; i++) {
    const a = values[i - 1]
    const b = values[i]
    if (b < a) {
      if (a - b > MAX_STEP) broken = true
      shots += a - b
    } else if (b > a) reloaded = true
  }

  let path = values.slice(0, 10).join(' -> ') + (values.length > 10 ? ' ...' : '')
  if (reloaded) path += '  [была перезарядка]'
  if (broken) return { path: path + '  [СБОЙ ЧТЕНИЯ: скачок больше чем на 3]', shots: null }
  return { path, shots }
}

/** Clips whose labels the human has already fixed by the counter. Taken from history, not from
 *  `labeledAt`: that relabelling did not update the date in the labels. */
function relabelled(): Set<string> {
  const out = execFileSync('git', ['show', '--name-only', '--format=', RELABEL_COMMIT], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  })
  return new Set(
    out
      .split('\n')
      .filter((n) => n.startsWith('labels/') && n.endsWith('.json'))
      .map((n) => n.slice('labels/'.length, -'.json'.length)),
  )
}

async function main(): Promise<void> {
  const one = process.argv.includes('--clip') ? process.argv[process.argv.indexOf('--clip') + 1] : null
  const all = process.argv.includes('--all')
  const rows: Row[] = JSON.parse(await readFile(join(PROJECT_ROOT, 'eval/.cache/ammoBrowser.json'), 'utf8'))
  const done = relabelled()

  const lines: string[] = []
  const summary: string[] = []
  for (const row of [...rows].sort((a, b) => a.slug.localeCompare(b.slug))) {
    if (!row.covered) continue
    if (one && !row.slug.includes(one)) continue
    if (!one && !all && done.has(row.slug)) continue

    const raw: unknown = JSON.parse(await readFile(join(LABELS_DIR, `${row.slug}.json`), 'utf8'))
    const labels = parseClipLabels(raw, `labels/${row.slug}.json`)
    if (!labels.complete) continue
    const own = labels.shots.filter((s) => s.source === 'own').map((s) => s.time).sort((a, b) => a - b)
    const events = [...row.times].sort((a, b) => a - b)
    const series = row.series ?? []

    const block: string[] = []
    let disagree = 0
    let silent = 0
    for (const [start, end] of merge(episodes(own).concat(episodes(events)))) {
      const inLabels = own.filter((t) => t >= start - 0.05 && t <= end + 0.05).length
      const inEvents = events.filter((t) => t >= start - 0.05 && t <= end + 0.05).length
      const { path, shots } = ammoChange(series, start, end)
      const expected = shots ?? inEvents
      if (inLabels === expected) continue

      const mark =
        shots === null
          ? (silent++, 'СЧЁТЧИК НЕ ГОВОРИТ — расхождение может быть не ваше')
          : (disagree++, expected > inLabels ? 'ДОБАВИТЬ' : 'ЛИШНИЕ')
      block.push(
        `  ${start.toFixed(2).padStart(7)}..${end.toFixed(2).padStart(6)}  размечено ${String(inLabels).padStart(3)}` +
          `   счётчик ${(shots === null ? '?' : String(shots)).padStart(3)}   ${mark}\n` +
          `      показания: ${path}`,
      )
    }

    const slot = row.slot
    const trust = !slot
      ? 'слота нет'
      : !(slot.y > 0.6 && slot.y < 1.0)
        ? 'СЛОТ НЕ В НИЖНЕЙ ЧАСТИ КАДРА — НЕ ПРАВИТЬ'
        : slot.presence < 0.55
          ? 'слот виден меньше половины клипа'
          : ''
    summary.push(
      `${row.slug.slice(0, 44).padEnd(46)} размечено ${String(own.length).padStart(3)}   ` +
        `счётчик ${String(events.length).padStart(3)}   спорных ${String(disagree).padStart(2)}   ` +
        `молчит ${String(silent).padStart(2)}   ${trust}`,
    )
    if (block.length) {
      lines.push(
        `\n=== ${row.slug}   размечено ${own.length}, счётчик ${events.length}, ` +
          `слот виден в ${((slot?.presence ?? 0) * 100).toFixed(0)}% клипа, читается ` +
          `${((slot?.readRate ?? 0) * 100).toFixed(0)}%` + (trust ? `   [${trust}]` : ''),
      )
      lines.push(...block)
    }
  }

  const text = [
    'СВЕРКА РАЗМЕТКИ СО СЧЁТЧИКОМ ПАТРОНОВ',
    '',
    'Сравнение по эпизодам стрельбы, а не по отдельным меткам: счётчик надёжно знает',
    'КОЛИЧЕСТВО выстрелов, а момент — только с точностью до кадра.',
    '',
    'Доля чтения ПО ЭПИЗОДУ здесь неизвестна (браузерный прогон её не сохраняет), поэтому',
    'эпизоды без единого показания помечены «СЧЁТЧИК НЕ ГОВОРИТ»: там расхождение может',
    'быть слепотой счётчика, а не ошибкой разметки. Ряд показаний хранит только МОМЕНТЫ',
    'ИЗМЕНЕНИЯ, поэтому спокойный участок в нём тоже выглядит молчанием.',
    '',
    ...summary,
    ...lines,
    '',
  ].join('\n')

  const out = join(PROJECT_ROOT, 'python/out', one ? `audit-${one}.txt` : 'audit-ts.txt')
  await writeFile(out, text)
  console.log(text)
  console.log(`отчёт записан в ${out}`)
}

void main()
