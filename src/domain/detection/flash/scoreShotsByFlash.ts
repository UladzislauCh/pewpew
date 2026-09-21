/**
 * Second stage: an audio candidate is confirmed by a MUZZLE FLASH in the frame.
 *
 * WHY CONFIRMATION RATHER THAN SEARCHING THE WHOLE VIDEO. The model runs only around
 * candidates: ~3 frames per shot instead of every frame of the clip, i.e. seconds instead
 * of tens of seconds in the browser. The cost of this choice is known and must be kept in
 * mind: recall is capped by the audio ceiling of 85.5% — what audio did not hear will not
 * appear here. In a dense burst several shots share one candidate, and this stage cannot
 * separate them in principle.
 *
 * WHY THE TIME COMES FROM AUDIO. A video frame is 33 ms, an audio grid step is 11.6 ms,
 * and the metric tolerance is 50 ms. The flash answers "yes or no", the moment stays from
 * audio: that makes the label three times more precise.
 *
 * LIMIT OF THE METHOD. Suppressed weapons have no flash, and scoped fire has almost none.
 * Measured on the corpus: `ak47` 100%, `glock` 100%, `dual-berettas` 93% — and `m4a1s`
 * (suppressor) 23%, `aug` (scope) 4%, `g3sg1` (scope) 0%. This is not a model defect but
 * an absent signal: a suppressed barrel physically has no flash.
 */
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny'
import type { DetectedShot } from '../shotDetection'
import type { Incoming, Outgoing } from './flashWorker'
import { DEFAULT_FLASH_THRESHOLD } from './thresholds'
import { findIntervals, placeByAudioPeaks, placeShots, type FlashInterval } from './intervals'
import { FASTEST_PERIOD_S } from './fireRates'

export { DEFAULT_FLASH_THRESHOLD }

export interface FlashScoredShot extends DetectedShot {
  /** Model confidence that this label's frame shows an own shot, 0..1. */
  flashScore: number
  /**
   * Maximum of EACH model class over the candidate window, in model class order.
   * Not needed by the product, needed by measurements: without it you cannot check what each class adds.
   */
  classScores: number[]
  /**
   * Flash box of the frame that confirmed the candidate, as fractions of the frame. `null` if
   * the candidate is not confirmed. Size and position tell "own flash or someone else's".
   */
  spot: { cx: number; cy: number; w: number; h: number } | null
  /** Period of the grid that produced the label, seconds. `null` means the label is not from a grid. */
  period?: number | null
  /**
   * The label was filled in from the burst rhythm rather than confirmed by a flash directly.
   * This shot's flash is in no frame — at 30 fps and a 10-20 ms flash, roughly every third
   * shot falls between frames.
   */
  filled?: boolean
  source: 'flash'
}

export interface FlashOptions {
  modelUrl?: string
  imgsz?: number
  /**
   * Frame search window around a candidate, in seconds: [back, forward].
   *
   * THE WINDOW IS ASYMMETRIC, and that is a measurement, not taste. Audio in these clips lags
   * the picture, differently for each clip: the median offset ranges from -133 ms to +33 ms,
   * and on seven clips of 28 it is -2 frames or worse. A symmetric ±1 frame window missed the
   * flash on all such clips at once.
   *
   * Window sweep at threshold 0.4 (Python pipeline, 32 clips):
   *
   *   window      recall  precision    F1
   *   [-1,+1]        63.5      67.2  65.3
   *   [-3,+1]        71.8      60.1  65.5   <- best by F1
   *   [-3,+2]        74.0      58.7  65.5
   *   [-6,+2]        78.5      52.8  63.2   <- used here
   *
   * The WIDEST was chosen, not the best by F1, and that is the user's decision: recall 78.5
   * against 71.8 is worth two points of F1 and eight points of precision. The rationale is the
   * asymmetric cost of errors: the user hunts a missed shot by ear, but removes an extra one
   * with the slider. The confidence threshold does apply to flash labels, so extras go away
   * in one move.
   */
  window?: [number, number]
  analysisWidth?: number
  onProgress?: (done: number, total: number) => void
}



const DEFAULTS = {
  modelUrl: '/models/flashNet416.onnx',
  imgsz: 640,
  // -200 ms is six frames at 30 fps, +67 ms is two forward.
  window: [-0.2, 0.067] as [number, number],
  analysisWidth: 640,
}

