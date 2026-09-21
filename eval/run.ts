/**
 * Offline scoring of the gunshot detector against the committed ground truth.
 *
 *   pnpm eval                     score every completed clip and diff against the baseline
 *   pnpm eval --verbose        also list the timestamps of each miss and false alarm
 *   pnpm eval --only <slug>    restrict to one or more clips (repeatable, or comma-separated)
 *   pnpm eval --include-drafts score clips whose labeling isn't finished yet
 *   pnpm eval --update-baseline  accept the current numbers as the new reference point
 *   pnpm eval --fail-on-regression  exit non-zero if aggregate F1 dropped
 *   pnpm eval --spectral       score the OLD spectral detector instead (for comparison)
 *
 * The PRODUCTION scheme is measured: candidates by the audio network, then the motion filter.
 * Previously this was `createDefaultDetector()` — the old spectral pipeline, which is on no
 * execution path in the app, and the baseline described it too.
 *
 * IMPORTANT about these numbers. The motion model is trained on ALL 49 clips with no held-out
 * set (the weights file itself says "do not measure quality on it"), and here it is checked
 * on the same clips. The inflation was measured with a control and is about 4 F1 points: honest
 * validation with folds by clip gives 59.7 versus 63.8 for the same training without a held-out
 * set. Honest numbers come from `pnpm exec tsx eval/trainMotionModel.ts`. These are only for
 * tracking regressions, and can only be compared with numbers of the same kind.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDefaultDetector, evaluateAll, TOLERANCES, type ClipResult, type EvaluationResult } from './evaluate'
import { loadAllFixtures, PROJECT_ROOT, type Fixture } from './fixtures'
import { createProductionDetector, MOTION_THRESHOLD } from './productionDetector'

const BASELINE_PATH = join(PROJECT_ROOT, 'eval/baseline.json')
/** F1 has to move by more than this to count as a real change rather than float noise. */
const REGRESSION_EPSILON = 0.0005

interface BaselineClip {
  f1: number
  precision: number
  recall: number
  truePositives: number
  falsePositives: number
  falseNegatives: number
}

interface Baseline {
  updatedAt: string
  note: string
  aggregate: BaselineClip & { hardRecall: number }
  clips: Record<string, BaselineClip>
}

interface Options {
  updateBaseline: boolean
  includeDrafts: boolean
  failOnRegression: boolean
  verbose: boolean
  spectral: boolean
  only: string[] | undefined
}

function parseArgs(argv: string[]): Options {
  const only: string[] = []
  const options: Options = {
    updateBaseline: false,
    includeDrafts: false,
    failOnRegression: false,
    verbose: false,
    spectral: false,
    only: undefined,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--update-baseline') options.updateBaseline = true
    else if (arg === '--include-drafts') options.includeDrafts = true
    else if (arg === '--fail-on-regression') options.failOnRegression = true
    else if (arg === '--verbose' || arg === '-v') options.verbose = true
    else if (arg === '--spectral') options.spectral = true
    else if (arg === '--only') only.push(...(argv[++i] ?? '').split(',').filter(Boolean))
    else throw new Error(`Unknown argument "${arg}"`)
  }

  if (only.length > 0) options.only = only
  return options
}

const useColor = process.stdout.isTTY
const dim = (text: string) => (useColor ? `\u001b[2m${text}\u001b[0m` : text)
const bold = (text: string) => (useColor ? `\u001b[1m${text}\u001b[0m` : text)
const green = (text: string) => (useColor ? `\u001b[32m${text}\u001b[0m` : text)
const red = (text: string) => (useColor ? `\u001b[31m${text}\u001b[0m` : text)

function percent(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—'
}

function milliseconds(value: number): string {
  return Number.isFinite(value) ? `${(value * 1000).toFixed(1)}` : '—'
}

/** Formats a signed F1 delta, or a placeholder when there's nothing to compare against. */
function formatDelta(current: number, previous: number | undefined): string {
  if (previous === undefined) return dim('  новый')
  const delta = current - previous
  if (Math.abs(delta) <= REGRESSION_EPSILON) return dim('     =')
  const text = `${delta > 0 ? '+' : ''}${(delta * 100).toFixed(1)}`.padStart(6)
  return delta > 0 ? green(text) : red(text)
}

function printTable(rows: string[][], alignRight: Set<number>): void {
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => stripAnsi(row[column] ?? '').length)),
  )
  rows.forEach((row, rowIndex) => {
    const line = row
      .map((cell, column) => {
        const padding = widths[column] - stripAnsi(cell).length
        return alignRight.has(column) ? ' '.repeat(padding) + cell : cell + ' '.repeat(padding)
      })
      .join('  ')
    console.log(rowIndex === 0 ? bold(line) : line)
    if (rowIndex === 0) console.log(dim('─'.repeat(line.length)))
  })
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

function clipLabel(clip: ClipResult): string {
  const name = clip.clip.replace(/\.[^.]+$/, '')
  return name.length > 38 ? `${name.slice(0, 37)}…` : name
}

