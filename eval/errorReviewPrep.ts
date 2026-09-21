/**
 * Prepares a review of second-stage errors: frames around the candidates where the motion
 * model was wrong — to look at them by eye and understand what it lacks.
 *
 *   pnpm exec tsx eval/errorReviewPrep.ts            # 2 errors of each kind per clip
 *   pnpm exec tsx eval/errorReviewPrep.ts --per-clip 4 --sparse
 *   pnpm dev                                # then open /eval/errorReview.html
 *   pnpm exec tsx eval/errorReviewPrep.ts --clean
 *
 * Why exactly this way. Error review by tables has already been done and hit a wall: it is
 * known THAT the model errs, but not WHAT IS IN THE FRAME at that moment. And that is the only
 * source of new features left after the feature path on 49 clips was exhausted
 * (docs/RESEARCH-journal.md, "Session summary").
 *
 * Selection targets the bulk of errors, not the spectacular ones. Composition measured (threshold 0.5):
 * of 527 extra labels, 83% sit where there is NO shot AT ALL, and only 17% on enemy shots;
 * the model cuts 166 own shots, and on sparse clips that is every third one versus every
 * twelfth on dense ones. So the error kind and clip density go into the manifest: they
 * must be looked at separately.
 *
 * The script only lays out material into `fixtures/__review/`; the browser extracts the frames,
 * because Node has no WebCodecs. Candidates and scores are computed HERE — the page shows exactly
 * the numbers the cases were selected by, not recomputed ones.
 */
import { copyFile, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURES_DIR, PROJECT_ROOT, audioFromChannels } from './fixtures'
import { decodeWavFile } from '../scripts/wavDecode'
import { toMono } from '../src/domain/audio/audioTypes'
import { parseClipLabels } from '../src/domain/detection/labels'
import { detectShotsWithNet } from '../src/domain/detection/shotNet/detectShotsWithNet'
import { deserializeWeights } from '../src/domain/detection/shotNet/shotNet'
import { motionFeaturesAt, MOTION_PARAMS, scoreMotion, type MotionModel } from '../src/domain/detection/motion/motionFeatures'
import { loadClipMotion } from './motionCache'

const OUT_DIR = join(FIXTURES_DIR, '__review')

/** Tolerance for matching against labels — the same as in eval/evaluate.ts (`TOLERANCES.loose`). */
const TOLERANCE_S = 0.05
/** The threshold the product runs at. An error is a decision mismatch at it. */
const MOTION_THRESHOLD = 0.5
/** Boundary between sparse and dense clips — quality splits along it (27% recall versus 83%). */
const SPARSE_MAX_OWN = 20
/** Frame offsets around the candidate, ms. The model's summary window is exactly ±250. */
const FRAME_OFFSETS_MS = [-400, -270, -170, -100, -33, 0, 33, 100, 170, 270, 400]

export type ErrorKind = 'fp' | 'fn'
export type Truth = 'own' | 'enemy' | 'noise'

export interface ReviewCase {
  id: string
  slug: string
  time: number
  /**
   * The nearest labelled shot and the signed distance to it, ms.
   *
   * Without this field the page lies. `truth: 'noise'` means "no own shot within the 50 ms
   * tolerance", not at all "there is no shot here": a candidate 63 ms from its own shot gets
   * the same caption as a candidate in the middle of silence. The reviewing human sees a shot
   * in the frames, reads "not a shot", and rightly distrusts the tool.
   */
  nearest: { dtMs: number; source: 'own' | 'enemy' } | null
  /** ShotNet confidence — also the 74th feature of the motion model. */
  audio: number
  /** Motion model score, 0..1. */
  score: number
  kind: ErrorKind
  truth: Truth
}

export interface ReviewClip {
  slug: string
  clip: string
  duration: number
  ownShots: number
  sparse: boolean
  /** The gameplay band and the "weapon" mask box — to see where the model is looking at all. */
  band: { y0: number; y1: number } | null
  maskBox: { x0: number; x1: number; y0: number; y1: number } | null
  maskPx: number | null
  /** Totals for the whole clip, not only for the selected cases. */
  totals: { candidates: number; fp: number; fn: number; kept: number }
}

export interface ReviewManifest {
  threshold: number
  toleranceS: number
  frameOffsetsMs: number[]
  clips: ReviewClip[]
  cases: ReviewCase[]
}

interface ClipPrep {
  clip: ReviewClip
  cases: ReviewCase[]
}

