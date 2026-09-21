/**
 * Prepares human labelling of the weapon region: frames where the viewmodel is visible.
 *
 *   pnpm exec tsx eval/weaponRegionPrep.ts          # all labelled clips
 *   pnpm dev                               # then /eval/weaponRegion.html
 *   pnpm exec tsx eval/weaponRegionPrep.ts --clean
 *
 * Why. The weapon region is currently found by a heuristic — the p10..p45 variability band and
 * the largest connected region — and it does not land on the weapon. Checked by eye on five
 * clips in a row: on `usp-0` the mask takes the whole bottom strip of the frame (the streamer's
 * webcam is there), on `ssg08` it sits in the LEFT half while the player's weapon is on the
 * right, on `awp` it spreads over a quarter of the frame. The viewmodel never takes that much space.
 *
 * The consequence was measured: 16 `weapon.*` features out of 74 currently break even — turning
 * them off moves F1 from 64.3 to 64.2, with 15 clips getting better and 22 worse.
 * So they measure a random, moderately stable region, not the weapon.
 *
 * A human box resolves this ambiguity at once: according to the journal, the residual inside a
 * human-labelled region gave an AUC of 0.949 "own versus enemy" with a single scalar,
 * versus 0.910 for the whole model.
 *
 * Frames are taken AT OWN-SHOT MOMENTS: gameplay is guaranteed there and the weapon is raised,
 * not holstered for running.
 */
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURES_DIR, PROJECT_ROOT } from './fixtures'
import { parseClipLabels } from '../src/domain/detection/labels'
import { loadClipMotion } from './motionCache'

const OUT_DIR = join(FIXTURES_DIR, '__region')
/** How many candidate frames to show per clip: the weapon may be hidden by smoke or an effect. */
const FRAMES_PER_CLIP = 6

export interface RegionClip {
  slug: string
  clip: string
  duration: number
  ownShots: number
  sparse: boolean
  /** Times at which to show a frame for labelling. */
  frameTimes: number[]
  /** What the heuristic found — shown faded, for comparison. */
  autoBox: { x0: number; y0: number; x1: number; y1: number } | null
  autoMaskPx: number | null
}

export interface RegionManifest {
  clips: RegionClip[]
}

const WEAPON_W = 320
const WEAPON_H = 140

async function prepare(slug: string): Promise<RegionClip> {
  const raw: unknown = JSON.parse(await readFile(join(PROJECT_ROOT, 'labels', `${slug}.json`), 'utf8'))
  const labels = parseClipLabels(raw, `labels/${slug}.json`)
  if (!labels.complete) throw new Error('разметка не завершена')

  const clipPath = join(PROJECT_ROOT, 'examples', labels.clip)
  if (!existsSync(clipPath)) throw new Error(`нет клипа ${labels.clip}`)
  const linkPath = join(OUT_DIR, `${slug}.mp4`)
  if (!existsSync(linkPath)) await symlink(clipPath, linkPath)

  const own = labels.shots.filter((s) => s.source === 'own').map((s) => s.time).sort((a, b) => a - b)
  // Frames spread evenly OVER THE LIST of shots, not over time: this way they fall on
  // different firefights instead of crowding into one long burst.
  const frameTimes: number[] = []
  const source = own.length ? own : Array.from({ length: FRAMES_PER_CLIP }, (_, i) => (labels.duration * (i + 1)) / (FRAMES_PER_CLIP + 1))
  for (let i = 0; i < Math.min(FRAMES_PER_CLIP, source.length); i++) {
    const t = source[Math.floor((i * source.length) / Math.min(FRAMES_PER_CLIP, source.length))]
    // Slightly AFTER the shot: on the shot frame itself the weapon is smeared by recoil and flash.
    frameTimes.push(Math.min(labels.duration - 0.05, t + 0.12))
  }

  // Heuristic box in fractions of the frame: the mask was computed in a 320x140 crop inside the gameplay band.
  const motion = await loadClipMotion(slug)
  let autoBox: RegionClip['autoBox'] = null
  const w = motion?.weapon
  if (w) {
    const bh = w.band.y1 - w.band.y0
    autoBox = {
      x0: w.maskBox.x0 / WEAPON_W,
      x1: (w.maskBox.x1 + 1) / WEAPON_W,
      y0: w.band.y0 + (w.maskBox.y0 / WEAPON_H) * bh,
      y1: w.band.y0 + ((w.maskBox.y1 + 1) / WEAPON_H) * bh,
    }
  }

  return {
    slug,
    clip: labels.clip,
    duration: labels.duration,
    ownShots: own.length,
    sparse: own.length <= 20,
    frameTimes,
    autoBox,
    autoMaskPx: w?.maskPx ?? null,
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--clean')) {
    await rm(OUT_DIR, { recursive: true, force: true })
    console.log('fixtures/__region удалён')
    return
  }

  const explicit = args.filter((a) => !a.startsWith('-'))
  const wanted = explicit.length
    ? explicit
    : (await readdir(join(PROJECT_ROOT, 'labels')))
        .filter((n) => n.endsWith('.json'))
        .map((n) => n.slice(0, -'.json'.length))
        .sort()

  await mkdir(OUT_DIR, { recursive: true })
  const clips: RegionClip[] = []
  for (const slug of wanted) {
    try {
      clips.push(await prepare(slug))
    } catch (error) {
      console.log(`${slug}: пропущен — ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Sparse first: that is where the model fails, and that is also where weapons are pistols and
  // snipers, i.e. there are enough frames per shot for the feature to exist at all.
  clips.sort((a, b) => Number(b.sparse) - Number(a.sparse) || a.slug.localeCompare(b.slug))

  const manifest: RegionManifest = { clips }
  await writeFile(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(`клипов ${clips.length}, из них разреженных ${clips.filter((c) => c.sparse).length}`)
  console.log('Запустить dev-сервер и открыть /eval/weaponRegion.html')
}

void main()
