/**
 * Shots from VIDEO ONLY: the model looks at every frame, audio takes no part at all.
 *
 * Unlike `scoreShotsByFlash`, where audio supplies candidates and the model confirms them,
 * there are no candidates here. The whole clip is scanned end to end, and shot moments are
 * taken from the confidence curve itself.
 *
 * WHAT THIS CHANGES, and it is worth knowing up front:
 *
 * TIMING PRECISION drops to one frame. The audio grid is 11.6 ms, a video frame is 33 ms,
 * three times coarser. In exchange the moment lands on the flash itself rather than on the
 * audio transient, which in these clips lags the picture by 100-200 ms, differently for
 * every clip.
 *
 * THE RECALL CEILING is different. The old scheme was bounded by audio: what it did not hear
 * did not exist. Here it is bounded by frames: a flash lives 10-20 ms against a 33 ms frame,
 * and some shots do not land in any frame.
 *
 * COST is three times higher: every frame is analysed, not five frames per candidate.
 */
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny'
import { shotsFromAmmo } from '../ammo/detectWithAmmo'
import { loadPrototypes } from '../ammo/reader'
import { AmmoScan } from '../ammo/scan'
import type { DetectedShot } from '../shotDetection'
import { FASTEST_PERIOD_S } from './fireRates'
import { alignToAudio } from './audioAlign'
import type { Incoming, Outgoing } from './flashWorker'
import { findOwnFlashes, isOwnFlash, type OwnFlashOptions, type Spot } from './ownWeapon'
import { DEFAULT_FLASH_THRESHOLD } from './thresholds'

export interface FlashOnlyOptions {
  /**
   * Audio candidate moments. When given, frames are taken ONLY around the candidates,
   * not across the whole clip.
   *
   * This is the old way of sampling frames: three times cheaper, but it sees the clip with
   * holes. Kept for a fair comparison — the selection logic is the same, only the set of
   * frames that reaches it changes.
   */
  candidates?: number[]
  /** Window around a candidate, [back, forward] in seconds. Audio lags the picture. */
  window?: [number, number]
  /** Where to report the found reference of the own flash. Needed by checks, not by the product. */
  onReference?: (own: ReturnType<typeof findOwnFlashes>) => void
  /** Settings for finding own-flash anchors. Needed for parameter sweeps, not by the product. */
  ownFlash?: OwnFlashOptions
  modelUrl?: string
  /**
   * How many consecutive hot frames a label needs. Applied ONLY at high frame rate
   * (see HIGH_FPS): at 30 fps a frame lasts 33 ms, a flash lives 10–20, and a real shot
   * there often occupies exactly one frame — the rule would kill it.
   *
   * Measured on all 50 clips: precision 77.5 -> 78.4, recall 60.0 -> 59.8, F1 +0.2.
   * EXACTLY six clips changed, all of them 60 fps — the rule did not touch a single
   * 30 fps clip.
   *
   * THESE LABELS DO NOT DIFFER BY CONFIDENCE. The first hypothesis was that the extra ones
   * are weak (0.51–0.59 on ssg08 and donk-4k-awp) and a score threshold would do. It fell
   * apart on p2000: six single frames with peaks 0.80–0.85 were dropped there, four false
   * and two real shots — the same numbers. Only the run length separates them, so the
   * rule counts frames, not score.
   *
   * The cost is known and accepted: two real labels over the whole corpus (both on p2000,
   * where only 7 shots of 23 were found anyway) against twice as many extra ones.
   */
  minHotFrames?: number
  /** Model input: a number means a square, a pair means [width, height]. */
  imgsz?: number | [number, number]
  threshold?: number
  analysisWidth?: number
  onProgress?: (frames: number) => void
  /**
   * Audio candidates. Needed ONLY by the ammo counter and only for slot selection:
   * on a real counter the decrements line up with audio, on a timer or scoreboard they
   * do not. Without them the check is disabled, and a row that matched by chance passes
   * as the counter.
   *
   * They have no effect whatsoever on flash-based shot moments.
   */
  audioShots?: DetectedShot[]
  /**
   * Abort the scan. Checked on EVERY frame: a pass over a one-minute clip is thousands
   * of frames, and without abort, cancelling only stops listening to the answer while the
   * computation continues — on a phone that shows in both battery and heat.
   */
  signal?: AbortSignal
  /** Where to report which stage produced the answer. */
  onSource?: (source: 'ammo' | 'flash') => void
  /**
   * Which backend runs the model. On wasm it is seventeen times slower, and this is the
   * only way to tell from outside that the GPU was not picked up.
   */
  onBackend?: (backend: 'webgpu' | 'wasm') => void
  /**
   * TEMPORARY. Force a backend instead of the usual "webgpu, otherwise wasm".
   * Needed to compare the two speeds on the SAME device — phones have no browser flags,
   * and the gap between the paths was measured at seventeen times.
   */
  backend?: 'webgpu' | 'wasm'
  /**
   * Full per-frame breakdown: winning class name, scores of ALL classes, and the box.
   *
   * Needed only for error analysis. The question it was added for: the user sees a label
   * where there is no flash on screen and asks what the model latched onto. The collapsed
   * score does not answer that — you need the class and the box position.
   */
  onFrame?: (frame: {
    time: number
    winner: string
    score: number
    spot: Spot | null
    scores: Record<string, number>
    /** Total time to process the frame. Separates its cost from decoding. */
    ms: number
    /** Of which — frame preparation and the model run itself: they are fixed differently. */
    prepMs: number
    runMs: number
    /** DIAGNOSTICS: what preparation consists of. */
    drawMs: number
    readMs: number
    fillMs: number
  }) => void
  /** Full ammo counter result, when it took part. Needed for error analysis. */
  onAmmo?: (result: ReturnType<typeof shotsFromAmmo>) => void
}

