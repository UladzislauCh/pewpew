/**
 * Analysis of series from `eval/weaponSignal.html`: does the HUMAN-LABELLED weapon region give
 * a signal that the heuristic region lacks.
 *
 *   pnpm exec tsx eval/weaponSignalEval.ts            # expects eval/.cache/weaponSignals.json
 *
 * AUC is measured on three splits, and they answer DIFFERENT questions:
 *
 *  - own versus enemy — what the video stage exists for in the first place, but that is only 17%
 *    of extra labels (measured over 49 clips: of 527 extras only 90 sit on enemy shots);
 *  - own versus noise — 83% of extra labels, i.e. the real bottleneck;
 *  - and separately on SPARSE clips, where recall is 27% versus 83% on dense ones.
 *
 * The split by density is not decoration here: the project's aggregate numbers are weighted
 * toward dense fire (902 of 1163 own shots are in dense clips), and this metric has already
 * rejected directions that might have helped sparse ones.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PROJECT_ROOT } from './fixtures'

const SIGNALS_PATH = join(PROJECT_ROOT, 'eval/.cache/weaponSignals.json')
const MANIFEST_PATH = join(PROJECT_ROOT, 'fixtures/__signal/manifest.json')

const TOLERANCE_S = 0.05

/**
 * Half-window around the candidate. Set by `--half`, 40 ms by default — about one frame.
 *
 * The model's window is ±250 ms, and for camera-motion summaries that is sensible. For the
 * RESIDUAL inside the weapon region it is not: the median interval between own shots is 88 ms,
 * so a ±250 ms window catches neighbouring shots, and the "own" and "not own" pools mix.
 * Measured on the human region, feature resid, "own versus everything":
 *
 *   ±250 ms → 0.579     ±130 → 0.639     ±90 → 0.661     ±60 → 0.680     ±40 → 0.695
 *
 * Shifting the window centre (`--offset`) was checked over −120…+30 ms and changes almost
 * nothing: at ±40 ms the best value is at zero. So the residual peaks at the time of the SOUND,
 * not earlier — unlike the camera kick, which peaks at −30 ms.
 */
const argOf = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback
}
const HALF_MS = argOf('--half', 40)
const OFFSET_MS = argOf('--offset', 0)
const SPARSE_MAX_OWN = 20

interface Signals {
  frames: number
  fps: number
  dx: number[]
  dy: number[]
  resid: number[]
  diff: number[]
  bright: number[]
}

interface Entry {
  slug: string
  duration: number
  ownShots: number[]
  enemyShots: number[]
  candidates: { time: number; confidence: number }[]
}

/** Area under the ROC with correct handling of ties. */
function auc(pos: number[], neg: number[]): number {
  if (!pos.length || !neg.length) return NaN
  const all = [...pos.map((v) => [v, 1] as const), ...neg.map((v) => [v, 0] as const)].sort((a, b) => a[0] - b[0])
  let rankSum = 0
  let i = 0
  while (i < all.length) {
    let j = i
    while (j < all.length && all[j][0] === all[i][0]) j++
    const avgRank = (i + j + 1) / 2
    for (let k = i; k < j; k++) if (all[k][1]) rankSum += avgRank
    i = j
  }
  return (rankSum - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length)
}

/** Summary of a series over a window around a time: peak and mean. Peak because the event is short. */
function windowStats(sig: number[], fps: number, time: number, halfMs = HALF_MS): { peak: number; mean: number } | null {
  const centre = Math.round((time + OFFSET_MS / 1000) * fps)
  const r = Math.max(1, Math.round((halfMs / 1000) * fps))
  const f0 = Math.max(1, centre - r)
  const f1 = Math.min(sig.length - 1, centre + r)
  if (f1 < f0) return null
  let peak = -Infinity
  let sum = 0
  for (let f = f0; f <= f1; f++) {
    peak = Math.max(peak, sig[f])
    sum += sig[f]
  }
  return { peak, mean: sum / (f1 - f0 + 1) }
}

/**
 * Within-clip normalisation is mandatory.
 *
 * Videos are recorded by different people with different cameras and bitrates, and the
 * absolute residual level does not transfer between them — the journal caught this three times.
 * Careful: normalising model FEATURES was measured as harmful (2.20x → 1.36x); what is normalised
 * here is not a training feature but the scale for COMPARING regions with each other.
 */
function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b)
  return s[s.length >> 1] ?? 1
}

type Split = 'ownVsEnemy' | 'ownVsNoise' | 'ownVsRest'

