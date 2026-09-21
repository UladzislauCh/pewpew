import { describe, expect, it } from 'vitest'
import {
  combineOwnershipScores,
  pixelLuminance,
  roiMeanAbsLuminanceDiff,
  roiMeanLuminance,
  scoreMuzzleFlash,
  scoreRecoil,
  type RgbaBuffer,
} from '../src/domain/video/videoFrameMetrics'

function solidBuffer(width: number, height: number, rgb: [number, number, number]): RgbaBuffer {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgb[0]
    data[i + 1] = rgb[1]
    data[i + 2] = rgb[2]
    data[i + 3] = 255
  }
  return { data, width, height }
}

function bufferWithBrightBottom(
  width: number,
  height: number,
  dim: [number, number, number],
  bright: [number, number, number],
  brightRowStart: number,
): RgbaBuffer {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    const rgb = y >= brightRowStart ? bright : dim
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      data[i] = rgb[0]
      data[i + 1] = rgb[1]
      data[i + 2] = rgb[2]
      data[i + 3] = 255
    }
  }
  return { data, width, height }
}

describe('videoFrameMetrics', () => {
  it('computes Rec. 601 luma', () => {
    expect(pixelLuminance(255, 255, 255)).toBeCloseTo(1, 5)
    expect(pixelLuminance(0, 0, 0)).toBeCloseTo(0, 5)
  })

  it('detects a brightness rise as muzzle flash', () => {
    const baseline = 0.12
    const peak = 0.28
    expect(scoreMuzzleFlash(baseline, peak)).toBeGreaterThan(0.5)
    expect(scoreMuzzleFlash(peak, baseline)).toBe(0)
    expect(scoreMuzzleFlash(0.2, 0.22)).toBe(0)
  })

  it('detects ROI motion as recoil', () => {
    const w = 40
    const h = 40
    const before = solidBuffer(w, h, [40, 40, 40])
    const after = bufferWithBrightBottom(w, h, [40, 40, 40], [200, 200, 200], 10)
    const diff = roiMeanAbsLuminanceDiff(before, after, { x: 0, y: 0, w, h })
    expect(scoreRecoil(diff)).toBeGreaterThan(0.3)
  })

  it('combines flash with recoil, but rejects recoil-only motion', () => {
    expect(combineOwnershipScores(0.6, 0.4)).toBeGreaterThan(0.5)
    expect(combineOwnershipScores(0, 0.9)).toBe(0)
    expect(combineOwnershipScores(0.05, 0.9)).toBeLessThan(0.3)
  })

  it('measures mean luma in a sub-rectangle', () => {
    const buf = bufferWithBrightBottom(20, 20, [0, 0, 0], [255, 255, 255], 15)
    const bottom = roiMeanLuminance(buf, { x: 0, y: 15, w: 20, h: 5 })
    const top = roiMeanLuminance(buf, { x: 0, y: 0, w: 20, h: 5 })
    expect(bottom).toBeGreaterThan(top)
  })
})
