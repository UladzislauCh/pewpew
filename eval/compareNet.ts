/**
 * Spectral flow versus ShotNet on the committed ground truth.
 *
 *   pnpm exec tsx eval/compareNet.ts
 *
 * The wizard now places marks with the convolutional detector instead of spectral flow. That is a
 * change to the product's core output, so it needs the same before/after that any detection change
 * gets — not just "it compiles and the page loads".
 *
 * The two detectors are not interchangeable at a fixed threshold: spectral flow answers "energy
 * changed here" and the net answers "a shot is here", so their score scales mean different things.
 * The net is therefore swept across thresholds and reported at several points, which also shows
 * what the editor's confidence slider will be moving through.
 *
 * Weights are read from disk rather than fetched: the browser adapter goes through HTTP, but the
 * detector itself is a pure function and can be measured offline.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDefaultDetector, evaluateAll, type Detector } from './evaluate'
import { loadAllFixtures, PROJECT_ROOT } from './fixtures'
import { toMono } from '../src/domain/audio/audioTypes'
import { detectShotsWithNet } from '../src/domain/detection/shotNet/detectShotsWithNet'
import { deserializeWeights } from '../src/domain/detection/shotNet/shotNet'

const WEIGHTS_PATH = join(PROJECT_ROOT, 'public/models/shotNet.json')
const THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]

function fmt(value: number): string {
  return (value * 100).toFixed(1).padStart(6)
}

async function main(): Promise<void> {
  const { fixtures, skipped } = await loadAllFixtures()
  if (!fixtures.length) {
    console.error('Нет клипов с готовой разметкой — сравнивать не на чем.')
    process.exit(1)
  }

  const weights = deserializeWeights(await readFile(WEIGHTS_PATH, 'utf8'))

  const baseline = evaluateAll(fixtures, createDefaultDetector())
  console.log(`клипов ${fixtures.length}${skipped.length ? `, пропущено ${skipped.length}` : ''}`)
  console.log()
  console.log('детектор'.padEnd(26), 'F1'.padStart(7), 'точность'.padStart(9), 'полнота'.padStart(8), 'меток'.padStart(7))
  console.log('-'.repeat(62))
  console.log(
    'спектральный поток'.padEnd(26),
    fmt(baseline.aggregate.f1),
    fmt(baseline.aggregate.precision),
    fmt(baseline.aggregate.recall),
    String(baseline.clips.reduce((a, c) => a + c.predictedCount, 0)).padStart(7),
  )

  for (const threshold of THRESHOLDS) {
    const detect: Detector = (audio) =>
      detectShotsWithNet(toMono(audio), audio.sampleRate, weights, { threshold }).map((s) => s.time)
    const result = evaluateAll(fixtures, detect)
    console.log(
      `сеть, порог ${threshold.toFixed(1)}`.padEnd(26),
      fmt(result.aggregate.f1),
      fmt(result.aggregate.precision),
      fmt(result.aggregate.recall),
      String(result.clips.reduce((a, c) => a + c.predictedCount, 0)).padStart(7),
    )
  }

  console.log()
  console.log('Проценты. «Меток» — сколько всего поставил детектор: это и есть объём ручной проверки.')
}

void main()
