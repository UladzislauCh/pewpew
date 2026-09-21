/**
 * Aligning labels to audio.
 *
 * THE FIRE-RATE GRID FILL USED TO LIVE HERE (`fillRhythm.ts`). It filled gaps inside a burst and
 * extended its boundaries outward, and by the metric of the time it looked like a big win. It was
 * removed after listening: on pistols it turned separate shots into a continuous burst. Analysis
 * and numbers are in `eval/README.md`, in the section on removing the rhythm fill.
 *
 * There is a second reason not to bring it back: the metric it was winning on turned out to be
 * wrong. Recomputing on the corrected one (`eval/eventScore.ts`) showed that people do not hear
 * burst boundaries at all, and those are exactly what the fill was fixing.
 */
import type { DetectedShot } from '../shotDetection'

/**
 * Onset search window for alignment, seconds.
 *
 * 100 ms by measurement: at 50 ms a correction is found less often, at 150 nothing changes any
 * more. Wider is dangerous — it starts latching onto the neighbouring shot of a burst, and those
 * come 70-150 ms apart.
 */
const ALIGN_WINDOW_S = 0.1
/** Below this number of matches no correction is computed: a median of two points is not a median. */
const ALIGN_MIN_HITS = 3

/**
 * Shift ALL labels of a clip by one correction — to where the shot is heard.
 *
 * WHY. We replace the sound, so the label must sit where a person hears the bang, not where the
 * flash is seen. These are different moments for two reasons: a video label is quantised to a
 * frame (33 ms at 30 fps), and in re-edited clips the tracks can drift apart — on `deagle` the
 * picture leads the audio by about 130 ms.
 *
 * THE SHIFT IS RIGID, AND THAT IS THE KEY POINT. Pulling each label to its own onset separately
 * was measured and is WORSE than the original (F1 65.7 against 73.0): inside a burst labels come
 * 100 ms apart, candidates are denser, neighbouring labels land on one onset and merge.
 * A rigid shift preserves the distances and aligns only the whole.
 *
 * PER CLIP, NOT PER BURST. Desync is a property of the file, not of a single burst. A per-burst
 * shift gave slightly higher recall (65.4 against 64.6) but lower precision (86.7 against 87.4):
 * it lets itself be fitted to a random onset.
 *
 * Measured by events: F1 73.0 -> 74.3, precision 86.3 -> 87.4.
 */
export function alignToAudio(
  shots: readonly DetectedShot[],
  heard: readonly { time: number }[] | undefined,
  window = ALIGN_WINDOW_S,
): DetectedShot[] {
  if (!heard?.length || shots.length === 0) return [...shots]
  const offsets: number[] = []
  for (const s of shots) {
    let best = Infinity
    for (const h of heard) {
      const d = h.time - s.time
      if (Math.abs(d) <= window && Math.abs(d) < Math.abs(best)) best = d
    }
    if (best !== Infinity) offsets.push(best)
  }
  if (offsets.length < ALIGN_MIN_HITS) return [...shots]
  offsets.sort((a, b) => a - b)
  const shift = offsets[Math.floor(offsets.length / 2)]
  if (!shift) return [...shots]
  return shots.map((s) => ({ ...s, time: Math.max(0, s.time + shift) }))
}
