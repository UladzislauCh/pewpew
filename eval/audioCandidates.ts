/**
 * Audio candidates of the production stage for each clip — for Python.
 *
 * The ammo counter knows HOW MANY shots and in which frame, but does not know the moment more
 * precisely than a frame: at 30 fps that is ±33 ms, at best. Worse, in some clips sound and video
 * drifted apart by 100-170 ms (checked on frames: in xm1014 the counter and the muzzle flash are
 * on the same frame, while the transient in the waveform is 100 ms later).
 *
 * The sound knows the exact moment. So Python does not compute the sound itself — that would be
 * a second truth — but gets candidates FROM HERE, from the same ShotNet and with the same threshold
 * the product uses.
 *
 *   pnpm exec tsx eval/audioCandidates.ts
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { toMono } from '../src/domain/audio/audioTypes'
import { detectShotsWithNet } from '../src/domain/detection/shotNet/detectShotsWithNet'
import { deserializeWeights } from '../src/domain/detection/shotNet/shotNet'
import { MOTION_PARAMS } from '../src/domain/detection/motion/motionFeatures'
import { loadAllFixtures, PROJECT_ROOT } from './fixtures'

async function main(): Promise<void> {
  const out = join(PROJECT_ROOT, 'python/out/audioCandidates.json')
  const weights = deserializeWeights(await readFile(join(PROJECT_ROOT, 'public/models/shotNet.json'), 'utf8'))
  const { fixtures, skipped } = await loadAllFixtures()

  const table: Record<string, { times: number[]; confidence: number[] }> = {}
  for (const fixture of fixtures) {
    const candidates = detectShotsWithNet(toMono(fixture.audio), fixture.audio.sampleRate, weights, {
      threshold: MOTION_PARAMS.candidateThreshold,
    })
    table[fixture.labels.slug] = {
      times: candidates.map((c) => Number(c.time.toFixed(4))),
      confidence: candidates.map((c) => Number(c.confidence.toFixed(3))),
    }
  }

  await mkdir(join(PROJECT_ROOT, 'python/out'), { recursive: true })
  await writeFile(out, JSON.stringify(table), 'utf8')

  const total = Object.values(table).reduce((a, t) => a + t.times.length, 0)
  console.log(`клипов ${Object.keys(table).length}, кандидатов ${total}, пропущено ${skipped.length}`)
  console.log(`-> ${out}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
