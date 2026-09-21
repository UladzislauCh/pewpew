/**
 * Rejection text by reason code — the only place where store codes turn into words.
 *
 * WHY SEPARATE FROM THE SCREEN. The store holds a code, not text: translations drag in
 * i18n and `document`, and slices must run in Node with their tests. So a bridge has to
 * live somewhere, and it used to be two `useMemo`s right inside `WizardApp`.
 * The bridge is case analysis, not markup: it should be covered by a test, not eyeballed
 * in a browser. Hence the move to `model/`.
 *
 * LANGUAGE. Both functions read the translation at call time, so the caller must
 * recompute them on a language change — otherwise an error already on screen stays in
 * the old language while everything around it has switched.
 */
import i18n from '../../../shared/i18n'
import { getMediaLimitCopy } from './mediaLimits'
import type { ProjectProblem } from '../store/projectSlice'
import type { ReplacementProblem } from '../store/replacementSlice'

/**
 * Why the clip was rejected.
 *
 * Each code gets its own text. Everything except duration used to fall into a generic
 * “couldn't process”, so someone with a renamed archive read about an analysis failure,
 * and someone with a 4K clip read the same, even though the exact reason was known.
 */
export function videoProblemText(problem: ProjectProblem): string {
  const copy = getMediaLimitCopy()
  switch (problem) {
    case 'type':
      return copy.video.typeError
    case 'size':
      return copy.video.sizeError
    case 'duration':
      return copy.video.durationError
    case 'tooLarge':
      return copy.video.tooHeavyError
    // The clip's audio, not the replacement sound: same limit, same text.
    case 'audioTooHeavy':
      return copy.audio.tooHeavyError
    case 'noAudio':
      return i18n.t('wizard.errors.noAudioTrack')
    case 'analysis':
      return i18n.t('wizard.errors.analysisFailed')
  }
}

/** Why the replacement sound was rejected. */
export function replacementProblemText(problem: ReplacementProblem): string {
  const copy = getMediaLimitCopy().audio
  switch (problem) {
    case 'duration':
      return copy.durationError
    case 'layout':
      return copy.tooHeavyError
    case 'decode':
      return i18n.t('wizard.errors.decodeFailed')
  }
}
