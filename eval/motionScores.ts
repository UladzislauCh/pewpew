/**
 * Score of the SHIPPED motion model for every audio candidate.
 *
 * Needed for exactly one thing: to compare the production second stage with the Python field
 * reading ON THE SAME MATERIAL — the same clips, the same candidates, the same per-frame counter
 * labels. The journal's numbers (AUC 0.910) do not fit: there it is 49 clips, manual labels
 * and a different candidate pool.
 *
 *   pnpm exec tsx eval/ammoPrep.ts        # if there is no fixtures/__ammo
 *   pnpm dev                     # then /eval/motionScores.html
 *
 * The comparison is GENEROUS TO THE PRODUCT: the motion model weights are trained on all clips
 * with no held-out set, i.e. on these sixteen too, whereas the Python model is validated with
 * folds by clip. If Python still wins, the win is real.
 *
 * The ammo counter is off on purpose (`ammo: false`): the second stage is measured, not the counter.
 */
import { detectShotsNet } from '../src/domain/detection/shotNet/adapter'
import { MOTION_PARAMS } from '../src/domain/detection/motion/motionFeatures'
import { onMotionTrace, scoreShotsByMotion, type MotionTrace } from '../src/domain/detection/motion/detectWithMotion'
import { saveResult } from './saveResult'

interface Entry {
  slug: string
  duration: number
  candidates: number[]
}

const out = document.getElementById('out') as HTMLPreElement
const log = (line: string): void => {
  out.textContent += line + '\n'
  window.scrollTo(0, document.body.scrollHeight)
}

async function main(): Promise<void> {
  const manifest = await fetch('/__ammo/manifest.json').then((r) => (r.ok ? r.json() : null))
  if (!manifest) {
    log('нет /__ammo/manifest.json — сначала pnpm exec tsx eval/ammoPrep.ts')
    return
  }
  const params = new URLSearchParams(window.location.search)
  // ?only=substring — a single clip; ?limit=N — the first N.
  const only = params.get('only')
  const limit = Number(params.get('limit') ?? 0)
  const all: Entry[] = manifest.entries
  const picked = only ? all.filter((e) => e.slug.includes(only)) : all
  const entries = limit > 0 ? picked.slice(0, limit) : picked

  // The sample rate is set explicitly: without it AudioContext uses the sound card's rate, decodeAudioData
  // resamples, and the network sees different samples. Labels and cache were made at 44100.
  const ctx = new AudioContext({ sampleRate: 44100 })
  log(`клипов ${entries.length}, частота звука ${ctx.sampleRate}`)
  log('')

  const rows: {
    slug: string
    fps: number
    scores: { time: number; audio: number; score: number }[]
    field: Record<string, number[]> | null
  }[] = []
  for (const [i, entry] of entries.entries()) {
    const started = performance.now()
    const captured: MotionTrace[] = []
    onMotionTrace((t) => captured.push(t))
    try {
      const file = await fetch(`/__ammo/${entry.slug}.mp4`).then((r) => r.blob())
      const audio = await ctx.decodeAudioData(await file.arrayBuffer())
      // The same adapter and threshold as the wizard: candidates come with real confidence,
      // which for the production model is also a feature.
      const { shots } = await detectShotsNet(audio, { threshold: MOTION_PARAMS.candidateThreshold })
      await scoreShotsByMotion(file, shots, entry.duration, { ammo: false, field: true })
      const trace = captured.length ? captured[captured.length - 1] : null
      rows.push({
        slug: entry.slug,
        // VIDEO TRACK frame rate, computed as in prod: field features are indexed by frames,
        // and the candidate's frame is taken from here.
        fps: trace ? trace.weaponFps : 0,
        scores: trace ? trace.scores : [],
        field: trace ? trace.field : null,
      })
      log(
        `${String(i + 1).padStart(2)}/${entries.length} ${entry.slug.slice(0, 40).padEnd(42)} ` +
          `кандидатов ${String(shots.length).padStart(3)} · оценок ${String(trace?.scores.length ?? 0).padStart(3)} ` +
          `· поле ${String(trace?.field ? trace.field.diff.length : 0).padStart(4)} ` +
          `· ${((performance.now() - started) / 1000).toFixed(1)} с`,
      )
    } catch (error) {
      log(`${String(i + 1).padStart(2)}/${entries.length} ${entry.slug.slice(0, 40).padEnd(42)} ОШИБКА: ${error instanceof Error ? error.message : String(error)}`)
      rows.push({ slug: entry.slug, fps: 0, scores: [], field: null })
    }
    // Written after each clip: the run is long, and an interruption must not cost everything.
    await saveResult('motionScores.json', JSON.stringify(rows), 'application/json')
  }
  log('')
  log(`готово, ${rows.length} клипов в eval/.cache/motionScores.json`)
}

void main()
