import type { PixelRect } from './videoRegions'

export interface RgbaBuffer {
  data: Uint8ClampedArray
  width: number
  height: number
}

/** Rec. 601 luma for a single RGB pixel. */
export function pixelLuminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

export function roiMeanLuminance(buffer: RgbaBuffer, rect: PixelRect): number {
  const { data, width } = buffer
  const xEnd = Math.min(buffer.width, rect.x + rect.w)
  const yEnd = Math.min(buffer.height, rect.y + rect.h)
  let sum = 0
  let count = 0
  for (let y = rect.y; y < yEnd; y++) {
    const row = y * width
    for (let x = rect.x; x < xEnd; x++) {
      const i = (row + x) * 4
      sum += pixelLuminance(data[i], data[i + 1], data[i + 2])
      count++
    }
  }
  return count === 0 ? 0 : sum / count
}

export function roiMeanAbsLuminanceDiff(a: RgbaBuffer, b: RgbaBuffer, rect: PixelRect): number {
  const { data: da, width } = a
  const db = b.data
  const xEnd = Math.min(a.width, b.width, rect.x + rect.w)
  const yEnd = Math.min(a.height, b.height, rect.y + rect.h)
  let sum = 0
  let count = 0
  for (let y = rect.y; y < yEnd; y++) {
    const row = y * width
    for (let x = rect.x; x < xEnd; x++) {
      const i = (row + x) * 4
      const la = pixelLuminance(da[i], da[i + 1], da[i + 2])
      const lb = pixelLuminance(db[i], db[i + 1], db[i + 2])
      sum += Math.abs(la - lb)
      count++
    }
  }
  return count === 0 ? 0 : sum / count
}

export interface Canvas2dLike {
  getImageData(
    sx: number,
    sy: number,
    sw: number,
    sh: number,
  ): { data: Uint8ClampedArray; width: number; height: number }
}

export interface CanvasLike {
  width: number
  height: number
  getContext(contextId: '2d'): Canvas2dLike | null
}

export function readCanvasRegion(canvas: CanvasLike, rect: PixelRect): RgbaBuffer {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable')
  const image = ctx.getImageData(rect.x, rect.y, rect.w, rect.h)
  return { data: image.data, width: image.width, height: image.height }
}

export function canvasRoiMeanLuminance(canvas: CanvasLike, rect: PixelRect): number {
  return roiMeanLuminance(readCanvasRegion(canvas, rect), { x: 0, y: 0, w: rect.w, h: rect.h })
}

export function canvasRoiMeanAbsLuminanceDiff(
  before: CanvasLike,
  after: CanvasLike,
  rect: PixelRect,
): number {
  const a = readCanvasRegion(before, rect)
  const b = readCanvasRegion(after, rect)
  return roiMeanAbsLuminanceDiff(a, b, { x: 0, y: 0, w: rect.w, h: rect.h })
}

/**
 * Muzzle-flash score: how much the viewmodel ROI brightens at the shot vs a short pre-roll baseline.
 */
export function scoreMuzzleFlash(
  baselineLuma: number,
  peakLuma: number,
): number {
  const rise = peakLuma - baselineLuma
  // Ignore tiny rises from compression noise / HUD blinks.
  if (rise < 0.035) return 0
  // Typical flash adds ~0.08–0.35 luma on compressed gameplay footage.
  return Math.min(1, rise / 0.16)
}

/**
 * Recoil score: mean luminance change in the crosshair ROI between a pre-frame and the shot frame.
 */
export function scoreRecoil(meanAbsDiff: number): number {
  // Walking / mouse look easily hits ~0.02–0.04; require a sharper kick.
  if (meanAbsDiff < 0.025) return 0
  return Math.min(1, meanAbsDiff / 0.1)
}

/**
 * Ownership: muzzle flash is the primary own-shot signal. Recoil alone (camera motion) must not pass.
 */
export function combineOwnershipScores(flashScore: number, recoilScore: number): number {
  if (flashScore <= 0) return 0
  return Math.min(1, flashScore * 0.75 + recoilScore * 0.25 + flashScore * recoilScore * 0.15)
}
