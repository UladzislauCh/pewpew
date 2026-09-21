/**
 * Prepares a measurement of the signal inside the HUMAN-LABELLED weapon region.
 *
 *   pnpm exec tsx eval/weaponSignalPrep.ts
 *   pnpm dev                            # then /eval/weaponSignal.html, it computes and returns JSON
 *   pnpm exec tsx eval/weaponSignalEval.ts       # analysis of the downloaded signals
 *   pnpm exec tsx eval/weaponSignalPrep.ts --clean
 *
 * Why. A human labelled the weapon region on all 49 clips (`eval/weaponRegions.json`), and it
 * barely overlaps with what the heuristic found: median IoU 0.065, 31 clips out of 46 below 0.2,
 * and on six the heuristic did not cover the human box AT ALL. So the 16 `weapon.*` features
 * were computed off the weapon — which explains why turning them off moves F1 from 64.3 only to 64.2.
 *
 * Computed over BOTH regions at once, from one decoding pass: otherwise the comparison would
 * mix the difference between regions with the difference between pipelines.
 */
import { copyFile, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURES_DIR, PROJECT_ROOT, audioFromChannels } from './fixtures'
import { decodeWavFile } from '../scripts/wavDecode'
import { toMono } from '../src/domain/audio/audioTypes'
import { parseClipLabels } from '../src/domain/detection/labels'
import { detectShotsWithNet } from '../src/domain/detection/shotNet/detectShotsWithNet'
import { deserializeWeights } from '../src/domain/detection/shotNet/shotNet'
import { MOTION_PARAMS } from '../src/domain/detection/motion/motionFeatures'
import { loadClipMotion } from './motionCache'

const OUT_DIR = join(FIXTURES_DIR, '__signal')
/** Human boxes by default; `--regions <path>` substitutes others — e.g. auto-search. */
const regionsArg = process.argv.indexOf('--regions')
const REGIONS_PATH = regionsArg >= 0 && process.argv[regionsArg + 1]
  ? join(PROJECT_ROOT, process.argv[regionsArg + 1])
  : join(PROJECT_ROOT, 'eval/weaponRegions.json')
const WEAPON_W = 320
const WEAPON_H = 140

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface SignalEntry {
  slug: string
  duration: number
  /** Human box. `null` if there is no weapon in the frame — sniper zoom or cropping. */
  human: Rect | null
  humanNote: string
  /** What the heuristic found, in the same frame fractions. For a like-for-like comparison. */
  auto: Rect | null
  ownShots: number[]
  enemyShots: number[]
  candidates: { time: number; confidence: number }[]
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--clean')) {
    await rm(OUT_DIR, { recursive: true, force: true })
    console.log('fixtures/__signal удалён')
    return
  }

  const regions = JSON.parse(await readFile(REGIONS_PATH, 'utf8')).regions as Record<
    string,
    { x0?: number; y0?: number; x1?: number; y1?: number; absent?: boolean; note?: string }
  >

  await mkdir(OUT_DIR, { recursive: true })
  const weights = deserializeWeights(await readFile(join(PROJECT_ROOT, 'public/models/shotNet.json'), 'utf8'))

  const slugs = (await readdir(join(PROJECT_ROOT, 'labels')))
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -'.json'.length))
    .sort()

  const entries: SignalEntry[] = []
  for (const slug of slugs) {
    const region = regions[slug]
    if (!region) {
      console.log(`${slug}: пропущен — нет разметки области`)
      continue
    }
    try {
      const labels = parseClipLabels(JSON.parse(await readFile(join(PROJECT_ROOT, 'labels', `${slug}.json`), 'utf8')), slug)
      if (!labels.complete) throw new Error('разметка не завершена')
      const clipPath = join(PROJECT_ROOT, 'examples', labels.clip)
      if (!existsSync(clipPath)) throw new Error(`нет клипа ${labels.clip}`)
      const linkPath = join(OUT_DIR, `${slug}.mp4`)
      if (!existsSync(linkPath)) await symlink(clipPath, linkPath)

      const decoded = decodeWavFile(await readFile(join(PROJECT_ROOT, 'examples/.cache', `${slug}.wav`)))
      const audio = audioFromChannels(decoded.channels, decoded.sampleRate)
      const candidates = detectShotsWithNet(toMono(audio), audio.sampleRate, weights, {
        threshold: MOTION_PARAMS.candidateThreshold,
      }).map((s) => ({ time: s.time, confidence: s.confidence }))

      const motion = await loadClipMotion(slug)
      let auto: Rect | null = null
      const w = motion?.weapon
      if (w) {
        const bh = w.band.y1 - w.band.y0
        auto = {
          x0: w.maskBox.x0 / WEAPON_W,
          x1: (w.maskBox.x1 + 1) / WEAPON_W,
          y0: w.band.y0 + (w.maskBox.y0 / WEAPON_H) * bh,
          y1: w.band.y0 + ((w.maskBox.y1 + 1) / WEAPON_H) * bh,
        }
      }

      entries.push({
        slug,
        duration: labels.duration,
        human: region.absent ? null : { x0: region.x0!, y0: region.y0!, x1: region.x1!, y1: region.y1! },
        humanNote: region.note ?? '',
        auto,
        ownShots: labels.shots.filter((s) => s.source === 'own').map((s) => s.time).sort((a, b) => a - b),
        enemyShots: labels.shots.filter((s) => s.source !== 'own').map((s) => s.time).sort((a, b) => a - b),
        candidates,
      })
    } catch (error) {
      console.log(`${slug}: пропущен — ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  await copyFile(REGIONS_PATH, join(OUT_DIR, 'weaponRegions.json'))
  await writeFile(join(OUT_DIR, 'manifest.json'), JSON.stringify({ entries }, null, 2))
  const withBox = entries.filter((e) => e.human).length
  console.log(`\nклипов ${entries.length}: с рамкой ${withBox}, «оружия нет» ${entries.length - withBox}`)
  console.log('Запустить dev-сервер и открыть /eval/weaponSignal.html')
}

void main()
