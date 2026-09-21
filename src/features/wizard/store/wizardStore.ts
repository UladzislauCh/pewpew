/**
 * The wizard store, assembled from slices.
 *
 * A slice is a piece of state together with its actions: markers, replacement sound, export
 * and so on. Split into slices rather than one flat object because the state in `WizardApp`
 * already falls into five disjoint groups, and each moves over separately —
 * the app has to keep working after every step of the migration.
 *
 * For now there's one slice here. The next ones are added here with one line each.
 */
import { create } from 'zustand'
import { createDetectionSlice, type DetectionState } from './detectionSlice'
import { createExportSlice, type ExportState } from './exportSlice'
import { createProjectSlice, type ProjectState } from './projectSlice'
import { createReplacementSlice, type ReplacementState } from './replacementSlice'
import { createShotsSlice, type ShotsSlice } from './shotsSlice'
import { createStepsSlice, type StepsState } from './stepsSlice'

export type WizardStore = ShotsSlice &
  ExportState &
  ReplacementState &
  ProjectState &
  DetectionState &
  StepsState

export const useWizardStore = create<WizardStore>()((...a) => ({
  ...createShotsSlice(...a),
  ...createExportSlice(...a),
  ...createReplacementSlice(...a),
  ...createProjectSlice(...a),
  ...createDetectionSlice(...a),
  ...createStepsSlice(...a),
}))

/**
 * Forget everything the person did in the wizard.
 *
 * WHY. The wizard is a form, and navigating to the FAQ or “how it works” left it intact:
 * coming back, the person landed in the middle of their previous analysis, sometimes on a
 * rejection they'd read ten minutes earlier. The store outlives the route, and without an
 * explicit reset it accumulates state nobody asked for.
 *
 * WHY A FUNCTION, NOT A SLICE ACTION. The reset touches all six slices at once, while a slice
 * by construction knows only its own state: an action inside one would reach into the others.
 * Here both the order and the completeness are visible — no slice forgotten.
 *
 * Object URLs (the clip and the finished file) are released by `clearProject` and
 * `resetExport`, each its own: the reset just calls them.
 */
export function resetWizard(): void {
  const s = useWizardStore.getState()
  s.clearProject()
  s.clearShots()
  s.clearDetection()
  s.clearReplacement()
  s.resetExport()
  s.resetSteps()
}