/**
 * The model is trained on a 416x416 square (`model/v3/best.pt`, 70 epochs, same dataset).
 *
 * Measured on all 50 clips against the two previous variants:
 *
 * | input               | ×real time         | net, ms/frame | recall  | F1   |
 * |---------------------|--------------------|---------------|---------|------|
 * | square 640          | 0.699              | 13.50         | 59.5    | 67.5 |
 * | rectangle 384x640   | 0.615              | 11.01         | 59.5    | 67.5 |
 * | square 416          | **0.577**          | **9.69**      | 60.0    | 67.7 |
 *
 * A quality gain is NOT claimed: the best row for 416 sits at a 50 ms offset, the older ones
 * at 33. At an equal 33 ms offset it is 59.8 and 67.5 — level. The claim is exactly one:
 * 17% faster at the same quality.
 *
 * Labels diverged on 29 clips of 50 — the model was retrained and behaves differently
 * almost everywhere. Matching totals mean losses and gains balanced out, not that the
 * behaviour was preserved. The biggest drop is where the flash is small: the suppressed
 * `m4a1s` gives 8 labels against 10.
 *
 * The old weights (square 640 and rectangle 384x640) were removed from `public/models`:
 * 24 MB that were never loaded.
 *
 * A RECTANGULAR EXPORT OF THESE SAME WEIGHTS WAS TESTED AND REJECTED. A 256x416 input
 * removes the same 44% of padding and gives 2184 anchors against 3549, but on ten clips
 * that is only −5% on the net and −0.6% on total time. With the old weights the same
 * trick gave −18% on the net: the smaller the model, the larger the share of fixed per-call
 * overhead, which does not shrink with the work. Half a percent is not worth a second
 * 12 MB model file and a second code branch.
 */
const DEFAULTS = {
  minHotFrames: 2,
  modelUrl: '/models/flashNet416.onnx',
  imgsz: 416 as number | [number, number],
  threshold: DEFAULT_FLASH_THRESHOLD,
  analysisWidth: 640,
  window: [-0.2, 0.067] as [number, number],
}

/**
 * Confidence from which a flash qualifies as a witness against the counter.
 * A borderline hit proves nothing, and the cost of a mistake is a correct counter thrown away.
 */
const WITNESS_SCORE = 0.8

/** Frame rate above which a flash spans several frames and the rule applies. */
const HIGH_FPS = 45

/**
 * How many confident flashes are needed for the cross-check to happen at all.
 *
 * With one or two, the "no decrement" share takes values of 0% or 100% and decides the
 * counter's fate by coin toss. Three is the smallest count at which the share means
 * anything; on the corpus that is enough to judge `awp-flicks` (it has exactly three).
 */
const MIN_WITNESSES = 3

/**
 * Share of confident flashes without a counter decrement above which the counter is
 * declared a foreign row.
 *
 * The split on the corpus has a margin and was checked by eye on both sides: `scar20` (42%)
 * and `my-skills` (43%) work perfectly, `ssg08` (75%), `mag7` and `awp-flicks` (100%)
 * were flagged by the user as wrong before this check even existed.
 */
const MAX_ORPHAN_SHARE = 0.5

