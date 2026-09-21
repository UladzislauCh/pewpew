/**
 * Checks browser decoding against the reference the motion model was trained on.
 *
 * The material is laid out by `eval/decodeCheckPrep.ts`, the page is `eval/decodeCheck.html`.
 *
 * What exactly is checked. Frames from mediabunny/WebCodecs go through THE SAME code
 * (`computeZoneMotion`, `findGameplayBand`, `computeWeaponMotion`, `motionFeaturesAt`,
 * `scoreMotion`) as in the product, and the result is compared with the `eval/.cache/motion`
 * caches taken from `frametool` frames. Features and scores FOR BOTH SIDES ARE COMPUTED RIGHT
 * HERE, from the same code: the only difference between the branches is where the pixels came from.
 *
 * Look at the bottom rows, not the top ones. The pixels are known to differ, and the per-shift
 * series will diverge; the question is whether the divergence survives to the model score and
 * to the decision at the threshold, i.e. whether the labels the user sees change.
 */
import {
  computeWeaponMotion,
  computeZoneMotion,
  findGameplayBand,
  motionFeaturesAt,
  scoreMotion,
  type MotionModel,
  type WeaponMotion,
  type ZoneMotion,
} from '../src/domain/detection/motion/motionFeatures'
import { decodeGrayFrames, FULL_FRAME_SIZE, WEAPON_HEIGHT, WEAPON_WIDTH } from '../src/domain/detection/motion/frameSource'
import { assertMotionModel } from '../src/domain/detection/motion/motionFeatures'
import { scoreDetections } from '../src/domain/detection/detectionMetrics'

interface CheckEntry {
  slug: string
  clip: string
  duration: number
  candidates: { time: number; confidence: number }[]
  ownShots: number[]
}

/** Tolerance for matching against labels — the same as in eval/evaluate.ts (`TOLERANCES.loose`). */
const TOLERANCE_S = 0.05

/** Thresholds at which DECISION agreement is counted. 0.5 is in the product, 0.6 is better by F1. */
const DECISION_THRESHOLDS = [0.5, 0.6]

const out = document.getElementById('out') as HTMLPreElement
function log(line = ''): void {
  out.textContent += `${line}\n`
  console.log(line)
}

function pearson(a: number[], b: number[]): number {
  const n = a.length
  if (n < 2) return NaN
  let ma = 0
  let mb = 0
  for (let i = 0; i < n; i++) {
    ma += a[i]
    mb += b[i]
  }
  ma /= n
  mb /= n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma
    const y = b[i] - mb
    num += x * y
    da += x * x
    db += y * y
  }
  return da === 0 || db === 0 ? NaN : num / Math.sqrt(da * db)
}

/** Share of exactly matching samples and maximum divergence over a pair of series. */
function compareSeries(mine: Float64Array[], ref: Float64Array[]): { exact: number; max: number; n: number } {
  let same = 0
  let n = 0
  let max = 0
  for (let z = 0; z < mine.length; z++) {
    const a = mine[z]
    const b = ref[z]
    const len = Math.min(a.length, b.length)
    for (let i = 0; i < len; i++) {
      const d = Math.abs(a[i] - b[i])
      if (d > max) max = d
      // Series are rounded to three digits on both sides, so the comparison is exact, not
      // with a tolerance: rounding is exactly what the sign-change count relies on.
      if (d === 0) same++
      n++
    }
  }
  return { exact: n ? same / n : NaN, max, n }
}

function parseZone(raw: {
  grid: number
  frames: number
  fps: number
  dx: number[][]
  dy: number[][]
}): ZoneMotion {
  return {
    grid: raw.grid,
    frames: raw.frames,
    fps: raw.fps,
    dx: raw.dx.map((a) => Float64Array.from(a)),
    dy: raw.dy.map((a) => Float64Array.from(a)),
  }
}

function parseWeapon(raw: {
  frames: number
  fps: number
  band: { y0: number; y1: number }
  maskPx: number
  maskBox: { x0: number; x1: number; y0: number; y1: number }
  dx: number[]
  dy: number[]
}): WeaponMotion {
  return {
    frames: raw.frames,
    fps: raw.fps,
    band: raw.band,
    maskPx: raw.maskPx,
    maskBox: raw.maskBox,
    dx: Float64Array.from(raw.dx),
    dy: Float64Array.from(raw.dy),
  }
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const r = await fetch(url)
  if (!r.ok) return null
  return (await r.json()) as T
}

