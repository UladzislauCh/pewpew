/**
 * Inference worker: holds the onnxruntime session and scores frames without touching the UI.
 *
 * WHY A WORKER AT ALL. Running one frame through YOLOv8n on wasm takes 30-60 ms. A 30-second
 * clip at 30 fps is 900 frames, i.e. up to a minute of solid computation. On the main thread
 * that is a minute of frozen interface.
 *
 * WHAT ARRIVES HERE. An `ImageBitmap` — it is passed BY REFERENCE (transferable), without
 * copying pixels. Passing ImageData would cost twice as much: one copy on send, another on
 * receive.
 *
 * WHAT IS NOT HERE. Video decoding. Frames are obtained by the caller with the same
 * `mediabunny` the project already uses to read video for motion and the ammo counter —
 * a second decoder on the same video would double the cost of a pass.
 */
import * as ort from 'onnxruntime-web/webgpu'
import { decodeBoxes, suppress, type Box } from './decode'
import { frameToTensor, makeInput } from './letterbox'

export interface InitMessage {
  type: 'init'
  modelUrl: string
  /**
   * Model input: a single number means a square, a pair means [width, height].
   *
   * A rectangular input removes the letterbox padding. For a vertical short it takes 44% of
   * a 640x640 square, and the network runs convolutions over it: 8400 anchors against 5040
   * for a 384x640 input. The resolution of the frame itself does NOT change — unlike shrinking
   * the square, which squeezes the flash along with the padding.
   */
  imgsz: number | [number, number]
  /** Confidence threshold. Below it a box does not count as found. */
  minScore: number
  /** Whether box coordinates are needed. For timestamps they are not, only confidence. */
  boxes?: boolean
  /**
   * TEMPORARY, for analysing slow runs on phones. Forces the backend instead of the usual
   * "webgpu, otherwise wasm". Set via the URL: `?backend=wasm`.
   */
  backend?: 'webgpu' | 'wasm'
}

export interface FrameMessage {
  type: 'frame'
  bitmap: ImageBitmap
  /** Frame time in seconds from the start of the clip — this is what goes into the labels. */
  time: number
}

export type Incoming = InitMessage | FrameMessage | { type: 'close' }

export type Outgoing =
  | { type: 'ready'; backend: 'webgpu' | 'wasm'; classes: Record<string, string> }
  | {
      type: 'result'
      time: number
      boxes: Box[]
      /** Per-class confidence maximum over the frame. It is all the labels need. */
      scores: number[]
      /**
       * The best box of EACH class, as fractions of the frame: centre, width, height.
       *
       * Size and position are the only cue that tells an OWN flash from someone else's: the own
       * one is large and bottom-centre, a foreign one small and anywhere. Confidence does not
       * know this, audio even less so.
       */
      spots: { cx: number; cy: number; w: number; h: number }[]
      /**
       * Brightness excess of the box over the rest of the frame.
       *
       * It is what makes SEPARATE shots visible inside a burst. Model confidence is no good for
       * this: it is binary, equally high over several consecutive frames — the detector
       * saturates. Raw brightness is no good either: it clips at 255 on a bright map and drifts
       * with recoil. The excess over the scene gives a clean series whose peaks sit one weapon
       * period apart (measured on ak47: exactly 100 ms at the spec 600 rounds per minute).
       */
      excess: number
      /** DIAGNOSTICS: what frame preparation consists of. */
      drawMs: number
      readMs: number
      fillMs: number
      ms: number
      /** Of which — frame preparation (drawing, reading pixels, normalisation). */
      prepMs: number
      /** Of which — the model run itself. */
      runMs: number
    }
  | { type: 'error'; message: string }

