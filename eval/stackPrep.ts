/**
 * Prepares an export of weapon-region FRAME STACKS — the input for a trainable pixel model.
 *
 *   pnpm exec tsx eval/stackPrep.ts
 *   pnpm dev                    # then /eval/stacks.html, ~5 min
 *   pnpm exec tsx eval/stackTrain.ts     # training and sweep, locally and in seconds
 *   pnpm exec tsx eval/stackPrep.ts --clean
 *
 * Why pixels exactly. Three hypotheses are closed by measurements: more clips give +5 points
 * for a sevenfold growth in data, more capacity on the current features HURTS (62.1 → 56.8 → 52.7
 * at 8/16/32 hidden units), and the weapon region is squeezed dry (human 62.9 versus auto-search 62.3).
 * One thing remains — what can be extracted from the pixels.
 *
 * All 74 features are summaries of rigid shifts over a ±250 ms window, and such a summary erases
 * at once WHAT changed, WHERE inside the region and AT WHAT moment. And that is exactly what tells
 * a shot apart: bolt travel, an opened ejection port, barrel glow.
 *
 * The region is taken from here, from Node: it is already computed by the block classifier,
 * and there is no point rerunning the analysis in the browser.
 */
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURES_DIR, PROJECT_ROOT, audioFromChannels } from './fixtures'
import { decodeWavFile } from '../scripts/wavDecode'
import { toMono } from '../src/domain/audio/audioTypes'
import { parseClipLabels } from '../src/domain/detection/labels'
import { detectShotsWithNet } from '../src/domain/detection/shotNet/detectShotsWithNet'
import { deserializeWeights } from '../src/domain/detection/shotNet/shotNet'
import { MOTION_PARAMS } from '../src/domain/detection/motion/motionFeatures'
import {
  BLOCK,
  BLOCK_FRAME,
  BLOCK_GRID,
  blockOriginX,
  blockOriginY,
  selectWeaponBlocks,
  type BlockModel,
  type BlockStats,
} from '../src/domain/detection/motion/blockMotion'

const OUT_DIR = join(FIXTURES_DIR, '__stacks')

/**
 * Frame offsets around the candidate, ms. Step ~33 ms — one frame at 30 fps.
 *
 * Counted in TIME, not frames: clips are 30 and 60 fps, and a stack must mean the same thing
 * in both cases, otherwise the model will learn the frame rate.
 */
const ALL_OFFSETS_MS = [-200, -167, -133, -100, -67, -33, 0, 33, 67, 100, 133, 167, 200]
const NARROW_OFFSETS_MS = [-133, -100, -67, -33, 0, 33, 67, 100, 133]
const TIGHT_OFFSETS_MS = [-100, -67, -33, 0, 33, 67, 100]

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback
}

/**
 * Side of the square the region box is reduced to. `--size 64` — twice the detail.
 *
 * This is the main untested variable: at 32 the box is shrunk roughly fifteenfold from the
 * original 1080p, and bolt travel might simply be smeared out. A human saw it on a region
 * about 180 pixels wide.
 */
export const STACK_SIZE = arg('--size', 32)
/** With large stacks the window narrows so the cache does not bloat: the event is short. */
export const STACK_OFFSETS_MS = STACK_SIZE > 80 ? TIGHT_OFFSETS_MS : STACK_SIZE > 48 ? NARROW_OFFSETS_MS : ALL_OFFSETS_MS

export interface StackEntry {
  slug: string
  duration: number
  /** Weapon-region box in fractions of the frame — from the 12 selected blocks. */
  box: { x0: number; y0: number; x1: number; y1: number }
  candidates: { time: number; confidence: number }[]
  ownShots: number[]
}

async function main(): Promise<void> {
  if (process.argv.includes('--clean')) {
    await rm(OUT_DIR, { recursive: true, force: true })
    console.log('fixtures/__stacks удалён')
    return
  }

  const blockModel: BlockModel = JSON.parse(await readFile(join(FIXTURES_DIR, 'models/blockModel.json'), 'utf8'))
  const blocks = JSON.parse(await readFile(join(PROJECT_ROOT, 'eval/.cache/viewmodelBlocks.json'), 'utf8')) as {
    clips: Record<string, BlockStats[] | null>
  }
  const netWeights = deserializeWeights(await readFile(join(PROJECT_ROOT, 'public/models/shotNet.json'), 'utf8'))

  await mkdir(OUT_DIR, { recursive: true })
  const entries: StackEntry[] = []

  for (const slug of (await readdir(join(PROJECT_ROOT, 'labels'))).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).sort()) {
    const stats = blocks.clips[slug]
    if (!stats) continue
    try {
      const labels = parseClipLabels(JSON.parse(await readFile(join(PROJECT_ROOT, 'labels', `${slug}.json`), 'utf8')), slug)
      if (!labels.complete) throw new Error('разметка не завершена')
      const clipPath = join(PROJECT_ROOT, 'examples', labels.clip)
      if (!existsSync(clipPath)) throw new Error(`нет клипа ${labels.clip}`)
      const linkPath = join(OUT_DIR, `${slug}.mp4`)
      if (!existsSync(linkPath)) await symlink(clipPath, linkPath)

      // Box over the selected blocks, with a one-block margin: bolt travel extends past the block
      // boundary, and the network will discard the extra context itself.
      const chosen = selectWeaponBlocks(blockModel, stats).blocks
      let x0 = BLOCK_GRID, x1 = -1, y0 = BLOCK_GRID, y1 = -1
      for (const b of chosen) {
        const bx = blockOriginX(b) / BLOCK
        const by = blockOriginY(b) / BLOCK
        x0 = Math.min(x0, bx); x1 = Math.max(x1, bx)
        y0 = Math.min(y0, by); y1 = Math.max(y1, by)
      }
      const pad = 1
      const box = {
        x0: Math.max(0, x0 - pad) / BLOCK_GRID,
        y0: Math.max(0, y0 - pad) / BLOCK_GRID,
        x1: Math.min(BLOCK_GRID, x1 + 1 + pad) / BLOCK_GRID,
        y1: Math.min(BLOCK_GRID, y1 + 1 + pad) / BLOCK_GRID,
      }

      const decoded = decodeWavFile(await readFile(join(PROJECT_ROOT, 'examples/.cache', `${slug}.wav`)))
      const audio = audioFromChannels(decoded.channels, decoded.sampleRate)

      entries.push({
        slug,
        duration: labels.duration,
        box,
        candidates: detectShotsWithNet(toMono(audio), audio.sampleRate, netWeights, {
          threshold: MOTION_PARAMS.candidateThreshold,
        }).map((s) => ({ time: s.time, confidence: s.confidence })),
        ownShots: labels.shots.filter((s) => s.source === 'own').map((s) => s.time).sort((a, b) => a - b),
      })
    } catch (error) {
      console.log(`${slug}: пропущен — ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  await writeFile(
    join(OUT_DIR, 'manifest.json'),
    JSON.stringify({ offsets: STACK_OFFSETS_MS, size: STACK_SIZE, frameSize: BLOCK_FRAME, entries }, null, 2),
  )
  const total = entries.reduce((n, e) => n + e.candidates.length, 0)
  const bytes = total * STACK_OFFSETS_MS.length * STACK_SIZE * STACK_SIZE
  console.log(`клипов ${entries.length}, кандидатов ${total}`)
  console.log(`стопка ${STACK_OFFSETS_MS.length} кадров по ${STACK_SIZE}x${STACK_SIZE} → кэш около ${(bytes / 1024 / 1024).toFixed(0)} МБ`)
  console.log('Запустить dev-сервер и открыть /eval/stacks.html')
}

void main()
