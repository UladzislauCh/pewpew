/**
 * Dense ShotNet series over spectrogram frames — the input of the Python temporal model.
 *
 * Candidates (`python/out/audioCandidates.json`) do not fit it: they are already a DECISION,
 * peaks after selection. A temporal model must see the series itself, including the places where
 * the network hesitated — that is where the shots merged in bursts lie, because of which recall
 * hits a ceiling of 85.5%.
 *
 * Computed by PRODUCTION code with production weights. Python knows nothing about the network and
 * must not: two implementations of one thing are two truths, and the project has paid for that before.
 *
 *   npx tsx eval/audioCurve.ts
 *
 * Series rate — 44100/512 ≈ 86.13 frames per second, i.e. 11.6 ms per sample. That is three times
 * finer than a video frame and noticeably finer than the metric's 50 ms tolerance: moments can be
 * placed more precisely than video allows.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadAllFixtures, PROJECT_ROOT } from './fixtures'
import { toMono } from '../src/domain/audio/audioTypes'
import { deserializeWeights, predict } from '../src/domain/detection/shotNet/shotNet'
import {
  computeMelSpectrogram,
  DEFAULT_MEL_OPTIONS,
  normalizePerBand,
} from '../src/domain/detection/shotNet/melSpectrogram'

async function main(): Promise<void> {
  const { fixtures } = await loadAllFixtures()
  const weights = deserializeWeights(
    await readFile(join(PROJECT_ROOT, 'public/models/shotNet.json'), 'utf8'),
  )

  const out = join(PROJECT_ROOT, 'python/out/audioCurve')
  await mkdir(out, { recursive: true })
  const index: Record<string, { frames: number; frameRate: number }> = {}

  for (const f of fixtures) {
    const spec = computeMelSpectrogram(toMono(f.audio), f.audio.sampleRate, DEFAULT_MEL_OPTIONS)
    if (spec.frames === 0) continue
    // Normalisation must match training, otherwise the weights are meaningless.
    normalizePerBand(spec)
    const prob = predict(weights, spec)
    // Raw float32 next to an index: JSON over 900 frames in 45 clips bloats for nothing.
    await writeFile(join(out, `${f.labels.slug}.f32`), Buffer.from(new Float32Array(prob).buffer))
    index[f.labels.slug] = { frames: prob.length, frameRate: spec.frameRate }
    console.log(`  ${f.labels.slug.slice(0, 44).padEnd(46)} кадров ${prob.length}, ${spec.frameRate.toFixed(2)} к/с`)
  }

  await writeFile(join(out, 'index.json'), JSON.stringify(index, null, 1))
  console.log(`\nрядов ${Object.keys(index).length}, выгружено в ${out}`)
  // The directory may be left over from a previous run with a different set of clips.
  const stale = (await readdir(out)).filter(
    (n) => n.endsWith('.f32') && !index[n.slice(0, -4)],
  )
  if (stale.length) console.log(`ВНИМАНИЕ: лишние файлы от прошлого прогона: ${stale.join(', ')}`)
}

void main()
