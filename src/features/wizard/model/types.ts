export type WizardStep = 'upload' | 'edit-shots' | 'add-sound' | 'preview'

/** Minimum busy-overlay time when moving between wizard screens (work may run longer). */
export const MIN_SCREEN_BUSY_MS = 700

/**
 * Step order. Identifiers only: labels live in the translations
 * (`wizard.steps.*`). A second copy of the names here was dead — it still said
 * “Markers”, and after the step was renamed to “Check” it would have drifted from the step bar.
 */
export const WIZARD_STEPS: readonly WizardStep[] = [
  'upload',
  'edit-shots',
  'add-sound',
  'preview',
] as const

export function stepIndex(step: WizardStep): number {
  return WIZARD_STEPS.indexOf(step)
}
