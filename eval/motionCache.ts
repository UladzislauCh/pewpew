/**
 * Motion signals captured in advance — the only way to measure the second stage in Node.
 *
 * Node has neither canvas nor WebCodecs, so frames are not decoded here. The series were computed
 * once by the same code that is in prod (`computeZoneMotion`, `computeWeaponMotion`), and live
 * in `eval/.cache/motion/`. So measurements from here describe the model's DECISION.
 *
 * That decoding does not interfere was checked separately and on the whole set: browser frames
 * give the same F1 within 0.2 points (docs/RESEARCH-journal.md,
 * "Browser decoding vs the reference: reconciled on all 49 clips").
 *
 * The cache was moved over from the research repository; it can be recomputed by the page
 * `eval/decodeCheck.html`, which computes the same series from browser frames.
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WeaponMotion, ZoneMotion } from '../src/domain/detection/motion/motionFeatures'

const EVAL_DIR = dirname(fileURLToPath(import.meta.url))
export const MOTION_CACHE_DIR = join(EVAL_DIR, '.cache/motion')
/** Per-frame ShotNet curves from CROSS-VALIDATION: each clip scored by a model that has not seen it. */
export const CV_CURVES_PATH = join(EVAL_DIR, '.cache/shotnet-cv-curves.json')

export interface ClipMotion {
  zone: ZoneMotion
  /** null if the gameplay band was not found or the mask did not fill up — a legitimate state. */
  weapon: WeaponMotion | null
}

/** Returns null if the clip has no cache: the caller decides whether to skip or fail. */
export async function loadClipMotion(slug: string): Promise<ClipMotion | null> {
  const zonePath = join(MOTION_CACHE_DIR, 'zone', `${slug}.json`)
  if (!existsSync(zonePath)) return null

  const z = JSON.parse(await readFile(zonePath, 'utf8'))
  const zone: ZoneMotion = {
    grid: z.grid,
    frames: z.frames,
    fps: z.fps,
    dx: z.dx.map((a: number[]) => Float64Array.from(a)),
    dy: z.dy.map((a: number[]) => Float64Array.from(a)),
  }

  let weapon: WeaponMotion | null = null
  const weaponPath = join(MOTION_CACHE_DIR, 'weapon', `${slug}.json`)
  if (existsSync(weaponPath)) {
    const w = JSON.parse(await readFile(weaponPath, 'utf8'))
    weapon = {
      frames: w.frames,
      fps: w.fps,
      band: w.band,
      maskPx: w.maskPx,
      maskBox: w.maskBox,
      dx: Float64Array.from(w.dx),
      dy: Float64Array.from(w.dy),
    }
  }

  return { zone, weapon }
}
