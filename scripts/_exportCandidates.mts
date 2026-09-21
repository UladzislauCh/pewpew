/**
 * Throwaway: export detector candidates (pre self-similarity) for an external zero-shot scorer.
 * Writes eval/.candidates.json — times + kind labels, no audio (Python reads examples/.cache).
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadAllFixtures, PROJECT_ROOT } from '../eval/fixtures'
import { TOLERANCES } from '../eval/evaluate'
import { matchEvents } from '../src/domain/detection/detectionMetrics'
import { computeOnsetCurve } from '../src/domain/detection/onsetDetection'
import { detectShots } from '../src/domain/detection/shotDetection'

const { fixtures } = await loadAllFixtures()

const clips = fixtures.map((fixture) => {
  // High-recall candidate pool: same pipeline, but without the self-similarity gate that already
  // trades recall for precision — the neural scorer is meant to replace or beat that trade-off.
  const predicted = detectShots(fixture.audio, computeOnsetCurve(fixture.audio), {
    selfSimilarityThreshold: 0,
  }).map((shot) => shot.time)

  const targets = fixture.labels.shots.filter((s) => s.source === 'own')
  const enemies = fixture.labels.shots.filter((s) => s.source !== 'own')
  const match = matchEvents(
    targets.map((s) => s.time),
    predicted,
    TOLERANCES.loose,
  )
  const hitPred = new Set(match.matches.map((m) => m.predictedIndex))

  const candidates = predicted.map((time, index) => {
    let kind: 'own' | 'enemy' | 'fp' = 'fp'
    let weapon: string | null = null
    if (hitPred.has(index)) {
      kind = 'own'
      const ref = match.matches.find((m) => m.predictedIndex === index)!
      weapon = targets[ref.referenceIndex].weapon ?? null
    } else {
      const enemy = enemies.find((e) => Math.abs(e.time - time) <= TOLERANCES.loose)
      if (enemy) {
        kind = 'enemy'
        weapon = enemy.weapon ?? null
      }
    }
    return { time, kind, weapon }
  })

  return {
    slug: fixture.labels.slug,
    clip: fixture.labels.clip,
    sampleRate: fixture.audio.sampleRate,
    cacheWav: join(PROJECT_ROOT, 'examples/.cache', `${fixture.labels.slug}.wav`),
    targets: targets.map((s) => ({ time: s.time, weapon: s.weapon ?? null, hard: s.hard })),
    enemies: enemies.map((s) => ({ time: s.time, weapon: s.weapon ?? null })),
    candidates,
  }
})

const outPath = join(PROJECT_ROOT, 'eval/.candidates.json')
writeFileSync(
  outPath,
  JSON.stringify(
    {
      note: 'Candidates from detectShots with selfSimilarityThreshold=0. For YAMNet zero-shot experiment.',
      clips,
    },
    null,
    2,
  ),
)

const totals = { own: 0, enemy: 0, fp: 0 }
for (const clip of clips) for (const c of clip.candidates) totals[c.kind]++
console.log(`wrote ${outPath}`)
console.log(`clips=${clips.length} candidates own=${totals.own} enemy=${totals.enemy} fp=${totals.fp}`)
