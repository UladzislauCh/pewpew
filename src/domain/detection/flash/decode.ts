/**
 * Parsing YOLOv8 output and suppressing overlaps.
 *
 * THE OUTPUT SHAPE OF v8 DIFFERS FROM v5, and every browser port trips over it: the tensor comes
 * as [1, 4 + classes, anchors] — i.e. TRANSPOSED, the feature changes slowly, the anchor fast.
 * And v8 has no objectness at all: confidence is directly the max over classes, there is nothing
 * to multiply by.
 *
 * Coordinates come in model INPUT pixels (cx, cy, w, h), not fractions, and have to be mapped back
 * to the frame through the letterbox.
 */
import type { Letterbox } from './letterbox'

export interface Box {
  /** Coordinates in pixels of the ORIGINAL frame. */
  x: number
  y: number
  w: number
  h: number
  score: number
  classId: number
}

/** Overlap threshold at which two boxes count as one. The ultralytics default. */
export const DEFAULT_IOU = 0.45

function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.w, b.x + b.w)
  const y2 = Math.min(a.y + a.h, b.y + b.h)
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  if (inter <= 0) return 0
  return inter / (a.w * a.h + b.w * b.h - inter)
}

/**
 * Tensor -> boxes in frame coordinates.
 *
 * @param data   network output, length (4 + classes) * anchors
 * @param shape  output shape from `session.outputMetadata`, so the class count is not hard-coded
 */
export function decodeBoxes(
  data: Float32Array,
  shape: readonly number[],
  box: Letterbox,
  minScore: number,
): Box[] {
  const features = shape[1]
  const anchors = shape[2]
  const classes = features - 4
  const out: Box[] = []

  for (let a = 0; a < anchors; a++) {
    let best = -1
    let bestScore = minScore
    for (let c = 0; c < classes; c++) {
      const s = data[(4 + c) * anchors + a]
      if (s > bestScore) {
        bestScore = s
        best = c
      }
    }
    if (best < 0) continue

    // From centre plus sides to the top-left corner, and straight back to frame coordinates.
    const cx = (data[a] - box.padX) / box.scale
    const cy = (data[anchors + a] - box.padY) / box.scale
    const w = data[2 * anchors + a] / box.scale
    const h = data[3 * anchors + a] / box.scale
    out.push({ x: cx - w / 2, y: cy - h / 2, w, h, score: bestScore, classId: best })
  }
  return out
}

/** Non-maximum suppression, PER CLASS: a flash and a tracer may legitimately overlap. */
export function suppress(boxes: Box[], iouThreshold = DEFAULT_IOU): Box[] {
  const kept: Box[] = []
  for (const candidate of [...boxes].sort((a, b) => b.score - a.score)) {
    if (kept.some((k) => k.classId === candidate.classId && iou(k, candidate) > iouThreshold)) continue
    kept.push(candidate)
  }
  return kept
}
