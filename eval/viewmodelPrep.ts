/**
 * Prepares the weapon-region auto-search: frames are chosen by ALREADY COMPUTED camera motion.
 *
 *   pnpm exec tsx eval/viewmodelPrep.ts
 *   pnpm dev                          # then /eval/viewmodel.html
 *   pnpm exec tsx eval/viewmodelEval.ts        # check against human boxes
 *   pnpm exec tsx eval/viewmodelPrep.ts --clean
 *
 * The idea. The viewmodel is defined by NOT MOVING WITH THE CAMERA: when the mouse turns, the
 * scene slides away, while the weapon stays put in frame coordinates. The cue depends on neither
 * handedness (on `p2000` the weapon is in the left hand), nor cropping, nor brightness.
 *
 * The previous attempt (`findViewmodel.mjs` in the journal) on the same idea decomposed the frame
 * correctly but could not separate the weapon from the REST of what is pinned to the screen: the
 * killfeed, nicknames and signs behave the same. Two things absent there are added here.
 *
 * FIRST — a third criterion: the weapon MOVES AT CANDIDATE MOMENTS, the killfeed does not.
 * Candidates come from the sound, i.e. are available in prod too; labels are not used, so there
 * is no peeking. The result is still checked by IoU against human boxes, not by detection
 * quality on the same candidates.
 *
 * SECOND — a reference. A human labelled the region on 49 clips (`eval/weaponRegions.json`),
 * and now there is something to measure against. The previous attempt was checked by eye on six clips.
 *
 * Frames are selected by the magnitude of the scene shift: where the camera stands still,
 * "moves with the scene" and "pinned" are indistinguishable. The magnitude comes from the
 * ready zone cache, to avoid an extra pass over the video.
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
import { loadClipMotion } from './motionCache'

const OUT_DIR = join(FIXTURES_DIR, '__viewmodel')
/** How many frames with the strongest camera motion to analyse block by block. */
const FRAMES_USED = 60

export interface ViewmodelEntry {
  slug: string
  duration: number
  frames: number
  fps: number
  /** Indices of frames with the strongest scene shift — where decomposition is possible at all. */
  pickedFrames: number[]
  /** Candidate times from the sound. Labels are NOT used — they are only for the check afterwards. */
  candidates: number[]
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--clean')) {
    await rm(OUT_DIR, { recursive: true, force: true })
    console.log('fixtures/__viewmodel удалён')
    return
  }

  await mkdir(OUT_DIR, { recursive: true })
  const weights = deserializeWeights(await readFile(join(PROJECT_ROOT, 'public/models/shotNet.json'), 'utf8'))
  const slugs = (await readdir(join(PROJECT_ROOT, 'labels')))
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -'.json'.length))
    .sort()

  const entries: ViewmodelEntry[] = []
  for (const slug of slugs) {
    try {
      const labels = parseClipLabels(JSON.parse(await readFile(join(PROJECT_ROOT, 'labels', `${slug}.json`), 'utf8')), slug)
      if (!labels.complete) throw new Error('разметка не завершена')
      const clipPath = join(PROJECT_ROOT, 'examples', labels.clip)
      if (!existsSync(clipPath)) throw new Error(`нет клипа ${labels.clip}`)
      const motion = await loadClipMotion(slug)
      if (!motion) throw new Error('нет кэша движения зон')

      const linkPath = join(OUT_DIR, `${slug}.mp4`)
      if (!existsSync(linkPath)) await symlink(clipPath, linkPath)

      const { zone } = motion
      const Z = zone.grid * zone.grid
      const magnitude: { f: number; m: number }[] = []
      for (let f = 1; f < zone.frames; f++) {
        let m = 0
        for (let z = 0; z < Z; z++) m += Math.abs(zone.dx[z][f]) + Math.abs(zone.dy[z][f])
        magnitude.push({ f, m: m / Z })
      }
      magnitude.sort((a, b) => b.m - a.m)
      const pickedFrames = magnitude.slice(0, FRAMES_USED).map((x) => x.f).sort((a, b) => a - b)

      const decoded = decodeWavFile(await readFile(join(PROJECT_ROOT, 'examples/.cache', `${slug}.wav`)))
      const audio = audioFromChannels(decoded.channels, decoded.sampleRate)
      const candidates = detectShotsWithNet(toMono(audio), audio.sampleRate, weights, {
        threshold: MOTION_PARAMS.candidateThreshold,
      }).map((s) => s.time)

      entries.push({ slug, duration: labels.duration, frames: zone.frames, fps: zone.fps, pickedFrames, candidates })
    } catch (error) {
      console.log(`${slug}: пропущен — ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  await writeFile(join(OUT_DIR, 'manifest.json'), JSON.stringify({ framesUsed: FRAMES_USED, entries }, null, 2))
  console.log(`клипов ${entries.length}, по ${FRAMES_USED} кадров на разбор`)
  console.log('Запустить dev-сервер и открыть /eval/viewmodel.html')
}

void main()
