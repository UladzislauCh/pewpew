/**
 * Sweep of alignment schemes over saved moments — without a pass over the video.
 *
 * A browser run over forty-five clips takes nine minutes, and tuning rules on it is impossible.
 * But alignment does not depend on frames: it only needs the moments reported by the video
 * (`shotsVideo`) and the audio candidates. Both are already in the run result, so a variant
 * is computed in seconds.
 *
 * The same trick paid off instantly in the Python pipeline: fourteen weighting schemes
 * took seconds instead of an hour.
 *
 *   pnpm exec tsx eval/ammoRealign.ts                    # the current rule
 *   pnpm exec tsx eval/ammoRealign.ts --sweep            # sweep the "already aligned" threshold
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { align } from '../src/domain/detection/ammo/align'
import { scoreDetections } from '../src/domain/detection/detectionMetrics'
import { parseClipLabels } from '../src/domain/detection/labels'
import { PROJECT_ROOT, LABELS_DIR } from './fixtures'

const TOLERANCE_S = 0.05
const SPARSE_MAX_OWN = 20

interface Row {
  slug: string
  covered: boolean
  shotsVideo: number[]
}

async function main(): Promise<void> {
  const rows: Row[] = JSON.parse(await readFile(join(PROJECT_ROOT, 'eval/.cache/ammoBrowser.json'), 'utf8'))
  const candidates: Record<string, { times: number[] }> = JSON.parse(
    await readFile(join(PROJECT_ROOT, 'python/out/audioCandidates.json'), 'utf8'),
  )

  const clips: { slug: string; own: number[]; video: number[]; cand: number[]; sparse: boolean }[] = []
  for (const row of rows) {
    if (!row.covered || !row.shotsVideo?.length) continue
    const raw: unknown = JSON.parse(await readFile(join(LABELS_DIR, `${row.slug}.json`), 'utf8'))
    const labels = parseClipLabels(raw, `labels/${row.slug}.json`)
    if (!labels.complete) continue
    const own = labels.shots.filter((s) => s.source === 'own').map((s) => s.time).sort((a, b) => a - b)
    clips.push({
      slug: row.slug,
      own,
      video: [...row.shotsVideo].sort((a, b) => a - b),
      cand: [...(candidates[row.slug]?.times ?? [])].sort((a, b) => a - b),
      sparse: own.length <= SPARSE_MAX_OWN,
    })
  }

  const evaluate = (wellAligned: number) => {
    let tp = 0
    let fp = 0
    let fn = 0
    let stp = 0
    let sfp = 0
    let sfn = 0
    const perClip: { slug: string; recall: number; offset: number }[] = []
    for (const c of clips) {
      // Production code, not a copy of its own: two implementations of one computation are two truths.
      const { times, offset } = align(c.video, c.cand, wellAligned)
      const s = scoreDetections(c.own, times, TOLERANCE_S, [])
      tp += s.truePositives
      fp += s.falsePositives
      fn += s.falseNegatives
      if (c.sparse) {
        stp += s.truePositives
        sfp += s.falsePositives
        sfn += s.falseNegatives
      }
      perClip.push({
        slug: c.slug,
        recall: s.truePositives + s.falseNegatives ? (100 * s.truePositives) / (s.truePositives + s.falseNegatives) : 0,
        offset,
      })
    }
    const f1 = (a: number, b: number, c: number) => (2 * a + b + c ? (200 * a) / (2 * a + b + c) : 0)
    return {
      recall: tp + fn ? (100 * tp) / (tp + fn) : 0,
      precision: tp + fp ? (100 * tp) / (tp + fp) : 0,
      f1: f1(tp, fp, fn),
      sparseF1: f1(stp, sfp, sfn),
      perClip,
    }
  }

  if (process.argv.includes('--sweep')) {
    console.log('порог «уже выровнен»   полнота  точность    F1   F1 разреж.  сдвинуто клипов')
    for (const w of [0.6, 0.64, 0.66, 0.68, 0.7, 0.72, 0.74, 0.76, 0.78, 0.8]) {
      const r = evaluate(w)
      const shifted = r.perClip.filter((c) => c.offset !== 0).length
      console.log(
        `${w.toFixed(2).padStart(18)}   ${r.recall.toFixed(1).padStart(6)}  ${r.precision.toFixed(1).padStart(7)}  ` +
          `${r.f1.toFixed(1).padStart(5)}  ${r.sparseF1.toFixed(1).padStart(9)}  ${String(shifted).padStart(14)}`,
      )
    }
    return
  }

  const r = evaluate(Number(process.argv[2] ?? 0.6))
  console.log(`полнота ${r.recall.toFixed(1)}  точность ${r.precision.toFixed(1)}  F1 ${r.f1.toFixed(1)}`)
  for (const c of r.perClip.sort((a, b) => a.recall - b.recall)) {
    console.log(`  ${c.slug.slice(0, 40).padEnd(40)} полнота ${c.recall.toFixed(0).padStart(3)}%  сдвиг ${(c.offset * 1000).toFixed(0)}мс`)
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
