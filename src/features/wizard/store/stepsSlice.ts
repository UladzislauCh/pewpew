import type { StateCreator } from 'zustand'
import { stepIndex, type WizardStep } from '../model/types'

/**
 * How far the person has got through the wizard.
 *
 * WHY SEPARATE STATE WHEN THERE IS A CURRENT STEP. The bar distinguishes three states, and
 * two of them can't be reconstructed from the current step alone. Going back from sound to
 * markers, the person sees step two as current — but they've already passed step three,
 * and drawing it as unavailable is wrong: it lies about what's ahead.
 *
 * The current step lives in the navigation state machine and does NOT move here: it's tied
 * to `useTransition`, and external store updates aren't deferred by transitions
 * (details in `wizard/navigation.ts`). Only progress lives here — plain data
 * that survives going back.
 */
export interface StepsState {
  /** The furthest step reached. Everything beyond it is unavailable. */
  reachedStep: WizardStep
  /** Mark a step as reached. Never moves back: going back doesn't undo progress. */
  markStepReached: (step: WizardStep) => void
  /** Started over with a new clip. */
  resetSteps: () => void
}

export const createStepsSlice: StateCreator<StepsState, [], [], StepsState> = (set) => ({
  reachedStep: 'upload',
  markStepReached: (step) =>
    set((s) => (stepIndex(step) > stepIndex(s.reachedStep) ? { reachedStep: step } : s)),
  resetSteps: () => set({ reachedStep: 'upload' }),
})
