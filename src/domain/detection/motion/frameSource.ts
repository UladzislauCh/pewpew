import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny'
import { sampleGrayFrame, type CropRect, type GrayFrames } from './motionFeatures'

/**
 * Grayscale frames for the motion model, decoded with mediabunny.
 *
 * Two things here are not free choices — they are what the trained weights assume.
 *
 * PIXEL SAMPLING. The model was trained on frames produced by an AVFoundation tool that used
 * nearest-neighbour sampling and integer Rec.601 luma. Canvas scaling is smooth, so letting
 * `CanvasSink` resize to the target size would hand the model different pixels than it learned on.
 * The sink therefore decodes at (roughly) native size and `sampleGrayFrame` does the reduction,
 * reproducing the training path exactly.
 *
 * WHOLE-CLIP DECODE. Unlike the flash/recoil check, which samples a handful of frames around each
 * candidate, motion is a frame-to-frame quantity: every frame's shift is measured against its
 * predecessor, so the whole clip has to pass through. That is the expensive part of this feature.
 */

/** The model's own geometry — see MOTION_PARAMS. Changing these invalidates the weights. */
export const FULL_FRAME_SIZE = 384
export const WEAPON_WIDTH = 320
export const WEAPON_HEIGHT = 140

export interface DecodeOptions {
  /**
   * Decode width. Kept near the source resolution rather than at the target size: the reduction
   * has to be nearest-neighbour, and a smooth pre-scale by the sink would defeat that.
   */
  decodeWidth?: number
  signal?: AbortSignal
  /**
   * Called on every decoded frame BEFORE sampling — to take a second sample from the same frame
   * without paying for a second pass over the video.
   *
   * This hook is what lets the per-block weapon region analysis fit into the pass that runs for
   * camera motion anyway: it needs only the current and previous frames, not the whole clip, so
   * it requires no extra memory.
   */
  onFrame?: (rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, index: number) => void
  /**
   * Time of the first video frame in seconds, from the container.
   *
   * Needed by the ammo counter: it lives in VIDEO time, while shot labels are on the audio clock,
   * and in some clips the video track does not start at zero. The error is exactly one frame, i.e.
   * within the metric tolerance, but audio alignment does needless work because of it.
   */
  onVideoStart?: (seconds: number) => void
  /**
   * The real frame rate of the VIDEO TRACK, from the container.
   *
   * Needed by the ammo counter. The motion model measures its windows as "frames divided by
   * duration" — that is how it was computed in training, and it must not change. But the counter
   * needs the frame TIME, and there the same formula lies: for the set's clips the duration is
   * taken from the audio track and does not match the video track, which accumulates up to half a
   * frame by the end of the clip. For the counter that is the difference between hitting a shot and
   * missing it.
   */
  onVideoFps?: (fps: number) => void
}

/**
 * Decodes the clip once and reduces every frame to the requested crop and size.
 *
 * `duration` comes from the caller because fps is derived as frames/duration — that is how it was
 * derived during training, and the model's windows are measured in frames.
 */
export async function decodeGrayFrames(
  file: File | Blob,
  crop: CropRect,
  outW: number,
  outH: number,
  duration: number,
  options: DecodeOptions = {},
): Promise<GrayFrames> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  try {
    const videoTrack = await input.getPrimaryVideoTrack()
    if (!videoTrack || !(await videoTrack.canDecode())) {
      throw new Error('Видеодорожка не читается')
    }

    if (options.onVideoStart) {
      const audioTrack = await input.getPrimaryAudioTrack()
      const videoStart = await videoTrack.getFirstTimestamp()
      const audioStart = audioTrack ? await audioTrack.getFirstTimestamp() : 0
      options.onVideoStart(videoStart - audioStart)
    }
    if (options.onVideoFps) {
      const stats = await videoTrack.computePacketStats()
      if (stats.averagePacketRate > 0) options.onVideoFps(stats.averagePacketRate)
    }

    const sink = new CanvasSink(videoTrack, {
      ...(options.decodeWidth ? { width: options.decodeWidth } : {}),
      poolSize: 1,
    })

    const chunks: Uint8Array[] = []
    const frameSize = outW * outH
    let scratch: Uint8Array | null = null
    let index = 0

    for await (const result of sink.canvases()) {
      if (options.signal?.aborted) throw new Error('Отменено')
      if (!result) continue
      const canvas = result.canvas as HTMLCanvasElement | OffscreenCanvas
      // willReadFrequently: every frame is read via getImageData, and without this flag the browser
      // keeps the canvas on the GPU and every read costs a transfer back.
      // The flag is honoured only when the context is FIRST obtained for the canvas; if mediabunny
      // already created it without the flag, nothing gets worse.
      const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | null
      if (!ctx) continue

      const { width, height } = canvas
      const rgba = ctx.getImageData(0, 0, width, height).data
      options.onFrame?.(rgba, width, height, index)
      scratch = new Uint8Array(frameSize)
      sampleGrayFrame(rgba, width, height, crop, outW, outH, scratch)
      chunks.push(scratch)
      index++
    }

    if (!chunks.length) throw new Error('Не удалось декодировать ни одного кадра')

    const data = new Uint8Array(chunks.length * frameSize)
    chunks.forEach((chunk, i) => data.set(chunk, i * frameSize))

    return {
      data,
      width: outW,
      height: outH,
      frames: chunks.length,
      // Actual fps, not nominal: the model's windows are measured in frames,
      // and it was computed exactly this way in training.
      fps: chunks.length / duration,
    }
  } finally {
    input.dispose()
  }
}
