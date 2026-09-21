/**
 * Aligning counter moments to audio.
 *
 * Division of labour: **the counter knows HOW MANY shots there were and in which frame; audio
 * knows exactly WHEN**. Video cannot be more precise than a frame in principle — ±33 ms at
 * 30 fps — and sound replacement needs to hit the shot.
 *
 * Worse, on some clips the tracks have simply drifted apart. Checked frame by frame on the
 * `xm1014` clip: the counter changing from 7 to 6 and the muzzle flash sit on the SAME frame
 * (t=1.70), i.e. the video is self-consistent, while the transient in the waveform is 100 ms later.
 *
 * LIMIT OF THE METHOD. The clip-wide offset is reliably determined only with sparse fire. In a
 * burst with a 90-100 ms step the offset is NOT IDENTIFIABLE from audio in principle: both series
 * are periodic with the same period, and a one-shot shift is indistinguishable from the truth. So
 * on dense clips the clip-wide offset usually stays zero, and the per-moment matching does the
 * work — it decides for each moment separately and is not fooled by periodicity.
 *
 * Candidates are the same ones the product's audio stage produced. Labels take no part.
 *
 * Ported from `python/ammo/align.py`.
 */

const MAX_OFFSET_S = 0.3
const OFFSET_STEP_S = 0.005

/** Tolerance at which a moment counts as "explained" by a candidate when fitting the offset. */
const OFFSET_TOLERANCE_S = 0.04

/**
 * Window in which a counter moment counts as CONFIRMED by an audio candidate.
 *
 * 100 ms: the window must cover the desync itself, and that reaches 170 ms. It cannot be wider —
 * candidates are on average 214 ms apart, and a window over half that distance starts reaching
 * the NEIGHBOURING transient.
 *
 * Previously the moment was MOVED into this window. Not any more, see `align`.
 */
const SNAP_WINDOW_S = 0.1

/**
 * Share of moments already hitting a candidate at ZERO offset above which the clip is considered
 * aligned and is not shifted. See the rationale in `estimateOffset`.
 *
 * Tuned by sweep on saved moments (`eval/ammoRealign.ts`): 0.65 gives three clips better and
 * none worse against the variant without the rule.
 */
export const WELL_ALIGNED_RATE = 0.65

export interface Alignment {
  times: number[]
  offset: number
  /**
   * Moments that found their own audio candidate in the window.
   *
   * This is CONFIRMATION, not moving: the number goes into slot selection (`MIN_SNAP_RATE`),
   * because on a real counter decrements land on audio, while on a timer or score they do not.
   */
  snapped: number
  /** Moments for which no candidate was found nearby. */
  kept: number
}

/** How many moments at a given offset fall within tolerance of any candidate. */
function explained(events: number[], candidates: number[], offset: number): number {
  if (!events.length || !candidates.length) return 0
  let hits = 0
  let j = 0
  for (const event of events) {
    const t = event + offset
    while (j + 1 < candidates.length && candidates[j + 1] <= t) j++
    const before = Math.abs(candidates[j] - t)
    const after = j + 1 < candidates.length ? Math.abs(candidates[j + 1] - t) : Infinity
    if (Math.min(before, after) <= OFFSET_TOLERANCE_S) hits++
  }
  return hits
}

/**
 * Clip-wide offset of video against audio.
 *
 * Zero has priority. With a three-shot clip almost any offset explains something, and without
 * this rule alignment would become a coincidence generator.
 */
export function estimateOffset(
  events: number[],
  candidates: number[],
  wellAligned: number = WELL_ALIGNED_RATE,
): number {
  if (events.length < 3 || !candidates.length) return 0

  const base = explained(events, candidates, 0)

  // Do not move what already matches. Measured: without this rule `five_seven` had raw times
  // correct to 17 ms, and the estimator pulled them 210 ms away, dropping the clip from 68% to
  // 37%. Same for `mp5sd` and `sawedoff`.
  //
  // The reverse was measured too: if the offset is never applied, clips whose tracks really did
  // drift are lost — `xm1014` falls from 100% to 20%, `scar20` from 62% to 8%.
  // So the offset is needed, but only where things do not line up without it.
  if (base / events.length >= wellAligned) return 0
  let bestOffset = 0
  let bestHits = base
  for (let offset = -MAX_OFFSET_S; offset <= MAX_OFFSET_S + 1e-9; offset += OFFSET_STEP_S) {
    const hits = explained(events, candidates, offset)
    // Strictly greater, and on a tie — closer to zero: otherwise the choice wanders along a plateau.
    if (hits > bestHits || (hits === bestHits && Math.abs(offset) < Math.abs(bestOffset))) {
      bestOffset = offset
      bestHits = hits
    }
  }

  if (bestHits < base + 2 || bestHits < base * 1.2) return 0
  return bestOffset
}

/**
 * Shift the moments by the clip-wide offset and count how many of them audio confirms.
 *
 * THERE IS NO LONGER ANY MOVING OF A MOMENT ONTO A CANDIDATE, and that is a measurement result,
 * not a simplification. The idea was that the counter knows HOW MANY shots there were and audio
 * knows exactly WHEN. In practice per-shot moving did not refine the moment but shook it: the
 * miss spread grew on 11 clips of 16 (`dual-berettas` 9 -> 27 ms, `m4a4` 16 -> 31, `my-skills`
 * 32 -> 63, `donk-5100` 32 -> 70). The reason is simple: within a 100 ms window there is often a
 * transient unrelated to this shot, and the label drifts to it.
 *
 * Metric on 19 clips with a counter: F1 79.2 -> 80.7, and on sparse ones 63.3 -> 67.6.
 *
 * THE CLIP-WIDE OFFSET STAYS. It is useful and was measured separately: 73.6 without it against
 * 78.4. What hurts is the per-shot pulling, not the desync correction.
 */
export function align(
  events: number[],
  candidates: number[],
  wellAligned: number = WELL_ALIGNED_RATE,
): Alignment {
  if (!events.length) return { times: [], offset: 0, snapped: 0, kept: 0 }

  const ev = [...events].sort((a, b) => a - b)
  const cand = [...candidates].sort((a, b) => a - b)
  const offset = estimateOffset(ev, cand, wellAligned)
  const shifted = ev.map((t) => t + offset)

  if (!cand.length) return { times: shifted, offset, snapped: 0, kept: shifted.length }

  // Matching is strictly one-to-one and order-preserving. Without this two shots of a burst would
  // collapse onto one candidate — exactly the way of losing recall the measurement pipeline
  // warns about.
  const used = new Set<number>()
  const out: number[] = []
  let snapped = 0
  let last = -Infinity

  for (const t of shifted) {
    let pick = -1
    let pickDistance = Infinity
    for (let j = 0; j < cand.length; j++) {
      if (cand[j] < t - SNAP_WINDOW_S) continue
      if (cand[j] > t + SNAP_WINDOW_S) break
      if (used.has(j) || cand[j] <= last) continue
      const d = Math.abs(cand[j] - t)
      if (d < pickDistance) {
        pickDistance = d
        pick = j
      }
    }
    if (pick >= 0) {
      used.add(pick)
      // Order is tracked by the CANDIDATE, not by the label: confirmations must stay one-to-one,
      // otherwise two shots of a burst would be credited to one transient.
      last = cand[pick]
      snapped++
    } else {
      last = Math.max(last, t)
    }
    out.push(t)
  }

  out.sort((a, b) => a - b)
  return { times: out, offset, snapped, kept: out.length - snapped }
}
