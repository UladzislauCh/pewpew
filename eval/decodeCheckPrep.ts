/**
 * Prepares material for checking browser decoding against the reference.
 *
 *   pnpm exec tsx eval/decodeCheckPrep.ts [slug ...]
 *   pnpm dev            # then open /eval/decodeCheck.html
 *   pnpm exec tsx eval/decodeCheckPrep.ts --clean
 *
 * Why at all. The motion model was trained on frames from `frametool` (AVFoundation,
 * nearest neighbour, integer Rec.601), while in the browser frames come from mediabunny/WebCodecs.
 * These are DIFFERENT pixels: their YUV-to-RGB conversion does not match. The question is not
 * whether the pixels match — they do not — but whether the divergence survives to the model's DECISION.
 *
 * The check must run in the browser: Node has no WebCodecs, and that is exactly what is checked.
 * So the script only lays out material into `fixtures/__check/`, and the browser computes.
 *
 * Candidates are computed here, not in the browser, on purpose: both sides of the check must
 * get THE SAME list of points, otherwise a difference in audio decoding would mix with the
 * difference in video decoding, and it would be unclear what exactly diverged.
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
import { MOTION_CACHE_DIR } from './motionCache'

const ZONE_DIR = join(MOTION_CACHE_DIR, 'zone')
const WEAPON_DIR = join(MOTION_CACHE_DIR, 'weapon')
const OUT_DIR = join(FIXTURES_DIR, '__check')

/**
 * Default clips. `ak47` has already been checked; these two have a different HUD layout:
 * their gameplay band and weapon mask are of a fundamentally different size, and the second
 * decoding pass depends precisely on them.
 */
const DEFAULT_SLUGS = [
  'kscerato-insane-ace-vs-vitality-shanghaimajor202-29c16b29',
  'sawedoff-4d0b1bb9',
]

export interface CheckEntry {
  slug: string
  clip: string
  /** Duration from the labels — the same used in training; fps is derived as frames/duration. */
  duration: number
  candidates: { time: number; confidence: number }[]
  /**
   * Times of OWN shots from the labels. Agreement with the reference says nothing about quality
   * by itself: the reference is not the truth, only the frames the model learned on. If the branches
   * diverged, the question is whether the browser one got WORSE, and that is measured only against the labels.
   */
  ownShots: number[]
}

async function prepare(slug: string): Promise<CheckEntry> {
  const rawLabels: unknown = JSON.parse(await readFile(join(PROJECT_ROOT, 'labels', `${slug}.json`), 'utf8'))
  const labels = parseClipLabels(rawLabels, `labels/${slug}.json`)
  if (!labels.complete) throw new Error('разметка не завершена')

  const clipPath = join(PROJECT_ROOT, 'examples', labels.clip)
  if (!existsSync(clipPath)) throw new Error(`нет клипа ${labels.clip}`)
  const zonePath = join(ZONE_DIR, `${slug}.json`)
  if (!existsSync(zonePath)) throw new Error(`нет кэша движения зон`)

  // File name in fixtures/__check/ is the slug, not the original: clip names contain spaces and "#",
  // and "#" in a URL cuts the path into a fragment. A link, not a copy: on the whole set that is 350 MB.
  const linkPath = join(OUT_DIR, `${slug}.mp4`)
  if (!existsSync(linkPath)) await symlink(clipPath, linkPath)
  await copyFile(zonePath, join(OUT_DIR, `${slug}.zone.json`))
  const weaponPath = join(WEAPON_DIR, `${slug}.json`)
  if (existsSync(weaponPath)) await copyFile(weaponPath, join(OUT_DIR, `${slug}.weapon.json`))

  const weights = deserializeWeights(await readFile(join(PROJECT_ROOT, 'public/models/shotNet.json'), 'utf8'))
  const decoded = decodeWavFile(await readFile(join(PROJECT_ROOT, 'examples/.cache', `${slug}.wav`)))
  const audio = audioFromChannels(decoded.channels, decoded.sampleRate)

  const shots = detectShotsWithNet(toMono(audio), audio.sampleRate, weights, {
    threshold: MOTION_PARAMS.candidateThreshold,
  })

  return {
    slug,
    clip: labels.clip,
    duration: labels.duration,
    candidates: shots.map((s) => ({ time: s.time, confidence: s.confidence })),
    ownShots: labels.shots
      .filter((s) => s.source === 'own')
      .map((s) => s.time)
      .sort((a, b) => a - b),
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--clean')) {
    await rm(OUT_DIR, { recursive: true, force: true })
    console.log('fixtures/__check удалён')
    return
  }

  const slugs = args.filter((a) => !a.startsWith('-'))
  let wanted = slugs.length ? slugs : DEFAULT_SLUGS
  if (args.includes('--all')) {
    wanted = (await readdir(join(PROJECT_ROOT, 'labels')))
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -'.json'.length))
      .sort()
  }

  await mkdir(OUT_DIR, { recursive: true })
  const entries: CheckEntry[] = []
  for (const slug of wanted) {
    try {
      const entry = await prepare(slug)
      entries.push(entry)
      console.log(`${slug}: ${entry.candidates.length} кандидатов, ${entry.duration.toFixed(2)} с`)
    } catch (error) {
      console.log(`${slug}: пропущен — ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  await writeFile(join(OUT_DIR, 'manifest.json'), JSON.stringify({ entries }, null, 2))
  console.log()
  console.log('Готово. Запустить dev-сервер и открыть /eval/decodeCheck.html')
  console.log('После сверки: pnpm exec tsx eval/decodeCheckPrep.ts --clean')
}

void main()