let session: ort.InferenceSession | null = null
let canvas: OffscreenCanvas | null = null
let ctx: OffscreenCanvasRenderingContext2D | null = null
let input: Float32Array | null = null
let inputName = ''
let outputName = ''
let outputShape: readonly number[] = []
let minScore = 0.4
/**
 * Box of the last frame where the model was confident.
 *
 * The brightness excess must be measured in THE SAME place of the frame, otherwise the series
 * breaks. On a cold frame the box comes from a class with a near-zero score — a random place,
 * and its brightness has nothing to do with the flash. Inside a burst the weapon stays put, so
 * the last confident box works for neighbouring cold frames too.
 */
let lastSpot: { cx: number; cy: number; w: number; h: number } | null = null
/** Whether to compute boxes. Labels do not need them, and NMS on every frame is wasted work. */
let wantBoxes = true

const post = (message: Outgoing, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer)

async function init(message: InitMessage): Promise<void> {
  // `wasmPaths` is NOT SET, and that was learned from a failure. The runtime loads its .mjs
  // via dynamic import, and Vite refuses to import from `public/`: "this file is in /public
  // ... should not be imported from source code". Putting the runtime there and pointing a
  // path at it gave "no available backend found" — a message that gives no hint of the cause.
  // Without an override the bundler resolves the references itself, and both files (.mjs and
  // .wasm) land in the distribution as ordinary assets.
  // Multithreaded wasm requires cross-origin isolation, and the site does not have it.
  // Asking for four threads in that setting is pointless: the runtime falls back to one anyway
  // and prints TWO warnings about it to the console — on both backends, because wasm is brought
  // up alongside WebGPU too. We ask for exactly as many as we will get.
  ort.env.wasm.numThreads = crossOriginIsolated
    ? Math.min(4, navigator.hardwareConcurrency || 1)
    : 1

  // Two SEPARATE attempts instead of the list `['webgpu', 'wasm']`, and this is not cosmetic.
  // With a list the runtime falls back by itself and silently, and which backend won cannot be
  // learned from outside. The difference was measured on the ak47 clip: 12.2 ms per frame
  // against 210.8, i.e. SEVENTEEN TIMES, 12.6 seconds against 141. That cannot go unreported.
  let backend: 'webgpu' | 'wasm' = message.backend ?? 'webgpu'
  const create = (provider: 'webgpu' | 'wasm') =>
    ort.InferenceSession.create(message.modelUrl, {
      executionProviders: [provider],
      graphOptimizationLevel: 'all',
    })

  if (message.backend) {
    // The choice is forced via the URL — deliberately NO fallback: the point of forcing is to
    // get exactly this path, and a silent fallback would turn the measurement into a lie.
    session = await create(message.backend)
  } else {
    try {
      session = await create('webgpu')
    } catch {
      backend = 'wasm'
      session = await create('wasm')
    }
  }

  inputName = session.inputNames[0]
  outputName = session.outputNames[0]
  const meta = session.outputMetadata[0]
  outputShape = 'dims' in meta ? (meta.dims as number[]) : [1, 0, 0]
  minScore = message.minScore
  wantBoxes = message.boxes ?? true

  const [inW, inH] = typeof message.imgsz === 'number'
    ? [message.imgsz, message.imgsz]
    : message.imgsz
  canvas = new OffscreenCanvas(inW, inH)
  // willReadFrequently: pixels are read back from EVERY frame, and without the hint the browser
  // keeps the canvas on the GPU, where reading is four times more expensive.
  ctx = canvas.getContext('2d', { willReadFrequently: true })
  input = makeInput(inW, inH)

  const classes = await fetch(message.modelUrl.replace(/\.onnx$/, '.meta.json'))
    .then((r) => (r.ok ? r.json() : { names: {} }))
    .then((m: { names?: Record<string, string> }) => m.names ?? {})
    .catch(() => ({}))

  post({ type: 'ready', backend, classes })
}

