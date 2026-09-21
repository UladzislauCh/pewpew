/**
 * Flash stage thresholds — in a separate file WITHOUT browser dependencies.
 *
 * The reason is not purity: `scoreShotsByFlash.ts` pulls in `onnxruntime-web`, `Worker` and
 * `CanvasImageSource`, i.e. the whole DOM. Measurements (`eval/flashDiagnose.ts`,
 * `eval/flashCompare.ts`) run in Node, where there is no DOM, and importing the threshold from
 * there broke `tsc -b` out of nowhere — while `tsc --noEmit` and the tests passed.
 */

/**
 * The threshold at which a candidate counts as confirmed.
 *
 * Measured on the corpus: the F1 curve is flat between 0.3 and 0.5, i.e. the choice is stable
 * rather than fitted to a single point.
 */
export const DEFAULT_FLASH_THRESHOLD = 0.4