async function main(): Promise<void> {
  if (!existsSync(SIGNALS_PATH)) {
    console.log(`нет ${SIGNALS_PATH}`)
    console.log('Сначала: pnpm exec tsx eval/weaponSignalPrep.ts, затем /eval/weaponSignal.html,')
    console.log('и положить скачанный weaponSignals.json в eval/.cache/')
    return
  }
  const signals = JSON.parse(await readFile(SIGNALS_PATH, 'utf8')) as {
    boxSize: number
    maxShift: number
    clips: Record<string, { human: Signals | null; auto: Signals | null; note: string }>
  }
  const { entries } = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as { entries: Entry[] }

  const FEATURES = ['resid', 'diff', 'bright', 'absdy'] as const
  type Feature = (typeof FEATURES)[number]

  const pull = (s: Signals, f: Feature): number[] =>
    f === 'absdy' ? s.dy.map(Math.abs) : (s[f] as number[])

  // Value pools: [region][feature][split][class]
  const pools: Record<'human' | 'auto', Record<Feature, Record<string, number[]>>> = {
    human: {} as never,
    auto: {} as never,
  }
  for (const area of ['human', 'auto'] as const) {
    pools[area] = {} as never
    for (const f of FEATURES) {
      pools[area][f] = { own: [], enemy: [], noise: [], ownSparse: [], restSparse: [], ownDense: [], restDense: [] }
    }
  }

  let usedClips = 0
  for (const e of entries) {
    const s = signals.clips[e.slug]
    if (!s) continue
    const sparse = e.ownShots.length <= SPARSE_MAX_OWN
    const near = (t: number, arr: number[]): boolean => arr.some((x) => Math.abs(x - t) <= TOLERANCE_S)
    let touched = false

    for (const area of ['human', 'auto'] as const) {
      const sig = s[area]
      if (!sig) continue
      touched = true
      for (const f of FEATURES) {
        const series = pull(sig, f)
        const scale = median(series.filter((v) => v > 0)) || 1
        for (const c of e.candidates) {
          const w = windowStats(series, sig.fps, c.time)
          if (!w) continue
          const value = w.peak / scale
          const isOwn = near(c.time, e.ownShots)
          const cls = isOwn ? 'own' : near(c.time, e.enemyShots) ? 'enemy' : 'noise'
          pools[area][f][cls].push(value)
          const bucket = sparse ? (isOwn ? 'ownSparse' : 'restSparse') : isOwn ? 'ownDense' : 'restDense'
          pools[area][f][bucket].push(value)
        }
      }
    }
    if (touched) usedClips++
  }

  const splits: { name: string; key: Split; pos: string; neg: string[] }[] = [
    { name: 'свой против чужого', key: 'ownVsEnemy', pos: 'own', neg: ['enemy'] },
    { name: 'свой против шума', key: 'ownVsNoise', pos: 'own', neg: ['noise'] },
    { name: 'свой против всего', key: 'ownVsRest', pos: 'own', neg: ['enemy', 'noise'] },
  ]

  console.log(`клипов с рядами ${usedClips}, область ${signals.boxSize}x${signals.boxSize}, предел сдвига ${signals.maxShift}`)
  console.log(`окно ±${HALF_MS} мс, сдвиг центра ${OFFSET_MS} мс`)
  console.log(`кандидатов: свои ${pools.human.resid.own.length}, чужие ${pools.human.resid.enemy.length}, шум ${pools.human.resid.noise.length}`)
  console.log()
  console.log('AUC по пику признака в окне ±250 мс, нормировано медианой клипа')
  console.log()
  console.log('  признак'.padEnd(12), 'разделение'.padEnd(22), 'ЧЕЛОВЕК'.padStart(9), 'эвристика'.padStart(10), 'разница'.padStart(9))
  console.log('  ' + '-'.repeat(64))
  for (const f of FEATURES) {
    for (const sp of splits) {
      const val = (area: 'human' | 'auto'): number =>
        auc(pools[area][f][sp.pos], sp.neg.flatMap((n) => pools[area][f][n]))
      const h = val('human')
      const a = val('auto')
      const d = h - a
      console.log(
        `  ${f.padEnd(10)}`,
        sp.name.padEnd(22),
        h.toFixed(3).padStart(9),
        a.toFixed(3).padStart(10),
        `${d >= 0 ? '+' : ''}${d.toFixed(3)}`.padStart(9),
      )
    }
    console.log()
  }

  console.log('по половинам набора, «свой против всего»:')
  console.log('  признак'.padEnd(12), 'набор'.padEnd(14), 'ЧЕЛОВЕК'.padStart(9), 'эвристика'.padStart(10), 'разница'.padStart(9))
  console.log('  ' + '-'.repeat(56))
  for (const f of FEATURES) {
    for (const [name, pos, neg] of [
      ['разреженные', 'ownSparse', 'restSparse'],
      ['плотные', 'ownDense', 'restDense'],
    ] as const) {
      const h = auc(pools.human[f][pos], pools.human[f][neg])
      const a = auc(pools.auto[f][pos], pools.auto[f][neg])
      console.log(
        `  ${f.padEnd(10)}`,
        name.padEnd(14),
        h.toFixed(3).padStart(9),
        a.toFixed(3).padStart(10),
        `${h - a >= 0 ? '+' : ''}${(h - a).toFixed(3)}`.padStart(9),
      )
    }
  }
  console.log()
  console.log('Ориентиры: звук в одиночку 0.546, вся 74-признаковая модель 0.910,')
  console.log('невязка в человеческой области по журналу 0.949 (5 клипов, «свой против чужого»).')
}

void main()