/**
 * Classes that mean an OWN shot. Class order is not hard-coded — names are taken from
 * `flashNet.meta.json`, because the set grows from version to version.
 *
 * `muzzle_flash` — flash at the barrel in normal fire.
 * `zoom_flash`, `zoom_tracer` — the same when firing scoped, where the flash looks different.
 *
 * Plain `tracer` is NOT included: a tracer is visible from others' fire too, and the project's
 * goal is own shots.
 *
 * The MAXIMUM over these classes is taken, not the sum: `zoom_flash` and `zoom_tracer`
 * routinely fire together on the same shot, and a sum would inflate confidence where there
 * is one signal.
 */
const OWN_SHOT_CLASSES = new Set(['muzzle_flash', 'zoom_flash', 'zoom_tracer'])

/**
 * Slack added to the frame search window, in seconds.
 *
 * Half a frame at 30 fps plus a bit: the requested time is arbitrary, and the decoder returns
 * the frame shown at that moment, i.e. one up to 33 ms earlier. Without slack the frame is
 * not found at all.
 */
const WINDOW_SLACK_S = 0.02

/**
 * How many candidates ONE flash frame confirms.
 *
 * One means "one flash, one label". Without it this happened: neighbouring audio candidates
 * come 46-70 ms apart, the search window is 267 ms wide, and a single flash fell into the
 * windows of five to eight candidates at once, confirming them all. The user saw a cluster
 * of labels where there was one shot.
 *
 * Measured (Python pipeline, 32 clips, threshold 0.4, window [-6,+2]):
 *
 *   scheme                         labels  recall  precision    F1
 *   each candidate on its own        1113    78.5       52.8  63.2
 *   1 label per flash                 615    63.0       75.3  68.6
 *   2                                 844    72.1       63.0  67.2
 *   3                                 974    75.8       57.8  65.6
 *
 * One gives the best F1 and a third of the labels. Raising it to 2-3 buys recall back at the
 * cost of clusters; this is exactly the knob to turn if recall matters more than cleanliness.
 */
const CANDIDATES_PER_FLASH = 1

/**
 * Minimum gap between final labels — THE GAME'S FIRE-RATE LIMIT.
 *
 * The fastest rate in CS2 is 857 rounds per minute (P90, MP9), i.e. 70 ms. Two labels closer
 * than that cannot be two shots: it is one flash that burned over two neighbouring frames
 * whose hot frames picked different candidates.
 *
 * No margin below is left, deliberately: 70 ms is already the limit, and anything closer is
 * definitely not two shots. Pairs at exactly 70 ms pass, and only the burst rhythm can sort
 * them out: if the weapon in the clip fires every 100 ms, a 70 ms pair will not fit its grid.
 */
const MIN_MARK_GAP_S = FASTEST_PERIOD_S

/**
 * Final labels: the firing interval sets the bounds, the weapon's rhythm sets the shots inside.
 *
 * Selection starts FROM INTERVALS, not from candidates, and that is the main difference from
 * the old scheme. Previously each candidate asked "is there a flash in my window", and one
 * flash said "yes" to five neighbours — hence the label clusters. Now the flash says WHERE
 * the firing was, and how many shots there were is counted by the weapon period.
 *
 * ALL candidates are taken for an interval, not only confirmed ones: a shot whose flash fell
 * between frames would not get confirmed, but the grid needs it.
 */
