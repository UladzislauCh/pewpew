/**
 * Prepares a measurement with a WEIGHT MAP instead of a rectangle.
 *
 *   pnpm exec tsx eval/viewmodelEval.ts --learn      # weight maps first
 *   pnpm exec tsx eval/weightedPrep.ts
 *   pnpm dev                                # then /eval/weighted.html
 *   pnpm exec tsx eval/weightedEval.ts
 *   pnpm exec tsx eval/weightedPrep.ts --clean
 *
 * Why. A rectangle throws away everything the block classifier knows: inside the box a block
 * with probability 0.9 and one with 0.3 weigh the same, outside both weigh zero. A box miss then
 * does not worsen the result but zeroes it (`p2000`, IoU 0.00). It was measured that scheme D
 * — the frame-difference feature — turns into noise on auto-search boxes (60.9 versus 61.4 without it),
 * against 62.9 on human boxes: it needs box accuracy, not box size.
 *
 * A weight map removes both limitations at once. The rectangle turns out to be its special case:
 * weights 0 and 1, with the ones forming a rectangle.
 *
 * Along the way the page saves PER-FRAME block differences to a separate binary file.
 * This is the main bet of this round: after one decoding pass any weighting scheme is
 * computed locally in seconds, not in a seven-minute browser run.
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
import { blockFeatures, type BlockModel, type BlockStats } from '../src/domain/detection/motion/blockMotion'

const OUT_DIR = join(FIXTURES_DIR, '__weighted')
const WEIGHTS_PATH = join(PROJECT_ROOT, 'eval/.cache/blockWeights.json')

export interface WeightedEntry {
  slug: string
  duration: number
  /** Probability "block is on the weapon" for each grid block, in row order. */
  weights: number[]
  candidates: { time: number; confidence: number }[]
  ownShots: number[]
  enemyShots: number[]
}

async function main(): Promise<void> {
  if (process.argv.includes('--clean')) {
    await rm(OUT_DIR, { recursive: true, force: true })
    console.log('fixtures/__weighted удалён')
    return
  }
  if (!existsSync(WEIGHTS_PATH)) {
    console.log(`нет ${WEIGHTS_PATH} — сначала pnpm exec tsx eval/viewmodelEval.ts --learn`)
    return
  }

  const { grid, clips: cvWeights } = JSON.parse(await readFile(WEIGHTS_PATH, 'utf8')) as {
    grid: number
    clips: Record<string, number[]>
  }

  /**
   * `--prod` computes block probabilities with the SHIPPED classifier instead of cross-validated ones.
   *
   * Training the motion model needs exactly the cross-validated weights — otherwise region selection
   * would have peeked at the clip it is later checked on. For the `pnpm eval` cache, which tracks
   * regressions of the shipped scheme, it is the opposite: the same weights as in the product,
   * otherwise the measurement describes a different block selection.
   */
  let weightsByClip = cvWeights
  if (process.argv.includes('--prod')) {
    const model: BlockModel = JSON.parse(await readFile(join(FIXTURES_DIR, 'models/blockModel.json'), 'utf8'))
    const blocks = JSON.parse(await readFile(join(PROJECT_ROOT, 'eval/.cache/viewmodelBlocks.json'), 'utf8')) as {
      clips: Record<string, BlockStats[] | null>
    }
    weightsByClip = {}
    for (const [slug, stats] of Object.entries(blocks.clips)) {
      if (!stats) continue
      weightsByClip[slug] = blockFeatures(stats).map((f) => {
        let z = model.bias
        for (let j = 0; j < f.length; j++) z += model.weights[j] * f[j]
        return 1 / (1 + Math.exp(-z))
      })
    }
    console.log('веса блоков — от ОТГРУЖЕННОГО классификатора (--prod)')
  }

  await mkdir(OUT_DIR, { recursive: true })
  const netWeights = deserializeWeights(await readFile(join(PROJECT_ROOT, 'public/models/shotNet.json'), 'utf8'))

  const entries: WeightedEntry[] = []
  for (const slug of (await readdir(join(PROJECT_ROOT, 'labels'))).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).sort()) {
    const weights = weightsByClip[slug]
    if (!weights) continue
    try {
      const labels = parseClipLabels(JSON.parse(await readFile(join(PROJECT_ROOT, 'labels', `${slug}.json`), 'utf8')), slug)
      if (!labels.complete) throw new Error('разметка не завершена')
      const clipPath = join(PROJECT_ROOT, 'examples', labels.clip)
      if (!existsSync(clipPath)) throw new Error(`нет клипа ${labels.clip}`)
      const linkPath = join(OUT_DIR, `${slug}.mp4`)
      if (!existsSync(linkPath)) await symlink(clipPath, linkPath)

      const decoded = decodeWavFile(await readFile(join(PROJECT_ROOT, 'examples/.cache', `${slug}.wav`)))
      const audio = audioFromChannels(decoded.channels, decoded.sampleRate)

      entries.push({
        slug,
        duration: labels.duration,
        weights,
        candidates: detectShotsWithNet(toMono(audio), audio.sampleRate, netWeights, {
          threshold: MOTION_PARAMS.candidateThreshold,
        }).map((s) => ({ time: s.time, confidence: s.confidence })),
        ownShots: labels.shots.filter((s) => s.source === 'own').map((s) => s.time).sort((a, b) => a - b),
        enemyShots: labels.shots.filter((s) => s.source !== 'own').map((s) => s.time).sort((a, b) => a - b),
      })
    } catch (error) {
      console.log(`${slug}: пропущен — ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  await writeFile(join(OUT_DIR, 'manifest.json'), JSON.stringify({ grid, entries }, null, 2))
  console.log(`клипов ${entries.length}, сетка ${grid}x${grid}`)
  console.log('Запустить dev-сервер и открыть /eval/weighted.html')
}

void main()