interface ClipResult {
  slug: string
  frames: { mine: number; ref: number }
  zoneDy: { exact: number; max: number }
  zoneDx: { exact: number; max: number }
  band: { mine: { y0: number; y1: number } | null; ref: { y0: number; y1: number } | null }
  weapon: { minePx: number | null; refPx: number | null; dyExact: number; dxExact: number } | null
  scores: { n: number; corr: number; maxDiff: number; meanDiff: number }
  decisions: { threshold: number; agree: number; flips: number }[]
  /** Label quality of each branch against the labels — the only judge if the branches diverged. */
  quality: { threshold: number; mine: ReturnType<typeof quality>; ref: ReturnType<typeof quality> }[]
  /** Candidates where the decision at 0.5 diverged: to see whether they sit at the threshold's edge. */
  flipped: { time: number; mine: number; ref: number; ownShot: boolean }[]
  seconds: number
}

function quality(ownShots: number[], marks: number[]) {
  const s = scoreDetections(ownShots, [...marks].sort((a, b) => a - b), TOLERANCE_S)
  return {
    marks: marks.length,
    tp: s.truePositives,
    fp: s.falsePositives,
    fn: s.falseNegatives,
    recall: s.recall,
    precision: s.precision,
    f1: s.f1,
  }
}

/** Pooled over clips, not mean F1: a clip with 60 shots must weigh more than one with five. */
function pooled(parts: { tp: number; fp: number; fn: number }[]) {
  let tp = 0
  let fp = 0
  let fn = 0
  for (const p of parts) {
    tp += p.tp
    fp += p.fp
    fn += p.fn
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn)
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  return { tp, fp, fn, precision, recall, f1 }
}