export function keepConfirmed(
  scored: FlashScoredShot[],
  intervals: FlashInterval[],
  threshold = DEFAULT_FLASH_THRESHOLD,
  window: [number, number] = DEFAULTS.window,
  /**
   * How to place shots inside an interval: `rhythm` — a grid by fire rate, `peaks` —
   * non-maximum suppression on audio with no grid at all. The switch is for measurement:
   * two schemes must be compared with the same code.
   */
  mode: 'rhythm' | 'peaks' = 'rhythm',
): FlashScoredShot[] {
  if (!intervals.length) return scored.filter((s) => s.flashScore >= threshold)

  const byTime = new Map(scored.map((s) => [Math.round(s.time * 1000), s]))
  const candidates = scored.map((s) => ({ time: s.time, strength: s.strength }))
  const out: FlashScoredShot[] = []

  const [back, forward] = window
  const gridded = new Set<number>()
  const confirmed = scored.filter((s) => s.flashScore >= threshold)

  for (const interval of intervals) {
    const lo = interval.start - forward
    const hi = interval.end - back
    const mine = confirmed.filter((c) => c.time >= lo && c.time <= hi)
    for (const c of mine) gridded.add(Math.round(c.time * 1000))

    // Period from the picture was TESTED AND IS NOT USED — see periodFromBrightness.
    // At 30 fps brightness peaks alias in frequency, and the estimate comes out a multiple
    // of the true one: bizon at 400 rounds per minute instead of 750, exactly half as fast.
    const placed =
      mode === 'peaks'
        ? placeByAudioPeaks(interval, candidates, window, MIN_MARK_GAP_S)
        : placeShots(interval, candidates, window)
    if (placed) {
      for (const shot of placed) {
        const source = byTime.get(Math.round(shot.time * 1000))
        out.push({
          ...(source ?? {
            time: shot.time,
            strength: threshold,
            relativeLoudness: 1,
            classScores: [],
            spot: null,
            source: 'flash' as const,
          }),
          time: shot.time,
          flashScore: shot.filled ? threshold : Math.max(shot.score, threshold),
          filled: shot.filled,
          period: shot.period,
        })
      }
      continue
    }

    // NO GRID MEANS ONE SHOT. If there were two, the weapon period would explain the distance
    // between them and a grid would be found. Without this rule a single AWP shot gave two
    // labels 116 ms apart: the flash blinked on leaving the scope, two hot stretches picked two
    // neighbouring candidates, and the fire-rate limit (70 ms) does not catch such a pair.
    //
    // Which one is decided by audio: a real shot has a more pronounced transient. The choice
    // is ONLY among confirmed candidates, not among all in the window: the hot frame already
    // pointed at the one closest to it, and that pointer must not be discarded — otherwise
    // the label drifts to a neighbour.
    if (!mine.length) continue
    out.push(mine.reduce((a, b) => (b.strength > a.strength ? b : a)))
  }

  // One interval knows nothing of the next, and at the seam two grids can put labels right
  // next to each other. Shots are never closer than the fire-rate limit — keep one.
  out.sort((a, b) => b.strength - a.strength)
  const kept: FlashScoredShot[] = []
  for (const shot of out) {
    if (kept.some((k) => Math.abs(k.time - shot.time) < MIN_MARK_GAP_S)) continue
    kept.push(shot)
  }
  return kept.sort((a, b) => a.time - b.time)
}

export interface FlashResult {
  shots: FlashScoredShot[]
  /** Box brightness excess over the frame, per frame. The weapon period is read from it. */
  profile: { time: number; excess: number }[]
  /**
   * Stretches where the model sees a flash. Computed over FRAMES, not candidates, so this
   * pass is the one that exports them: they can no longer be rebuilt from labels.
   */
  intervals: FlashInterval[]
}

