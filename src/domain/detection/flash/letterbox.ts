/**
 * Preparing a frame for YOLO input: fit it into a square preserving aspect ratio, and lay it out
 * as NCHW float32.
 *
 * WHY FIT RATHER THAN STRETCH. Ultralytics trains on letterbox — aspect ratio is preserved,
 * padding is filled with grey 114. A stretched frame gives the model a geometry it has never
 * seen: the flash becomes oval, and confidence drops the more the frame differs from a square.
 * This project's corpus is vertical shorts 720x1280, i.e. an aspect ratio of 0.56 against 1.0
 * for the input. Stretching is not a detail here.
 */

/** Coefficients for mapping back: from model input coordinates to frame coordinates. */
export interface Letterbox {
  /** By how many times the frame is scaled down. */
  scale: number
  /** Left and top padding, in model input pixels. */
  padX: number
  padY: number
  /**
   * Model input size. NOT necessarily a square: a rectangular input removes the grey padding,
   * which takes 44% of the square for a vertical short, and the network stops running
   * convolutions over emptiness — 5040 anchors instead of 8400.
   */
  sizeW: number
  sizeH: number
}

/** Grey padding background — the same value ultralytics uses in training. */
const PAD_VALUE = 114 / 255
/** Padding brightness in pixel units: max(R,G,B) of grey 114. */
const PAD_BRIGHTNESS = 114

/**
 * Region of the previous frame. While it does not change, the tensor padding need not be
 * touched: PAD_VALUE is already there. As soon as the frame has a different size, the old
 * picture would remain in the cells that have now become padding.
 */
let lastRegion = ''

export function letterboxOf(
  width: number,
  height: number,
  sizeW: number,
  sizeH: number = sizeW,
): Letterbox {
  const scale = Math.min(sizeW / width, sizeH / height)
  return {
    scale,
    padX: (sizeW - width * scale) / 2,
    padY: (sizeH - height * scale) / 2,
    sizeW,
    sizeH,
  }
}

/**
 * Frame -> tensor [1, 3, size, size] in RGB order, values 0..1.
 *
 * The canvas is reused by the caller: a long video is thousands of frames, and creating a canvas
 * for each is a sure way to run into the garbage collector.
 */
export interface FrameFill {
  box: Letterbox
  /**
   * Sum of max(R,G,B) brightness over the whole model input.
   *
   * Computed here because the tensor is filled in one pass over the pixels anyway, and a second
   * pass for the same sum would be pure waste. Needed for the "box brightness excess over the
   * rest of the frame" — the series in which separate shots are visible inside a burst, which
   * model confidence does not give: it saturates and is identical over several frames in a row.
   */
  brightness: number
  /**
   * DIAGNOSTICS, development only: drawing to the canvas, reading pixels back from the GPU,
   * laying out into the tensor. In a build all three are zero and `performance.now()` is not
   * called: three calls per frame is thousands of calls per clip for numbers the measurement
   * needs, not the user.
   *
   * Measured on ten clips: read 2.48 ms, layout 1.37, draw 0.03 — i.e. preparation is almost
   * entirely pulling the frame back from the GPU, not working with it.
   */
  drawMs: number
  readMs: number
  fillMs: number
}

export function frameToTensor(
  source: CanvasImageSource,
  width: number,
  height: number,
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  out: Float32Array,
): FrameFill {
  const sizeW = ctx.canvas.width
  const sizeH = ctx.canvas.height
  const box = letterboxOf(width, height, sizeW, sizeH)
  const plane = sizeW * sizeH

  const now = import.meta.env.DEV ? () => performance.now() : () => 0
  const t0 = now()
  ctx.fillStyle = 'rgb(114, 114, 114)'
  ctx.fillRect(0, 0, sizeW, sizeH)
  ctx.drawImage(source, box.padX, box.padY, width * box.scale, height * box.scale)

  // ONLY THE DRAWN REGION IS READ, not the whole square. The corpus is vertical shorts
  // 720x1280: fitted into 640, only 360x640 is useful, i.e. 44% of the square's pixels were grey
  // padding. Those were being pulled from the GPU and iterated in the loop on every frame.
  //
  // The padding in the tensor stays correct on its own: `makeInput` fills the whole array with
  // the padding value, and the old loop wrote exactly the same there — grey 114 from `fillRect`
  // divided by 255. While the frame size does not change, no padding cell needs rewriting.
  // A size change breaks that assumption, so it is tracked and the tensor is refilled.
  const x0 = Math.floor(box.padX)
  const y0 = Math.floor(box.padY)
  const w = Math.min(sizeW - x0, Math.ceil(width * box.scale + (box.padX - x0)))
  const h = Math.min(sizeH - y0, Math.ceil(height * box.scale + (box.padY - y0)))

  const t1 = now()
  const region = `${x0},${y0},${w},${h},${sizeW}x${sizeH}`
  if (region !== lastRegion) {
    out.fill(PAD_VALUE)
    lastRegion = region
  }

  const { data } = ctx.getImageData(x0, y0, w, h)
  const t2 = now()

  let brightness = 0
  for (let r0 = 0; r0 < h; r0++) {
    const row = (y0 + r0) * sizeW + x0
    let p = r0 * w * 4
    for (let c = 0; c < w; c++, p += 4) {
      const i = row + c
      const r = data[p]
      const g = data[p + 1]
      const b = data[p + 2]
      out[i] = r / 255
      out[i + plane] = g / 255
      out[i + 2 * plane] = b / 255
      brightness += Math.max(r, g, b)
    }
  }
  // Padding still contributes to the brightness sum: its contribution is known without reading
  // pixels. Without this term the whole "box brightness excess" series would shift, and there
  // would be nothing to compare it against.
  brightness += PAD_BRIGHTNESS * (plane - w * h)

  return {
    box,
    brightness,
    drawMs: t1 - t0,
    readMs: t2 - t1,
    fillMs: now() - t2,
  }
}

/** An empty tensor of the right size. Created once per session. */
export function makeInput(sizeW: number, sizeH: number = sizeW): Float32Array {
  return new Float32Array(3 * sizeW * sizeH).fill(PAD_VALUE)
}