/**
 * Tolerance for finding a decrement. SYMMETRIC, and a one-sided window here was TESTED
 * AND REJECTED.
 *
 * It seemed the counter must lag the flash: the event is the frame where the new value is
 * first read, and it appears after the shot. The measurement said otherwise — on
 * `my-skills` counter events come BEFORE the flashes, and a one-sided window gave 7 misses
 * out of 7 on a clip that was checked by eye and judged flawless.
 *
 * The reason is that `shotsFromAmmo` shifts its times by aligning to audio, and that shift
 * goes either way. A counter event has no lag of known sign at all.
 *
 * Below ±100 ms the check falls apart: at ±50 ms `xm1014` jumps from zero misses to eight
 * of eight. That is the spread of the same alignment, and the tolerance must contain it.
 */
const WITNESS_TOLERANCE_S = 0.1

/** Classes that mean an own shot. Plain `tracer` does not count: it is visible from others' fire too. */
const OWN_SHOT_CLASSES = new Set(['muzzle_flash', 'zoom_flash', 'zoom_tracer'])

/**
 * Peaks of the confidence curve — one per shot.
 *
 * The gap between peaks is the game's fire-rate limit: 857 rounds per minute for the P90
 * and MP9, i.e. 70 ms. Two shots are never closer, so neighbouring hot frames are the
 * same flash.
 *
 * The pass goes in DESCENDING confidence, not in time: if a flash burns over three frames,
 * the label must be the brightest of them, not the first one encountered.
 */
function pickPeaks(
  frames: { time: number; score: number }[],
  threshold: number,
  minGap: number,
): DetectedShot[] {
  const hot = frames.filter((f) => f.score >= threshold).sort((a, b) => b.score - a.score)
  const kept: { time: number; score: number }[] = []
  for (const frame of hot) {
    if (kept.some((k) => Math.abs(k.time - frame.time) < minGap)) continue
    kept.push(frame)
  }
  return kept
    .sort((a, b) => a.time - b.time)
    .map((f) => ({ time: f.time, strength: f.score, relativeLoudness: 1 }))
}