async function checkClip(entry: CheckEntry, model: MotionModel): Promise<ClipResult> {
  const started = performance.now()
  log(`--- ${entry.slug}`)
  log(`клип ${entry.clip}, ${entry.duration.toFixed(2)} с, кандидатов ${entry.candidates.length}`)

  const refZoneRaw = await fetchJson<Parameters<typeof parseZone>[0]>(`/__check/${entry.slug}.zone.json`)
  if (!refZoneRaw) throw new Error('нет эталона зон')
  const refZone = parseZone(refZoneRaw)
  const refWeaponRaw = await fetchJson<Parameters<typeof parseWeapon>[0]>(`/__check/${entry.slug}.weapon.json`)
  const refWeapon = refWeaponRaw ? parseWeapon(refWeaponRaw) : null

  const blob = await (await fetch(`/__check/${entry.slug}.mp4`)).blob()

  const full = await decodeGrayFrames(
    blob,
    { x0: 0, y0: 0, x1: 1, y1: 1 },
    FULL_FRAME_SIZE,
    FULL_FRAME_SIZE,
    entry.duration,
  )
  log(`кадров: ${full.frames} против ${refZone.frames} в эталоне, fps ${full.fps.toFixed(6)} против ${refZone.fps.toFixed(6)}`)

  const zone = computeZoneMotion(full)
  const dyCmp = compareSeries(zone.dy, refZone.dy)
  const dxCmp = compareSeries(zone.dx, refZone.dx)
  log(`зоны dy: точно совпало ${(dyCmp.exact * 100).toFixed(1)}%, максимум расхождения ${dyCmp.max.toFixed(3)} px`)
  log(`зоны dx: точно совпало ${(dxCmp.exact * 100).toFixed(1)}%, максимум расхождения ${dxCmp.max.toFixed(3)} px`)

  const band = findGameplayBand(zone)
  const refBand = refWeapon?.band ?? null
  log(`полоса игрового поля: ${band ? `${band.y0}–${band.y1}` : 'нет'} против ${refBand ? `${refBand.y0}–${refBand.y1}` : 'нет'}`)

  let weapon: WeaponMotion | null = null
  let weaponReport: ClipResult['weapon'] = null
  if (band) {
    const strip = await decodeGrayFrames(
      blob,
      { x0: 0, y0: band.y0, x1: 1, y1: band.y1 },
      WEAPON_WIDTH,
      WEAPON_HEIGHT,
      entry.duration,
    )
    weapon = computeWeaponMotion(strip, band)
    if (weapon && refWeapon) {
      const wdy = compareSeries([weapon.dy], [refWeapon.dy])
      const wdx = compareSeries([weapon.dx], [refWeapon.dx])
      weaponReport = {
        minePx: weapon.maskPx,
        refPx: refWeapon.maskPx,
        dyExact: wdy.exact,
        dxExact: wdx.exact,
      }
      log(`маска оружия: ${weapon.maskPx} px против ${refWeapon.maskPx}, габариты ${JSON.stringify(weapon.maskBox)} против ${JSON.stringify(refWeapon.maskBox)}`)
      log(`оружие dy: точно совпало ${(wdy.exact * 100).toFixed(1)}%, dx ${(wdx.exact * 100).toFixed(1)}%`)
    } else {
      log(`маска оружия: ${weapon ? `${weapon.maskPx} px` : 'не набралась'} против ${refWeapon ? `${refWeapon.maskPx} px` : 'нет эталона'}`)
    }
  }

  // Both branches are computed by the same code: the only difference is the pixel source.
  const mine: number[] = []
  const ref: number[] = []
  const times: number[] = []
  for (const c of entry.candidates) {
    const fMine = motionFeaturesAt(zone, weapon, c.time, c.confidence)
    const fRef = motionFeaturesAt(refZone, refWeapon, c.time, c.confidence)
    if (!fMine || !fRef) continue
    mine.push(scoreMotion(model, fMine))
    ref.push(scoreMotion(model, fRef))
    times.push(c.time)
  }

  let maxDiff = 0
  let sumDiff = 0
  for (let i = 0; i < mine.length; i++) {
    const d = Math.abs(mine[i] - ref[i])
    if (d > maxDiff) maxDiff = d
    sumDiff += d
  }
  const corr = pearson(mine, ref)
  log(`оценки модели на ${mine.length} кандидатах: корреляция ${corr.toFixed(4)}, максимум расхождения ${maxDiff.toFixed(4)}, среднее ${(sumDiff / (mine.length || 1)).toFixed(4)}`)

  const decisions = DECISION_THRESHOLDS.map((threshold) => {
    let agree = 0
    for (let i = 0; i < mine.length; i++) {
      if (mine[i] >= threshold === ref[i] >= threshold) agree++
    }
    const fraction = mine.length ? agree / mine.length : NaN
    log(`решение при пороге ${threshold.toFixed(1)}: совпало ${(fraction * 100).toFixed(1)}% (${mine.length - agree} расхождений из ${mine.length})`)
    return { threshold, agree: fraction, flips: mine.length - agree }
  })

  // Agreement with the reference is not the same as quality. If the branches diverged, the labels judge.
  const isOwn = (t: number): boolean => entry.ownShots.some((s) => Math.abs(s - t) <= TOLERANCE_S)
  const quals = DECISION_THRESHOLDS.map((threshold) => {
    const q = {
      threshold,
      mine: quality(entry.ownShots, times.filter((_, i) => mine[i] >= threshold)),
      ref: quality(entry.ownShots, times.filter((_, i) => ref[i] >= threshold)),
    }
    log(
      `против разметки при ${threshold.toFixed(1)}: браузер F1 ${(q.mine.f1 * 100).toFixed(1)} ` +
        `(${q.mine.marks} меток, полнота ${(q.mine.recall * 100).toFixed(1)}) | ` +
        `эталон F1 ${(q.ref.f1 * 100).toFixed(1)} (${q.ref.marks} меток, полнота ${(q.ref.recall * 100).toFixed(1)})`,
    )
    return q
  })

  const flipped: ClipResult['flipped'] = []
  for (let i = 0; i < mine.length; i++) {
    if (mine[i] >= DECISION_THRESHOLDS[0] !== (ref[i] >= DECISION_THRESHOLDS[0])) {
      flipped.push({ time: times[i], mine: mine[i], ref: ref[i], ownShot: isOwn(times[i]) })
    }
  }
  for (const f of flipped) {
    log(`  разошлось на ${f.time.toFixed(3)} с: браузер ${f.mine.toFixed(3)}, эталон ${f.ref.toFixed(3)}${f.ownShot ? ', это свой выстрел' : ''}`)
  }

  const seconds = (performance.now() - started) / 1000
  log(`время сверки ${seconds.toFixed(1)} с`)
  log()

  return {
    slug: entry.slug,
    frames: { mine: full.frames, ref: refZone.frames },
    zoneDy: { exact: dyCmp.exact, max: dyCmp.max },
    zoneDx: { exact: dxCmp.exact, max: dxCmp.max },
    band: { mine: band, ref: refBand },
    weapon: weaponReport,
    scores: { n: mine.length, corr, maxDiff, meanDiff: sumDiff / (mine.length || 1) },
    decisions,
    quality: quals,
    flipped,
    seconds,
  }
}

