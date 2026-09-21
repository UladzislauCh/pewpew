import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny'
import type { DetectedShot } from './shotDetection'
import {
  canvasRoiMeanLuminance,
  combineOwnershipScores,
  scoreMuzzleFlash,
  scoreRecoil,
  type CanvasLike,
} from '../video/videoFrameMetrics'
import { CROSSHAIR_RECOIL_ROI, rectToPixels, VIEWMODEL_FLASH_ROI, type PixelRect } from '../video/videoRegions'

export interface VideoVerificationOptions {
  /** Downscale width for decoding — keeps WebCodecs work bounded on long clips. */
  analysisWidth: number
  /** Seconds before the shot to sample for flash baseline and recoil reference. */
  preRollSeconds: number
  /** Seconds after the shot for flash peak search. */
  postRollSeconds: number
  /** Combined flash/recoil score needed to keep a candidate (0–1). */
  minOwnershipScore: number
  /**
   * Minimum muzzle-flash score. Own shots light the viewmodel; camera motion alone must not pass.
   */
  minFlashScore: number
}

export const DEFAULT_VIDEO_VERIFICATION_OPTIONS: VideoVerificationOptions = {
  analysisWidth: 480,
  preRollSeconds: 0.05,
  postRollSeconds: 0.04,
  minOwnershipScore: 0.4,
  minFlashScore: 0.28,
}

export interface VideoShotScores {
  flashScore: number
  recoilScore: number
  ownershipScore: number
}

/** Per-frame metrics snapped while decoding — never keep pooled CanvasSink canvases. */
interface FrameSnapshot {
  timestamp: number
  flashLuma: number
  /** Recoil ROI pixels (copy from getImageData) for later frame-to-frame diff. */
  recoilData: Uint8ClampedArray
  recoilW: number
  recoilH: number
}

function offsetsAroundShot(opts: VideoVerificationOptions): number[] {
  const { preRollSeconds, postRollSeconds } = opts
  return [-preRollSeconds, -preRollSeconds * 0.5, 0, postRollSeconds * 0.5, postRollSeconds]
}

function snapshotFrame(
  canvas: CanvasLike,
  mediaTime: number,
  flashRoi: PixelRect,
  recoilRoi: PixelRect,
): FrameSnapshot {
  const recoil = canvas.getContext('2d')!.getImageData(recoilRoi.x, recoilRoi.y, recoilRoi.w, recoilRoi.h)
  return {
    timestamp: mediaTime,
    flashLuma: canvasRoiMeanLuminance(canvas, flashRoi),
    recoilData: new Uint8ClampedArray(recoil.data),
    recoilW: recoil.width,
    recoilH: recoil.height,
  }
}

function recoilDiff(a: FrameSnapshot, b: FrameSnapshot): number {
  const len = Math.min(a.recoilData.length, b.recoilData.length)
  let sum = 0
  let count = 0
  for (let i = 0; i < len; i += 4) {
    const la =
      (0.2126 * a.recoilData[i] + 0.7152 * a.recoilData[i + 1] + 0.0722 * a.recoilData[i + 2]) / 255
    const lb =
      (0.2126 * b.recoilData[i] + 0.7152 * b.recoilData[i + 1] + 0.0722 * b.recoilData[i + 2]) / 255
    sum += Math.abs(la - lb)
    count++
  }
  return count === 0 ? 0 : sum / count
}

function scoreCandidate(
  shotTime: number,
  frameAt: Map<number, FrameSnapshot>,
  opts: VideoVerificationOptions,
): VideoShotScores | null {
  const offsets = offsetsAroundShot(opts)
  const frames: FrameSnapshot[] = []
  for (const offset of offsets) {
    const key = nearestTimestampKey(frameAt, shotTime + offset)
    const frame = key === undefined ? undefined : frameAt.get(key)
    if (frame) frames.push(frame)
  }
  if (frames.length < 2) return null

  const atShot = nearestFrame(frameAt, shotTime)
  const before = nearestFrame(frameAt, shotTime - opts.preRollSeconds * 0.75)
  if (!atShot || !before) return null
  // Need distinct frames; if decode snapped both to the same key, recoil/flash are meaningless.
  if (atShot.timestamp === before.timestamp) return null

  const baselineSamples = frames
    .filter((f) => f.timestamp < shotTime - 0.008)
    .map((f) => f.flashLuma)
  const baseline =
    baselineSamples.length > 0
      ? baselineSamples.reduce((sum, v) => sum + v, 0) / baselineSamples.length
      : before.flashLuma

  const peakCandidates = frames
    .filter((f) => f.timestamp >= shotTime - 0.008)
    .map((f) => f.flashLuma)
  const peak = peakCandidates.length > 0 ? Math.max(...peakCandidates) : atShot.flashLuma

  const flashScore = scoreMuzzleFlash(baseline, peak)
  const recoilScore = scoreRecoil(recoilDiff(before, atShot))
  const ownershipScore = combineOwnershipScores(flashScore, recoilScore)

  return { flashScore, recoilScore, ownershipScore }
}

