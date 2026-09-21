/** Axis-aligned region as fractions of frame width / height (0–1). */
export interface NormalizedRect {
  x: number
  y: number
  w: number
  h: number
}

export interface PixelRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Viewmodel / muzzle flash — lower-center weapon area on a CS2 POV frame.
 * Kept tighter than a half-frame slab so scene cuts / HUD don't look like flashes.
 */
export const VIEWMODEL_FLASH_ROI: NormalizedRect = {
  x: 0.32,
  y: 0.58,
  w: 0.36,
  h: 0.3,
}

/**
 * Crosshair / camera kick — compact center band. Large ROIs turn ordinary mouse look into "recoil".
 */
export const CROSSHAIR_RECOIL_ROI: NormalizedRect = {
  x: 0.38,
  y: 0.32,
  w: 0.24,
  h: 0.28,
}

export function rectToPixels(rect: NormalizedRect, frameWidth: number, frameHeight: number): PixelRect {
  const x = Math.floor(rect.x * frameWidth)
  const y = Math.floor(rect.y * frameHeight)
  const w = Math.max(1, Math.min(frameWidth - x, Math.floor(rect.w * frameWidth)))
  const h = Math.max(1, Math.min(frameHeight - y, Math.floor(rect.h * frameHeight)))
  return { x, y, w, h }
}
