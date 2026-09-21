/** Fixed silence trim for replacement clips — lead/trail dead air, not user-tunable. */
export const DEFAULT_SILENCE_THRESHOLD_RATIO = 0.2

/**
 * After the replacement clip finishes, original video audio fades in from 0%→100% for
 * `max(0, POST_DUCK_BUDGET_SECONDS − clipLength)` seconds. Clips ≥ 2s skip the fade.
 */
export const POST_DUCK_BUDGET_SECONDS = 2

/**
 * How much EARLIER than the found moment the sound is placed, in seconds.
 *
 * Verified by ear on clips with objectively the best detection (`m4a4` 95/95, `ak47` 90/90,
 * `xm1014` 100/100): without this shift, you hear the START of the real shot, and only then
 * the replacement bang. A hundred milliseconds is what the user confirmed as sounding right.
 *
 * The SPLICE shifts, not the label, and that matters for three reasons. The label on the
 * timeline stays on the shot, not drifting off it. The detection metric stays directly
 * readable: shifting labels by 100 ms dropped it from F1 80.7 to 58.2 by construction. And
 * the muting of the original sound travels with the splice — and it's that muting which hides
 * the start of the shot.
 */
export const REPLACEMENT_LEAD_SECONDS = 0.1