export async function detectByFlash(
  file: File | Blob,
  options: FlashOnlyOptions = {},
): Promise<DetectedShot[]> {
  const opts = { ...DEFAULTS, ...options }
  const worker = new Worker(new URL('./flashWorker.ts', import.meta.url), { type: 'module' })
  const send = (m: Incoming, transfer: Transferable[] = []) => worker.postMessage(m, transfer)

  try {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('в файле нет видеодорожки')

    const classes = await new Promise<Record<string, string>>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<Outgoing>) => {
        if (e.data.type === 'ready') {
          opts.onBackend?.(e.data.backend)
          resolve(e.data.classes)
        }
        else if (e.data.type === 'error') reject(new Error(e.data.message))
      }
      worker.onerror = (e) => reject(new Error(e.message))
      send({
        type: 'init',
        modelUrl: opts.modelUrl,
        imgsz: opts.imgsz,
        minScore: opts.threshold,
        boxes: false,
        backend: options.backend,
      })
    })

    const order = Object.keys(classes).sort((a, b) => Number(a) - Number(b))
    const ownIndices = order
      .map((k, i) => (OWN_SHOT_CLASSES.has(classes[k]) ? i : -1))
      .filter((i) => i >= 0)

    // The ammo counter rides THE SAME frame pass as the flash: a second pass would cost
    // another decode, and decoding is exactly the bottleneck (measured: selective frame
    // extraction is only three percent cheaper than full).
    const ammoScan = await loadPrototypes()
      .then((p) => new AmmoScan(p))
      .catch(() => null)

    const sink = new CanvasSink(track, { width: opts.analysisWidth, poolSize: 1 })
    const origin = await track.getFirstTimestamp()

    const names = order.map((k) => classes[k])
    const frames: { time: number; score: number; spot: Spot | null }[] = []
    let pending: Promise<void> = Promise.resolve()
    let done = 0

    const awaitResult = () =>
      new Promise<void>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<Outgoing>) => {
          if (e.data.type === 'result') {
            const all = e.data.scores
            const pool = ownIndices.length ? ownIndices : all.map((_, i) => i)
            const winner = pool.reduce((a, b) => (all[b] > all[a] ? b : a))
            const spot = e.data.spots?.[winner] ?? null
            opts.onFrame?.({
              time: e.data.time,
              winner: names[winner] ?? String(winner),
              score: all[winner],
              spot,
              scores: Object.fromEntries(all.map((v, i) => [names[i] ?? String(i), v])),
              ms: e.data.ms,
              prepMs: e.data.prepMs,
              runMs: e.data.runMs,
              drawMs: e.data.drawMs,
              readMs: e.data.readMs,
              fillMs: e.data.fillMs,
            })
            frames.push({
              time: e.data.time,
              score: all[winner],
              // The box comes from the class that gave the confidence: a flash box must
              // not be mixed with a tracer box, they differ in size and position.
              spot,
            })
            opts.onProgress?.(++done)
            resolve()
          } else if (e.data.type === 'error') reject(new Error(e.data.message))
        }
      })

    // Frames stream in, the worker processes one at a time: an unbounded queue on a long
    // clip would eat memory with bitmaps faster than the worker can close them.
    //
    // The frame source depends on whether candidates are given: the whole clip or only
    // their neighbourhoods. A 1/60 s step covers both 30 and 60 fps; duplicates are
    // dropped by frame time.
    const stream = opts.candidates?.length
      ? sink.canvasesAtTimestamps(
          [
            ...new Set(
              opts.candidates.flatMap((t) => {
                const out: number[] = []
                for (let o = opts.window[0]; o <= opts.window[1] + 1e-9; o += 1 / 60) {
                  out.push(Math.round((origin + t + o) * 1000) / 1000)
                }
                return out
              }),
            ),
          ].sort((a, b) => a - b),
        )
      : sink.canvases()

    // OUR OWN canvas for the counter, not the mediabunny one. The `willReadFrequently`
    // hint applies ONLY when the context is first created: if a context already exists,
    // the spec says to return it and ignore the settings. Checked in the browser — a repeat
    // call returns the same object with the flag `false`, and mediabunny has already created
    // the context to draw the frame into it.
    //
    // Without an effective hint the browser keeps the canvas in GPU memory, and every
    // `getImageData` pulls a whole frame back with a stall. Hence the console warning seen
    // on BOTH backends: it has nothing to do with the webgpu/wasm choice.
    let ammoCanvas: OffscreenCanvas | null = null
    let ammoCtx: OffscreenCanvasRenderingContext2D | null = null

    const seen = new Set<number>()
    let index = 0
    const stamps: number[] = []
    for await (const frame of stream) {
      if (!frame) continue
      if (options.signal?.aborted) throw new DOMException('разбор отменён', 'AbortError')
      const key = Math.round(frame.timestamp * 1000)
      if (seen.has(key)) continue
      seen.add(key)
      stamps.push(frame.timestamp)
      const canvas = frame.canvas as HTMLCanvasElement | OffscreenCanvas
      if (ammoScan) {
        // The counter needs pixels as they are: a HUD digit is tens of pixels, and any
        // downscaling eats it. Hence our own canvas of exactly the same size.
        const { width, height } = canvas
        if (!ammoCanvas || ammoCanvas.width !== width || ammoCanvas.height !== height) {
          ammoCanvas = new OffscreenCanvas(width, height)
          ammoCtx = ammoCanvas.getContext('2d', {
            willReadFrequently: true,
          }) as OffscreenCanvasRenderingContext2D | null
        }
        if (ammoCtx) {
          ammoCtx.drawImage(canvas as CanvasImageSource, 0, 0)
          ammoScan.push(ammoCtx.getImageData(0, 0, width, height).data, width, height, index)
        }
      }
      index++
      const bitmap = await createImageBitmap(canvas as CanvasImageSource)
      const time = frame.timestamp - origin
      await pending
      const result = awaitResult()
      send({ type: 'frame', bitmap, time }, [bitmap])
      pending = result
    }
    await pending

    // The own-flash reference is derived FROM THE WHOLE CLIP, so it is computed after the pass.
    // The own flash repeats in one place at one size; others' flashes are scattered and small.
    const own = findOwnFlashes(
      frames.filter((f) => f.score >= opts.threshold).map((f) => f.spot).filter((s): s is Spot => !!s),
      options.ownFlash,
    )
    opts.onReference?.(own)
    // Length of the hot run a frame sits in. Runs are counted over ALL frames in time
    // order: the own-flash filter thins them out, and on the thinned series the run
    // length would come out wrong.
    const fpsSeen = medianFps(stamps)
    const runLength = new Map<number, number>()
    if (opts.minHotFrames > 1 && fpsSeen > HIGH_FPS) {
      let start = -1
      for (let i = 0; i <= frames.length; i++) {
        const hot = i < frames.length && frames[i].score >= opts.threshold
        if (hot && start < 0) start = i
        else if (!hot && start >= 0) {
          for (let k = start; k < i; k++) runLength.set(frames[k].time, i - start)
          start = -1
        }
      }
    }
    /**
     * Return labels to the AUDIO clock.
     *
     * Inside the stage frame time is counted from the first frame (`frame.timestamp - origin`),
     * and all arithmetic — peaks, bursts, counter slots — lives on that clock. But the labels
     * and the audio stage count from the track's zero, and the first video frame is not at
     * zero: usually at +33 ms, i.e. exactly one frame (see `python/out/videoStart.json`).
     *
     * Without this shift all labels land one frame early. Measured: the label-to-truth offset
     * was -21 ms on `ak47` and -35 ms on `m4a4`, and the correction brings both near zero.
     * With a 50 ms metric tolerance, one frame eats a noticeable part of the margin.
     */
    const toAudioClock = (list: DetectedShot[]): DetectedShot[] =>
      origin ? list.map((s) => ({ ...s, time: s.time + origin })) : list

    /**
     * THE SINGLE EXIT of the stage. There used to be four returns, and the completion step
     * sat on only two of them: clips where the counter was not scanned left with raw labels.
     * Caught on mp9 — 21 labels instead of 55.
     */
    const finish = (list: DetectedShot[]): DetectedShot[] =>
      alignToAudio(toAudioClock(list), opts.audioShots)

    const mine = frames
      .filter((f) => isOwnFlash(f.spot, own, options.ownFlash))
      .filter((f) => runLength.size === 0 || (runLength.get(f.time) ?? 0) >= opts.minHotFrames)
    const byFlash = pickPeaks(mine, opts.threshold, FASTEST_PERIOD_S)

    // THE COUNTER TAKES PRIORITY WHEREVER IT IS FOUND. Measured on 50 clips: counter, else
    // flash — F1 65.9 against 51.9 for flash alone and 51.6 for the counter alone. Every
    // restriction on the counter made it worse: a slot visibility threshold gave 58.4, a read
    // density threshold 62.0. Splitting into segments did not help at all (65.9 vs 65.6): the
    // slot is either read for almost the whole clip or not found, there is hardly any middle.
    if (!ammoScan || !opts.audioShots?.length) {
      opts.onSource?.('flash')
      return finish(byFlash)
    }
    // Counter times are counted from ZERO, like the flash: both stages live on the video
    // clock, and the candidates for the check are shifted onto it too.
    const ammo = shotsFromAmmo(
      ammoScan.result(),
      fpsSeen,
      opts.audioShots.map((s) => s.time - origin),
      0,
    )
    opts.onAmmo?.(ammo)
    if (!ammo.times?.length) {
      opts.onSource?.('flash')
      return finish(byFlash)
    }
    // CROSS-CHECK AGAINST THE FLASH. Both stages are already computed in this same pass, so
    // it costs nothing. ONE direction is checked: a flash means a shot, so the counter must
    // have decreased. The reverse is false at 30 fps — a flash is visible for about 71% of
    // shots, and demanding it for every decrement would break the counter where it is valuable.
    const witnesses = byFlash.filter((s) => s.strength >= WITNESS_SCORE)
    if (witnesses.length >= MIN_WITNESSES) {
      const orphans = witnesses.filter(
        (w) => !ammo.times.some((t) => Math.abs(t - w.time) <= WITNESS_TOLERANCE_S),
      )
      if (orphans.length / witnesses.length > MAX_ORPHAN_SHARE) {
        // The row decreases like a magazine, but not where the shots were: these are foreign
        // numbers. On `awp-flicks` this is how the alive-players count "4 VS 2" at the top
        // edge was identified.
        opts.onSource?.('flash')
        return finish(byFlash)
      }
    }
    opts.onSource?.('ammo')
    // The counter does not rank: it is either read, and then it is the game's direct answer, or not.
    return finish(ammo.times.map((time) => ({ time, strength: 1, relativeLoudness: 1 })))
  } finally {
    worker.postMessage({ type: 'close' } satisfies Incoming)
    worker.terminate()
  }
}

/** Frame rate from timestamps: the container does not always report it honestly. */
function medianFps(stamps: number[]): number {
  const gaps: number[] = []
  for (let i = 1; i < stamps.length; i++) {
    const d = stamps[i] - stamps[i - 1]
    if (d > 1e-4) gaps.push(d)
  }
  if (!gaps.length) return 30
  gaps.sort((a, b) => a - b)
  return 1 / gaps[Math.floor(gaps.length / 2)]
}
