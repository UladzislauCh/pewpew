/**
 * Lays out material for checking the production counter reader against the Python one.
 *
 *   pnpm exec tsx eval/audioCandidates.ts     # audio stage candidates
 *   pnpm exec tsx eval/ammoPrep.ts
 *   pnpm dev                         # then /eval/ammoBrowser.html
 *   pnpm exec tsx eval/ammoCompare.ts
 *   pnpm exec tsx eval/ammoPrep.ts --clean
 *
 * Clips are placed as symlinks in `fixtures/__ammo/`, because the browser needs a plain URL,
 * and there is no point copying tens of gigabytes.
 */
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ALL_FORMATS, FilePathSource, Input } from 'mediabunny'
import { FIXTURES_DIR, LABELS_DIR, PROJECT_ROOT } from './fixtures'
import { parseClipLabels } from '../src/domain/detection/labels'

const OUT_DIR = join(FIXTURES_DIR, '__ammo')

export interface AmmoEntry {
  slug: string
  duration: number
  /** Audio stage candidate moments — the same input Python had. */
  candidates: number[]
  /**
   * Network confidence on each candidate. Needed by label selection: when one flash went to
   * two neighbours, it is the sound that settles the dispute, not the flash brightness.
   */
  confidence: number[]
}

async function main(): Promise<void> {
  if (process.argv.includes('--clean')) {
    await rm(OUT_DIR, { recursive: true, force: true })
    console.log('fixtures/__ammo убран')
    return
  }

  const candidatesPath = join(PROJECT_ROOT, 'python/out/audioCandidates.json')
  if (!existsSync(candidatesPath)) {
    console.error('Нет python/out/audioCandidates.json — сначала: pnpm exec tsx eval/audioCandidates.ts')
    process.exit(1)
  }
  const candidates: Record<string, { times: number[]; confidence?: number[] }> = JSON.parse(
    await readFile(candidatesPath, 'utf8'),
  )

  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(OUT_DIR, { recursive: true })

  const entries: AmmoEntry[] = []
  for (const name of (await readdir(LABELS_DIR)).filter((n: string) => n.endsWith('.json')).sort()) {
    const labels = parseClipLabels(JSON.parse(await readFile(join(LABELS_DIR, name), 'utf8')), name)
    if (!labels.complete) continue
    const source = join(PROJECT_ROOT, 'examples', labels.clip)
    if (!existsSync(source)) continue

    const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(source) })
    let duration = 0
    try {
      duration = await input.computeDuration()
    } finally {
      input.dispose()
    }

    await symlink(source, join(OUT_DIR, `${labels.slug}.mp4`))
    entries.push({
      slug: labels.slug,
      duration,
      candidates: candidates[labels.slug]?.times ?? [],
      confidence: candidates[labels.slug]?.confidence ?? [],
    })
  }

  await writeFile(join(OUT_DIR, 'manifest.json'), JSON.stringify({ entries }, null, 2))
  console.log(`клипов ${entries.length}`)
  console.log('Запустить dev-сервер и открыть /eval/ammoBrowser.html')
}

void main()