export async function scoreShotsByFlash(
  file: File | Blob,
  shots: DetectedShot[],
  options: FlashOptions = {},
): Promise<FlashResult> {
  if (!shots.length) return { shots: [], intervals: [], profile: [] }
  const opts = { ...DEFAULTS, ...options }

  const worker = new Worker(new URL('./flashWorker.ts', import.meta.url), { type: 'module' })
  const send = (m: Incoming, transfer: Transferable[] = []) => worker.postMessage(m, transfer)

  try {
    const classes = await new Promise<Record<string, string>>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<Outgoing>) => {
        if (e.data.type === 'ready') resolve(e.data.classes)
        else if (e.data.type === 'error') reject(new Error(e.data.message))
      }
      worker.onerror = (e) => reject(new Error(e.message))
      send({
        type: 'init',
        modelUrl: opts.modelUrl,
        imgsz: opts.imgsz,
        minScore: DEFAULT_FLASH_THRESHOLD,
        boxes: false,
      })
    })

    // Class indices of an own shot. If no name was recognised, take the max over all:
    // a model with a single "flash" class must work too.
    const order = Object.keys(classes).sort((a, b) => Number(a) - Number(b))
    const ownIndices = order
      .map((k, i) => (OWN_SHOT_CLASSES.has(classes[k]) ? i : -1))
      .filter((i) => i >= 0)

    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('в файле нет видеодорожки')

    const sink = new CanvasSink(track, { width: opts.analysisWidth, poolSize: 1 })
    const origin = await track.getFirstTimestamp()

    // Frame request timestamps are on the TRACK clock, i.e. shifted by its start.
    // Without that the moment drifts by exactly one frame: the first frame is not at zero
    // but at 33 ms. The project has paid for this offset before — it also spoiled the flash
    // detector measurement. A 1/60 s step covers both 30 and 60 fps: in a 30 fps clip
    // neighbouring requests hit the same frame, and the duplicate is dropped by frame time
    // before inference.
    const step = 1 / 60
    const wanted = new Set<number>()
    for (const shot of shots) {
      for (let o = opts.window[0]; o <= opts.window[1] + 1e-9; o += step) {
        wanted.add(Math.round((origin + shot.time + o) * 1000) / 1000)
      }
    }
    const timestamps = [...wanted].sort((a, b) => a - b)

    // Frames are collected as a LIST (time, score), not a map keyed by rounded time.
    //
    // A map was a mistake here, and a costly one: the requested time is arbitrary, and the
    // frame that arrives is the one shown at that moment — it can sit 33 ms before the
    // request. A key lookup with a half-frame tolerance missed, and the candidate scored 0 not
    // because the model saw nothing but because its frame was not found. The sign was in plain
    // sight: EXACTLY 0.000 for 62% of candidates, which a sigmoid never produces.
    const frames: {
      time: number
      score: number
      all: number[]
      spots: { cx: number; cy: number; w: number; h: number }[]
      excess: number
    }[] = []
    let pending: Promise<void> = Promise.resolve()
    let done = 0

    const awaitResult = () =>
      new Promise<void>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<Outgoing>) => {
          if (e.data.type === 'result') {
            const all = e.data.scores
            const score = ownIndices.length ? Math.max(...ownIndices.map((i) => all[i])) : Math.max(...all)
            frames.push({ time: e.data.time, score, all, spots: e.data.spots, excess: e.data.excess })
            opts.onProgress?.(++done, timestamps.length)
            resolve()
          } else if (e.data.type === 'error') reject(new Error(e.data.message))
        }
      })

    const seen = new Set<number>()
    for await (const frame of sink.canvasesAtTimestamps(timestamps)) {
      if (!frame) continue
      // The same frame arrives for several requested moments — processing it again
      // means paying for inference twice.
      const key = Math.round(frame.timestamp * 1000)
      if (seen.has(key)) continue
      seen.add(key)
      const bitmap = await createImageBitmap(frame.canvas as CanvasImageSource)
      const time = frame.timestamp - origin
      await pending
      const result = awaitResult()
      send({ type: 'frame', bitmap, time }, [bitmap])
      pending = result
    }
    await pending

    // A candidate gets the BEST frame of its window. Max, not mean: the flash is visible
    // on one frame of three, and averaging would drown it in the two empty ones.
    frames.sort((a, b) => a.time - b.time)
    const [back, forward] = opts.window
    const classCount = frames.length ? frames[0].all.length : 0
    const inWindow = (shotTime: number, frameTime: number) =>
      frameTime >= shotTime + back - WINDOW_SLACK_S && frameTime <= shotTime + forward + WINDOW_SLACK_S

    // ASSIGNMENT FROM FRAME TO CANDIDATE, not the other way round.
    //
    // Previously each candidate took the max over its own window, and one flash confirmed
    // everyone whose windows covered it. Now it is reversed: a flash frame picks its NEAREST
    // candidate, and the number confirmed per flash is bounded.
    const best = new Map<number, { score: number; all: number[]; spot: FlashScoredShot['spot'] }>()
    for (const frame of frames) {
      if (frame.score < DEFAULT_FLASH_THRESHOLD) continue
      const near = shots
        .map((shot, index) => ({ index, distance: Math.abs(frame.time - shot.time) }))
        .filter(({ index }) => inWindow(shots[index].time, frame.time))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, CANDIDATES_PER_FLASH)
      for (const { index } of near) {
        const prev = best.get(index)
        if (prev && frame.score <= prev.score) continue
        // The box comes from the class that gave the confidence: a flash box must not be
        // mixed with a tracer box, they differ in size and position.
        const winner = frame.all.indexOf(frame.score)
        best.set(index, {
          score: frame.score,
          all: frame.all,
          spot: frame.spots?.[winner] ?? null,
        })
      }
    }

    const intervals = findIntervals(frames, DEFAULT_FLASH_THRESHOLD)
    // The brightness excess series is exported whole: the burst period is read from it,
    // and it can no longer be rebuilt from labels.
    const profile = frames.map((f) => ({ time: f.time, excess: f.excess }))
    const scoredShots = shots.map((shot, index) => {
      const hit = best.get(index)
      return {
        ...shot,
        flashScore: hit?.score ?? 0,
        classScores: hit?.all ?? Array.from({ length: classCount }, () => 0),
        spot: hit?.spot ?? null,
        source: 'flash' as const,
      }
    })
    return { shots: scoredShots, intervals, profile }
  } finally {
    worker.postMessage({ type: 'close' } satisfies Incoming)
    worker.terminate()
  }
}