function nearestFrame(map: Map<number, FrameSnapshot>, time: number): FrameSnapshot | undefined {
  const key = nearestTimestampKey(map, time)
  return key === undefined ? undefined : map.get(key)
}

function nearestTimestampKey(map: Map<number, FrameSnapshot>, time: number): number | undefined {
  let bestKey: number | undefined
  let bestDist = Infinity
  for (const key of map.keys()) {
    const dist = Math.abs(key - time)
    if (dist < bestDist) {
      bestDist = dist
      bestKey = key
    }
  }
  // ~2 frames at 30fps — looser matches mix unrelated motion into the score.
  return bestDist <= 0.05 ? bestKey : undefined
}

function uniqueSorted(times: number[]): number[] {
  return [...new Set(times.map((t) => Math.round(t * 1000) / 1000))].sort((a, b) => a - b)
}

/**
 * Decodes frames around each audio candidate and scores muzzle flash + view kick. Candidates below
 * thresholds are dropped; survivors get `videoScore` / `videoFlashScore` / `videoRecoilScore`.
 *
 * If the file has no decodable video track (or no frames), returns an empty list — audio candidates
 * must not leak through as "video-verified".
 */
export async function verifyShotsWithVideo(
  file: File,
  shots: DetectedShot[],
  options: Partial<VideoVerificationOptions> = {},
): Promise<DetectedShot[]> {
  if (shots.length === 0) return shots

  const opts = { ...DEFAULT_VIDEO_VERIFICATION_OPTIONS, ...options }
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })

  try {
    const videoTrack = await input.getPrimaryVideoTrack()
    if (!videoTrack || !(await videoTrack.canDecode())) return []

    // poolSize 1 is fine: we snapshot ROI pixels immediately and never keep canvas refs.
    const sink = new CanvasSink(videoTrack, {
      width: opts.analysisWidth,
      poolSize: 1,
    })

    const timeOrigin = await videoTrack.getFirstTimestamp()
    const timestamps = uniqueSorted(
      shots.flatMap((shot) =>
        offsetsAroundShot(opts).map((offset) => timeOrigin + shot.time + offset),
      ),
    )

    const frameAt = new Map<number, FrameSnapshot>()
    let flashRoi: PixelRect | null = null
    let recoilRoi: PixelRect | null = null

    for await (const result of sink.canvasesAtTimestamps(timestamps)) {
      if (!result) continue
      const canvas = result.canvas as CanvasLike
      if (!flashRoi || !recoilRoi) {
        flashRoi = rectToPixels(VIEWMODEL_FLASH_ROI, canvas.width, canvas.height)
        recoilRoi = rectToPixels(CROSSHAIR_RECOIL_ROI, canvas.width, canvas.height)
      }
      const mediaTime = result.timestamp - timeOrigin
      const key = Math.round(mediaTime * 1000) / 1000
      frameAt.set(key, snapshotFrame(canvas, mediaTime, flashRoi, recoilRoi))
    }

    if (frameAt.size === 0) return []

    const verified: DetectedShot[] = []
    for (const shot of shots) {
      const scores = scoreCandidate(shot.time, frameAt, opts)
      if (!scores) continue
      if (scores.flashScore < opts.minFlashScore) continue
      if (scores.ownershipScore < opts.minOwnershipScore) continue
      verified.push({
        ...shot,
        videoScore: scores.ownershipScore,
        videoFlashScore: scores.flashScore,
        videoRecoilScore: scores.recoilScore,
      })
    }

    return verified.sort((a, b) => a.time - b.time)
  } finally {
    input.dispose()
  }
}