async function main(): Promise<void> {
  const manifest = await fetchJson<{ entries: CheckEntry[] }>('/__check/manifest.json')
  if (!manifest) {
    log('Нет /__check/manifest.json — сначала: pnpm exec tsx eval/decodeCheckPrep.ts')
    return
  }

  const model = (await fetchJson<MotionModel>('/models/motionModel.json')) as MotionModel
  assertMotionModel(model)

  const results: ClipResult[] = []
  for (const entry of manifest.entries) {
    try {
      results.push(await checkClip(entry, model))
    } catch (error) {
      log(`${entry.slug}: ОШИБКА ${error instanceof Error ? error.message : String(error)}`)
      log()
    }
  }

  log('=== сводка ===')
  log(
    'клип'.padEnd(20) + 'кадры'.padStart(12) + 'корр'.padStart(9) + 'реш 0.5'.padStart(10) +
      'F1 браузер'.padStart(12) + 'F1 эталон'.padStart(11),
  )
  for (const r of results) {
    log(
      r.slug.slice(0, 18).padEnd(20) +
        `${r.frames.mine}/${r.frames.ref}`.padStart(12) +
        r.scores.corr.toFixed(4).padStart(9) +
        `${(r.decisions[0].agree * 100).toFixed(1)}%`.padStart(10) +
        `${(r.quality[0].mine.f1 * 100).toFixed(1)}`.padStart(12) +
        `${(r.quality[0].ref.f1 * 100).toFixed(1)}`.padStart(11),
    )
  }

  log()
  const allScores = results.flatMap((r) => r.scores.n)
  const totalCandidates = allScores.reduce((a, b) => a + b, 0)
  const framesOk = results.filter((r) => r.frames.mine === r.frames.ref).length
  const bandOk = results.filter((r) => JSON.stringify(r.band.mine) === JSON.stringify(r.band.ref)).length
  log(`кадров сошлось: ${framesOk} клипов из ${results.length}; полоса игрового поля: ${bandOk} из ${results.length}`)

  for (let i = 0; i < DECISION_THRESHOLDS.length; i++) {
    const t = DECISION_THRESHOLDS[i]
    const flips = results.reduce((a, r) => a + r.decisions[i].flips, 0)
    const mine = pooled(results.map((r) => r.quality[i].mine))
    const ref = pooled(results.map((r) => r.quality[i].ref))
    log(
      `порог ${t.toFixed(1)}: расхождений решения ${flips} из ${totalCandidates} ` +
        `(${((1 - flips / totalCandidates) * 100).toFixed(2)}% совпало) | ` +
        `пул F1 браузер ${(mine.f1 * 100).toFixed(1)} против эталона ${(ref.f1 * 100).toFixed(1)}, ` +
        `меток ${mine.tp + mine.fp} против ${ref.tp + ref.fp}`,
    )
  }
  const corrs = results.map((r) => r.scores.corr).filter((c) => Number.isFinite(c)).sort((a, b) => a - b)
  if (corrs.length) {
    log(`корреляция оценок: медиана ${corrs[corrs.length >> 1].toFixed(4)}, минимум ${corrs[0].toFixed(4)} (${results.find((r) => r.scores.corr === corrs[0])?.slug})`)
  }

  ;(window as unknown as { __decodeCheck: unknown }).__decodeCheck = { done: true, results }
}

;(window as unknown as { __decodeCheck: unknown }).__decodeCheck = { done: false, results: [] }
void main().catch((error) => {
  log(`ОШИБКА: ${error instanceof Error ? error.message : String(error)}`)
  ;(window as unknown as { __decodeCheck: unknown }).__decodeCheck = { done: true, error: String(error), results: [] }
})