async function readBaseline(): Promise<Baseline | null> {
  try {
    return JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as Baseline
  } catch {
    return null
  }
}

function toBaseline(result: EvaluationResult): Baseline {
  const clips: Record<string, BaselineClip> = {}
  for (const clip of result.clips) {
    clips[clip.slug] = {
      f1: clip.loose.f1,
      precision: clip.loose.precision,
      recall: clip.loose.recall,
      truePositives: clip.loose.truePositives,
      falsePositives: clip.loose.falsePositives,
      falseNegatives: clip.loose.falseNegatives,
    }
  }
  return {
    updatedAt: new Date().toISOString(),
    note:
      `Продуктовая схема: кандидаты сетью ShotNet по звуку, затем фильтр по движению ` +
      `при пороге ${MOTION_THRESHOLD}. Цель — свои выстрелы, допуск ±${TOLERANCES.loose * 1000} мс, ` +
      `попадания по чужим считаются лишними метками. ` +
      `ЧИСЛА ЗАВЫШЕНЫ примерно на 4 пункта F1: модель движения обучена на всех клипах ` +
      `без отложенной выборки и проверяется здесь на них же. Честная проверка фолдами ` +
      `по клипам — pnpm exec tsx eval/trainMotionModel.ts. Годится для слежения за регрессиями, ` +
      `не годится как описание качества. Обновить: pnpm eval --update-baseline`,
    aggregate: {
      f1: result.aggregate.f1,
      precision: result.aggregate.precision,
      recall: result.aggregate.recall,
      truePositives: result.aggregate.truePositives,
      falsePositives: result.aggregate.falsePositives,
      falseNegatives: result.aggregate.falseNegatives,
      hardRecall: result.aggregate.hardRecall,
    },
    clips,
  }
}

/**
 * Totals separately for sparse and dense clips.
 *
 * The project's aggregate number is weighted toward dense fire: 902 of 1163 own shots are
 * in clips with twenty-plus shots. Yet quality splits exactly along this boundary — recall
 * 27% versus 83% — while the user uploads a highlight with a couple of kills.
 * A single aggregate F1 describes no real clip, so the halves are always printed.
 */
const SPARSE_MAX_OWN = 20