async function run(message: FrameMessage): Promise<void> {
  if (!session || !ctx || !input) throw new Error('сессия не создана')
  const started = performance.now()
  const width = message.bitmap.width
  const height = message.bitmap.height
  const { box, brightness, drawMs, readMs, fillMs } = frameToTensor(message.bitmap, width, height, ctx, input)
  const preparedAt = performance.now()
  // The bitmap is no longer needed: without an explicit close it lives until garbage
  // collection, and that is megabytes per frame.
  message.bitmap.close()

  const sizeW = ctx.canvas.width
  const sizeH = ctx.canvas.height
  // ONNX expects NCHW: height before width. Swapping them is invisible on a square,
  // on a rectangle it is instant garbage at the output.
  const tensor = new ort.Tensor('float32', input, [1, 3, sizeH, sizeW])
  const ranAt = performance.now()
  const output = await session.run({ [inputName]: tensor })
  const runMs = performance.now() - ranAt
  const data = output[outputName].data as Float32Array
  const shape = outputShape[1] > 0 ? outputShape : output[outputName].dims

  // Per-class maximum over the frame and the anchor where it is reached. The latter is for the
  // box: one pass is enough for both answers, a separate search would be wasted work.
  const anchors = shape[2]
  const scores: number[] = []
  const spots: { cx: number; cy: number; w: number; h: number }[] = []
  for (let c = 4; c < shape[1]; c++) {
    let best = 0
    let bestAnchor = -1
    for (let a = 0; a < anchors; a++) {
      const v = data[c * anchors + a]
      if (v > best) {
        best = v
        bestAnchor = a
      }
    }
    scores.push(best)
    if (bestAnchor < 0) {
      spots.push({ cx: 0, cy: 0, w: 0, h: 0 })
      continue
    }
    // From model input coordinates to frame fractions: clips of different sizes must be comparable.
    spots.push({
      cx: (data[bestAnchor] - box.padX) / box.scale / width,
      cy: (data[anchors + bestAnchor] - box.padY) / box.scale / height,
      w: data[2 * anchors + bestAnchor] / box.scale / width,
      h: data[3 * anchors + bestAnchor] / box.scale / height,
    })
  }

  // The brightness excess is computed in model INPUT coordinates: the box is there too, and the
  // grey letterbox padding is constant for a clip and shifts all frames equally — it does not
  // affect peak finding.
  const plane = sizeW * sizeH
  let excess = 0
  const bestClass = scores.indexOf(Math.max(...scores))
  if (scores[bestClass] >= minScore && spots[bestClass]?.w > 0) lastSpot = spots[bestClass]
  const spot = lastSpot
  if (spot && spot.w > 0) {
    const cx = (spot.cx * width) * box.scale + box.padX
    const cy = (spot.cy * height) * box.scale + box.padY
    const bw = spot.w * width * box.scale
    const bh = spot.h * height * box.scale
    const x0 = Math.max(0, Math.round(cx - bw / 2))
    const x1 = Math.min(sizeW, Math.round(cx + bw / 2))
    const y0 = Math.max(0, Math.round(cy - bh / 2))
    const y1 = Math.min(sizeH, Math.round(cy + bh / 2))
    let sum = 0
    let n = 0
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * sizeW + x
        sum += 255 * Math.max(input[i], input[i + plane], input[i + 2 * plane])
        n++
      }
    }
    if (n > 0 && plane > n) {
      excess = sum / n - (brightness - sum) / (plane - n)
    }
  }

  const boxes = wantBoxes ? suppress(decodeBoxes(data, shape, box, minScore)) : []
  post({
    type: 'result',
    time: message.time,
    boxes,
    scores,
    spots,
    excess,
    drawMs,
    readMs,
    fillMs,
    ms: performance.now() - started,
    prepMs: preparedAt - started,
    runMs,
  })
}

self.onmessage = async (event: MessageEvent<Incoming>) => {
  try {
    const message = event.data
    if (message.type === 'init') await init(message)
    else if (message.type === 'frame') await run(message)
    else if (message.type === 'close') {
      await session?.release()
      session = null
    }
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
