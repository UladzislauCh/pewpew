/**
 * Loads the evaluation fixtures: committed ground-truth annotations from `labels/` paired with the
 * decoded PCM the labeling tool cached into `examples/.cache/`.
 *
 * The cache exists because Node here has neither WebCodecs nor ffmpeg, so the mp4 audio can only be
 * decoded in a browser. Caching it as 32-bit float WAV keeps the samples bit-identical to what the
 * app itself analyzes, so offline scores describe the detector rather than a decoding difference.
 */
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeWavFile } from '../scripts/wavDecode'
import type { AudioLike } from '../src/domain/audio/audioTypes'
import { parseClipLabels, type ClipLabels } from '../src/domain/detection/labels'

export const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const LABELS_DIR = join(PROJECT_ROOT, 'labels')
/**
 * Research material for browser pages. NOT in `public/`: Vite copies everything from there into
 * the build, resolving symlinks, and the artefact bloated from 44 MB to 2.1 GB. It is served under
 * URLs by the dev plugin `scripts/fixtureServer.ts`, with the same addresses as before.
 */
export const FIXTURES_DIR = join(PROJECT_ROOT, 'fixtures')
export const AUDIO_CACHE_DIR = join(PROJECT_ROOT, 'examples/.cache')

/** Wraps raw channel data in the structural `AudioLike` view the detection pipeline consumes. */
export function audioFromChannels(channels: Float32Array[], sampleRate: number): AudioLike {
  const length = channels[0]?.length ?? 0
  return {
    sampleRate,
    length,
    numberOfChannels: channels.length,
    duration: length / sampleRate,
    getChannelData: (channel: number) => channels[channel],
  }
}

export interface Fixture {
  labels: ClipLabels
  audio: AudioLike
}

export interface FixtureLoadResult {
  fixtures: Fixture[]
  /** Clips that exist as labels but can't be scored, with the reason why. */
  skipped: { slug: string; reason: string }[]
}

async function listLabelSlugs(): Promise<string[]> {
  try {
    const entries = await readdir(LABELS_DIR)
    return entries
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort()
  } catch {
    return []
  }
}

export async function loadFixture(slug: string): Promise<Fixture> {
  const raw: unknown = JSON.parse(await readFile(join(LABELS_DIR, `${slug}.json`), 'utf8'))
  const labels = parseClipLabels(raw, `labels/${slug}.json`)
  const decoded = decodeWavFile(await readFile(join(AUDIO_CACHE_DIR, `${slug}.wav`)))
  return { labels, audio: audioFromChannels(decoded.channels, decoded.sampleRate) }
}

export interface LoadOptions {
  /** Skip clips a human hasn't finished reviewing (the default — partial labels score as garbage). */
  requireComplete?: boolean
  /** Restrict to these slugs, if given. */
  only?: string[]
}

export async function loadAllFixtures(options: LoadOptions = {}): Promise<FixtureLoadResult> {
  const { requireComplete = true, only } = options
  const fixtures: Fixture[] = []
  const skipped: { slug: string; reason: string }[] = []

  for (const slug of await listLabelSlugs()) {
    if (only && !only.includes(slug)) continue
    try {
      const fixture = await loadFixture(slug)
      if (requireComplete && !fixture.labels.complete) {
        skipped.push({ slug, reason: 'разметка помечена как незавершённая' })
        continue
      }
      fixtures.push(fixture)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      skipped.push({
        slug,
        reason: reason.includes('ENOENT')
          ? 'нет аудио-кэша (открой клип в /labeler.html и сохрани)'
          : reason,
      })
    }
  }

  return { fixtures, skipped }
}