function printDensitySplit(result: EvaluationResult, fixtures: Fixture[]): void {
  const ownOf = new Map(
    fixtures.map((f) => [f.labels.slug, f.labels.shots.filter((s) => s.source === 'own').length]),
  )
  const halves: [string, ClipResult[]][] = [
    ['разреженные (≤20 своих)', result.clips.filter((c) => (ownOf.get(c.slug) ?? 0) <= SPARSE_MAX_OWN)],
    ['плотные (>20 своих)', result.clips.filter((c) => (ownOf.get(c.slug) ?? 0) > SPARSE_MAX_OWN)],
  ]
  console.log()
  for (const [name, clips] of halves) {
    if (!clips.length) continue
    let tp = 0
    let fp = 0
    let fn = 0
    for (const c of clips) {
      tp += c.loose.truePositives
      fp += c.loose.falsePositives
      fn += c.loose.falseNegatives
    }
    const p = tp / Math.max(1, tp + fp)
    const r = tp / Math.max(1, tp + fn)
    const f1 = (2 * p * r) / Math.max(1e-9, p + r)
    console.log(
      `      ${name.padEnd(24)} ${clips.length} клип(ов) · P ${percent(p)} · R ${percent(r)} · F1 ${bold(percent(f1))}`,
    )
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))

  const { fixtures, skipped } = await loadAllFixtures({
    requireComplete: !options.includeDrafts,
    only: options.only,
  })

  for (const entry of skipped) {
    console.log(dim(`пропущен ${entry.slug}: ${entry.reason}`))
  }

  if (fixtures.length === 0) {
    console.log('\nНечего оценивать. Размечай клипы в /labeler.html (pnpm dev), затем повтори.')
    console.log(dim('Разметка сохраняется в labels/, декодированное аудио — в examples/.cache/.'))
    return
  }

  let detect = createDefaultDetector()
  let missingMotion: string[] = []
  let scheme: 'blocks' | 'band' = 'band'
  let missingBlocks: string[] = []
  if (!options.spectral) {
    const production = await createProductionDetector(fixtures.map((f) => f.labels.slug))
    detect = production.detect
    missingMotion = production.missingMotion
    scheme = production.scheme
    missingBlocks = production.missingBlocks
  }

  const result = evaluateAll(fixtures, detect)
  // The baseline describes the production scheme. In --spectral mode there is nothing to
  // compare with it: this is a different detector, and a delta against it would mislead.
  const baseline = options.spectral ? undefined : await readBaseline()

  console.log(
    options.spectral
      ? dim('\nСХЕМА: старый спектральный поток (--spectral). В приложении её нет.')
      : dim(
          `\nСХЕМА: продуктовая — кандидаты сетью, фильтр по движению при пороге ${MOTION_THRESHOLD}.\n` +
            (scheme === 'blocks'
              ? '       Область оружия — двенадцать блоков, отобранных классификатором.'
              : '       Область оружия — полоса изменчивости (прежняя схема): нет кэша блоков.\n' +
                '       Считается так: pnpm exec tsx eval/weightedPrep.ts --prod, затем /eval/weighted.html,\n' +
                '       затем eval/.cache/weightedSignals.json переложить в blockSignals.json.'),
        ),
  )
  if (missingBlocks.length) {
    console.log(
      red(`Нет поблочных сигналов для ${missingBlocks.length} клип(ов) — они посчитаны ПРЕЖНЕЙ схемой: `) +
        dim(missingBlocks.slice(0, 4).join(', ') + (missingBlocks.length > 4 ? '…' : '')),
    )
  }
  if (missingMotion.length) {
    console.log(
      red(`Нет кэша движения для ${missingMotion.length} клип(ов) — они посчитаны ТОЛЬКО по звуку: `) +
        dim(missingMotion.slice(0, 4).join(', ') + (missingMotion.length > 4 ? '…' : '')),
    )
  }

  console.log(`\n${bold(`Детекция выстрелов · допуск ±${TOLERANCES.loose * 1000} мс`)}\n`)

  const rows: string[][] = [
    ['клип', 'свои', 'чужих', 'найдено', 'TP', 'FP', 'FN', 'правки', 'P', 'R', 'F1', 'ΔF1', '|Δt|мс', `F1@${TOLERANCES.strict * 1000}мс`],
  ]
  for (const clip of result.clips) {
    const edits = clip.loose.falsePositives + clip.loose.falseNegatives
    rows.push([
      clipLabel(clip),
      String(clip.referenceCount),
      String(clip.ignoredCount),
      String(clip.predictedCount),
      String(clip.loose.truePositives),
      String(clip.loose.falsePositives),
      String(clip.loose.falseNegatives),
      String(edits),
      percent(clip.loose.precision),
      percent(clip.loose.recall),
      percent(clip.loose.f1),
      formatDelta(clip.loose.f1, baseline?.clips[clip.slug]?.f1),
      milliseconds(clip.loose.medianAbsDelta),
      percent(clip.strict.f1),
    ])
  }
  printTable(rows, new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]))
  console.log(
    dim('\n«свои» — цель ассистента, «правки» = FP+FN (чужие попадания входят в FP), допуск ±50 мс'),
  )

  const { aggregate } = result
  const edits = aggregate.falsePositives + aggregate.falseNegatives
  console.log(
    `\n${bold('Итого')}  ${aggregate.clipCount} клип(ов) · TP ${aggregate.truePositives} · FP ${aggregate.falsePositives} · FN ${aggregate.falseNegatives} · правки ${edits}`,
  )
  console.log(
    `      precision ${percent(aggregate.precision)} · recall ${percent(aggregate.recall)} · F1 ${bold(percent(aggregate.f1))} ${formatDelta(aggregate.f1, baseline?.aggregate.f1).trim()}`,
  )
  console.log(
    `      recall на «тяжёлых» выстрелах ${percent(aggregate.hardRecall)} ${dim(`(${aggregate.hardTotal} шт.)`)}`,
  )

  printDensitySplit(result, fixtures)

  if (!options.spectral) {
    console.log(
      dim(
        '\nЭти числа ЗАВЫШЕНЫ: модель движения обучена на всех клипах без отложенной выборки\n' +
          '      и проверяется здесь на них же. Разница измерена и составляет около 4 пунктов F1.\n' +
          '      Честная проверка фолдами по клипам: pnpm exec tsx eval/trainMotionModel.ts',
      ),
    )
  }

  if (options.verbose) {
    for (const clip of result.clips) {
      if (clip.falseNegativeTimes.length === 0 && clip.falsePositiveTimes.length === 0) continue
      console.log(`\n${bold(clipLabel(clip))}`)
      if (clip.falseNegativeTimes.length > 0) {
        console.log(`  ${red('пропущено')}: ${clip.falseNegativeTimes.map((t) => t.toFixed(3)).join(', ')}`)
      }
      if (clip.falsePositiveTimes.length > 0) {
        console.log(`  ${red('лишнее')}:    ${clip.falsePositiveTimes.map((t) => t.toFixed(3)).join(', ')}`)
      }
    }
  }

  if (options.updateBaseline) {
    await writeFile(BASELINE_PATH, `${JSON.stringify(toBaseline(result), null, 2)}\n`)
    console.log(`\nБейзлайн обновлён: ${BASELINE_PATH}`)
  } else if (!baseline) {
    console.log(dim('\nБейзлайна нет. Зафиксируй текущие числа: pnpm eval --update-baseline'))
  } else if (options.failOnRegression && result.aggregate.f1 < baseline.aggregate.f1 - REGRESSION_EPSILON) {
    console.error(
      red(`\nРегрессия: F1 ${percent(result.aggregate.f1)} против ${percent(baseline.aggregate.f1)} в бейзлайне.`),
    )
    process.exitCode = 1
  }

  console.log('')
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
