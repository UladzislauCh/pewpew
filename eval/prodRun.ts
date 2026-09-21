/**
 * A run of the whole PRODUCTION path: sound by the network, then the second stage from `src/domain/detection/motion/`.
 *
 * Imitates nothing — calls exactly the functions the wizard calls, with the same weights from
 * `public/models/`. Three things are checked:
 *
 *  1. that the new scheme is selected at all (rather than silently falling back to the variability band);
 *  2. that the labels match what the eval pipeline predicted;
 *  3. what it costs in time — there is now one pass over the video instead of two.
 *
 * The motion model weights are trained on all clips with no held-out set, so F1 from here is
 * inflated exactly as in `pnpm eval`. It must be compared not with 62.3 (honest validation with
 * folds) but with 64.3 — the shipped scheme's number, taken the same way.
 */
import { detectShotsNet } from '../src/domain/detection/shotNet/adapter'
import { MOTION_PARAMS } from '../src/domain/detection/motion/motionFeatures'
import { scoreShotsByMotion } from '../src/domain/detection/motion/detectWithMotion'
import { onRegionPicked } from '../src/domain/detection/motion/blockMotion'
import { onMotionTrace, type MotionTrace } from '../src/domain/detection/motion/detectWithMotion'
import { saveResult } from './saveResult'
import { scoreDetections } from '../src/domain/detection/detectionMetrics'

interface Entry {
  slug: string
  duration: number
  ownShots: number[]
  candidates: { time: number; confidence: number }[]
}

const THRESHOLD = 0.5

const log = (line: string): void => {
  const out = document.getElementById('out')
  if (out) out.textContent += line + '\n'
  window.scrollTo(0, document.body.scrollHeight)
}

async function main(): Promise<void> {
  const r = await fetch('/__weighted/manifest.json')
  if (!r.ok) {
    log('нет /__weighted/manifest.json — сначала pnpm exec tsx eval/weightedPrep.ts')
    return
  }
  const { entries } = (await r.json()) as { entries: Entry[] }
  const params = new URLSearchParams(location.search)
  const dumpSlug = params.get('dump')
  const limit = Number(params.get('limit') ?? entries.length)
  const wanted = dumpSlug ? entries.filter((e) => e.slug === dumpSlug) : entries.slice(0, limit)
  let trace: MotionTrace | null = null
  if (dumpSlug) onMotionTrace((t) => { trace = t })

  // The sample rate is set explicitly. Without it AudioContext uses the sound card's rate (48000 here),
  // decodeAudioData resamples to it, and the network sees different samples: over the whole set
  // 4518 candidates versus 4808. Labels and cache were made at 44100.
  const rate = Number(new URLSearchParams(location.search).get('rate') ?? 44100)
  const ctx = new AudioContext({ sampleRate: rate })

  log(`клипов ${wanted.length}, порог движения ${THRESHOLD}, частота звука ${ctx.sampleRate}`)
  log('')
  let tp = 0
  let fp = 0
  let fn = 0
  let seconds = 0
  let videoSeconds = 0

  for (let i = 0; i < wanted.length; i++) {
    const e = wanted[i]
    try {
      const blob = await (await fetch(`/__weighted/${e.slug}.mp4`)).blob()
      const audio = await ctx.decodeAudioData(await blob.arrayBuffer())
      // The same adapter and threshold as the wizard: the whole prod path.
      const { shots } = await detectShotsNet(audio, { threshold: MOTION_PARAMS.candidateThreshold })

      let picked: number[] = []
      onRegionPicked((blocks) => { picked = blocks })
      const t0 = performance.now()
      const scored = await scoreShotsByMotion(blob, shots, e.duration)
      const secs = (performance.now() - t0) / 1000
      seconds += secs
      videoSeconds += e.duration

      const marks = scored.filter((s) => s.motionScore >= THRESHOLD).map((s) => s.time).sort((a, b) => a - b)
      const score = scoreDetections(e.ownShots, marks, 0.05)
      tp += score.truePositives
      fp += score.falsePositives
      fn += score.falseNegatives

      log(
        `${String(i + 1).padStart(2)}/${wanted.length} ${e.slug.slice(0, 34).padEnd(36)} ` +
          `кандидатов ${String(shots.length).padStart(3)} → меток ${String(marks.length).padStart(3)} ` +
          `· своих ${String(e.ownShots.length).padStart(3)} · F1 ${(100 * score.f1).toFixed(1).padStart(5)} ` +
          `· ${secs.toFixed(1)} с (${(secs / e.duration).toFixed(2)}x) · блоки [${picked.slice().sort((a, b) => a - b).join(' ')}]`,
      )
    } catch (error) {
      log(`${String(i + 1).padStart(2)}/${wanted.length} ${e.slug.slice(0, 34).padEnd(36)} ОШИБКА: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (dumpSlug && trace) {
    log(await saveResult('prodTrace.json', JSON.stringify({ slug: dumpSlug, trace }), 'application/json'))
  }

  const p = tp / Math.max(1, tp + fp)
  const rc = tp / Math.max(1, tp + fn)
  log('')
  log(`ИТОГО  TP ${tp} · FP ${fp} · FN ${fn}`)
  log(`       точность ${(100 * p).toFixed(1)}% · полнота ${(100 * rc).toFixed(1)}% · F1 ${(100 * ((2 * p * rc) / Math.max(1e-9, p + rc))).toFixed(1)}%`)
  log(`       вторая ступень: ${seconds.toFixed(1)} с на ${videoSeconds.toFixed(0)} с видео = ${(seconds / videoSeconds).toFixed(2)}x реального времени`)
  log('')
  log('Отгруженная схема тем же способом даёт F1 64.3 при 0.46x (два прохода по видео).')
}

void main()
