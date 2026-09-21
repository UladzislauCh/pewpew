/**
 * Waiting-bar readings: what percentage to draw and how many seconds to promise.
 *
 * WHY BY TIME, NOT BY FRAMES. The real analysis progress is known only to the video stage,
 * which reports a frame number — but it's preceded by the audio stage and followed by
 * marker placement, and their shares of the total vary from clip to clip. A time-based
 * estimate is wrong exactly where the formula is wrong, and not at all when it guesses right.
 *
 * THE WAIT FORMULA. Analysis costs about 0.6 of the clip length at 30 frames per second
 * and 1.1 at sixty: twice the frames, and the model processes each one.
 *
 * WHY THE BAR STOPS. It follows the estimate exactly and HALTS at 97%: the estimate can be
 * off in either direction, and a bar stuck at 100% while analysis is still running lies
 * worse than any undershoot. A halted bar is more honest than a creeping one: it says
 * “waiting for the end”, not “any moment now”.
 *
 * THE REMAINDER ALWAYS RUNS OUT IN HALF A SECOND — from any fraction, 20% or 97%.
 * Analysis often finishes ahead of the estimate, and the remainder used to be skipped
 * instantly: the bar jumped from an unfinished percentage to a hundred in one frame. The eye
 * reads half a second as completion rather than a jolt, and it's short enough not to wait on.
 *
 * SECONDS ARE A FUNCTION OF THE PERCENTAGE, not a separate counter. Otherwise they live their
 * own life: the bar sits at 96% while the promise runs to zero, or the other way round — the
 * bar is full while “~18 s left” hangs. One quantity, two ways of showing it.
 */

/** Analysis time as a fraction of clip length. Measured: 0.577x at 30 fps. */
const COST_30 = 0.6
/** At 60 fps there are twice the frames, and the model processes each one. */
const COST_60 = 1.1
/** Frame rate above which a clip counts as 60 fps. */
const HIGH_FPS = 45

/** Where the bar halts and waits for the work to finish. */
export const CREEP_CEILING = 0.97
/** How long the remainder takes to run out once work has finished. */
export const FINISH_MS = 500

/**
 * How long to hold at a hundred percent before moving to the next screen.
 *
 * Without the hold, the transition happens in the same tick as the bar's last value:
 * React doesn't get to render 100% and “0 s”, and the person sees the screen leave
 * at 96%. Observed right here — that's exactly how it left.
 *
 * Half a second, not a quarter: at a hundred percent the last phase begins, “putting the
 * sound on the shots”, and at 250 ms it merely blinked. The replacement itself takes about
 * as long — by then the sound is decoded, only splicing remains.
 */
export const HOLD_MS = 500

/** How many seconds analysis will take for a clip of this length and frame rate. */
export function estimateAnalysisSeconds(durationSec: number, frameRate: number | null): number {
  const cost = frameRate !== null && frameRate > HIGH_FPS ? COST_60 : COST_30
  return Math.max(1, durationSec * cost)
}

export interface ProgressInput {
  /** How many milliseconds analysis has been running. */
  elapsedMs: number
  /** How long it's estimated to take. */
  estimateMs: number
  /**
   * When the work finished, on the same time scale. `null` — still running.
   *
   * The exact moment is needed: the remainder's run-out is computed from it, not from the
   * current frame, otherwise the bar will jerk on dropped render frames.
   */
  doneAtMs: number | null
  /** The fraction the bar was at when completion was recorded. */
  doneAtValue: number
}

/** Bar fraction, 0..1. */
export function progressAt({ elapsedMs, estimateMs, doneAtMs, doneAtValue }: ProgressInput): number {
  if (doneAtMs !== null) {
    const after = Math.max(0, elapsedMs - doneAtMs)
    const k = Math.min(1, after / FINISH_MS)
    return Math.min(1, doneAtValue + (1 - doneAtValue) * k)
  }
  // No estimate yet — the clip is being read, duration unknown. The bar stays at zero:
  // it used to substitute one here, so the bar started straight at 90% and then
  // rolled back once the estimate appeared.
  if (estimateMs <= 0) return 0
  // Exactly per the estimate — then stop at the ceiling. No slow-down before it, on purpose:
  // it said nothing but “the estimate is running out”, and a halted bar says that more clearly.
  return Math.min(CREEP_CEILING, elapsedMs / estimateMs)
}

/**
 * How many more seconds to promise — BY BAR FRACTION, not by the clock.
 *
 * That gives three properties at once: while the bar sits at 97%, so does the promise; when
 * work ends and the remainder runs out in half a second, the promise reaches zero in that same
 * half second, whatever the estimate still had left; and zero is shown only
 * at a hundred percent.
 */
export function remainingSeconds(percent: number, estimateMs: number): number {
  // Floating-point tolerance: 30000 * 0.3 gives 9000.000000000002,
  // and rounding up showed ten seconds instead of nine.
  const left = Math.ceil((estimateMs * (1 - percent)) / 1000 - 1e-6)
  if (percent >= 1) return 0
  return Math.max(1, left)
}