async function prepare(slug: string, weights: ReturnType<typeof deserializeWeights>, model: MotionModel, perClip: number): Promise<ClipPrep> {
  const rawLabels: unknown = JSON.parse(await readFile(join(PROJECT_ROOT, 'labels', `${slug}.json`), 'utf8'))
  const labels = parseClipLabels(rawLabels, `labels/${slug}.json`)
  if (!labels.complete) throw new Error('разметка не завершена')

  const clipPath = join(PROJECT_ROOT, 'examples', labels.clip)
  if (!existsSync(clipPath)) throw new Error(`нет клипа ${labels.clip}`)
  const motion = await loadClipMotion(slug)
  if (!motion) throw new Error('нет кэша движения')

  // The file name is the slug, not the original: clip names contain spaces and "#",
  // and "#" in a URL cuts the path into a fragment. A link, not a copy: on the whole set that is 637 MB.
  const linkPath = join(OUT_DIR, `${slug}.mp4`)
  if (!existsSync(linkPath)) await symlink(clipPath, linkPath)

  const decoded = decodeWavFile(await readFile(join(PROJECT_ROOT, 'examples/.cache', `${slug}.wav`)))
  const audio = audioFromChannels(decoded.channels, decoded.sampleRate)
  const candidates = detectShotsWithNet(toMono(audio), audio.sampleRate, weights, {
    threshold: MOTION_PARAMS.candidateThreshold,
  })

  const own = labels.shots.filter((s) => s.source === 'own').map((s) => s.time).sort((a, b) => a - b)
  const enemy = labels.shots.filter((s) => s.source !== 'own').map((s) => s.time)
  const near = (t: number, arr: number[]): boolean => arr.some((x) => Math.abs(x - t) <= TOLERANCE_S)

  const nearestShot = (t: number): ReviewCase['nearest'] => {
    let best: ReviewCase['nearest'] = null
    for (const shot of labels.shots) {
      const dtMs = (shot.time - t) * 1000
      if (!best || Math.abs(dtMs) < Math.abs(best.dtMs)) {
        best = { dtMs: Math.round(dtMs), source: shot.source === 'own' ? 'own' : 'enemy' }
      }
    }
    return best
  }

  const fp: ReviewCase[] = []
  const fn: ReviewCase[] = []
  let kept = 0
  for (const c of candidates) {
    const features = motionFeaturesAt(motion.zone, motion.weapon, c.time, c.confidence)
    // At the clip edge the window degenerates and prod keeps the audio confidence — same here,
    // otherwise error selection would describe a decision other than the one the user sees.
    const score = features ? scoreMotion(model, features) : c.confidence
    const isOwn = near(c.time, own)
    const truth: Truth = isOwn ? 'own' : near(c.time, enemy) ? 'enemy' : 'noise'
    const passes = score >= MOTION_THRESHOLD
    if (passes) kept++
    const base = {
      id: `${slug}@${c.time.toFixed(3)}`,
      slug,
      time: c.time,
      audio: c.confidence,
      score,
      truth,
      nearest: nearestShot(c.time),
    }
    if (passes && !isOwn) fp.push({ ...base, kind: 'fp' })
    else if (!passes && isOwn) fn.push({ ...base, kind: 'fn' })
  }

  // EXTREME cases are taken: the most confident extra labels and the most confidently cut own shots.
  // The middle near the threshold is informative for calibration but not for finding a feature —
  // the model is already unsure there, and the eye has nothing to explain.
  fp.sort((a, b) => b.score - a.score)
  fn.sort((a, b) => a.score - b.score)

  return {
    clip: {
      slug,
      clip: labels.clip,
      duration: labels.duration,
      ownShots: own.length,
      sparse: own.length <= SPARSE_MAX_OWN,
      band: motion.weapon?.band ?? null,
      maskBox: motion.weapon?.maskBox ?? null,
      maskPx: motion.weapon?.maskPx ?? null,
      totals: { candidates: candidates.length, fp: fp.length, fn: fn.length, kept },
    },
    cases: [...fp.slice(0, perClip), ...fn.slice(0, perClip)],
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--clean')) {
    await rm(OUT_DIR, { recursive: true, force: true })
    console.log('fixtures/__review удалён')
    return
  }

  const perClipArg = args.indexOf('--per-clip')
  const perClip = perClipArg >= 0 ? Number(args[perClipArg + 1]) : 2
  const sparseOnly = args.includes('--sparse')
  const explicit = args.filter((a, i) => !a.startsWith('-') && args[i - 1] !== '--per-clip')

  const wanted = explicit.length
    ? explicit
    : (await readdir(join(PROJECT_ROOT, 'labels')))
        .filter((n) => n.endsWith('.json'))
        .map((n) => n.slice(0, -'.json'.length))
        .sort()

  await mkdir(OUT_DIR, { recursive: true })
  const weights = deserializeWeights(await readFile(join(PROJECT_ROOT, 'public/models/shotNet.json'), 'utf8'))
  const model: MotionModel = JSON.parse(await readFile(join(FIXTURES_DIR, 'models/motionModel.json'), 'utf8'))
  await copyFile(join(FIXTURES_DIR, 'models/motionModel.json'), join(OUT_DIR, 'motionModel.json'))

  const clips: ReviewClip[] = []
  const cases: ReviewCase[] = []
  for (const slug of wanted) {
    try {
      const prepped = await prepare(slug, weights, model, perClip)
      if (sparseOnly && !prepped.clip.sparse) continue
      clips.push(prepped.clip)
      cases.push(...prepped.cases)
      const t = prepped.clip.totals
      console.log(
        `${slug.padEnd(50)} своих ${String(prepped.clip.ownShots).padStart(3)} ` +
          `${prepped.clip.sparse ? 'разрежен' : 'плотный '} лишних ${String(t.fp).padStart(3)} зарезано ${String(t.fn).padStart(3)}`,
      )
    } catch (error) {
      console.log(`${slug.padEnd(50)} пропущен — ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const manifest: ReviewManifest = {
    threshold: MOTION_THRESHOLD,
    toleranceS: TOLERANCE_S,
    frameOffsetsMs: FRAME_OFFSETS_MS,
    clips,
    cases,
  }
  await writeFile(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))

  const totals = clips.reduce((a, c) => ({ fp: a.fp + c.totals.fp, fn: a.fn + c.totals.fn }), { fp: 0, fn: 0 })
  const byTruth = (t: Truth): number => cases.filter((c) => c.truth === t).length
  console.log()
  console.log(`клипов ${clips.length}, ошибок всего: лишних ${totals.fp}, зарезано своих ${totals.fn}`)
  console.log(`к разбору отобрано ${cases.length}: не выстрел ${byTruth('noise')}, чужой ${byTruth('enemy')}, свой зарезанный ${byTruth('own')}`)
  console.log()
  console.log('Запустить dev-сервер и открыть /eval/errorReview.html')
  console.log('После разбора: pnpm exec tsx eval/errorReviewPrep.ts --clean')
}

void main()
