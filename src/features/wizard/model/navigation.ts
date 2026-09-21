/**
 * Wizard navigation as an EXPLICIT state machine.
 *
 * WHY. This same state used to be smeared across three kinds of storage: the step and the
 * overlay flag in `useState`; the transition lock, overlay start time, timer ID and
 * “drop the overlay after the transition” in four `useRef`s; and the in-flight transition
 * flag in `useTransition`. None of it was visible as a whole, and consistency relied
 * on vigilance.
 *
 * HOW THAT ENDED. The lock was set on a transition and cleared only together with the
 * overlay. If even one transition didn't complete, the lock stayed armed — and the NEXT
 * transition silently did nothing: the function returned on its first line, and the effect
 * didn't re-run because its dependencies hadn't changed. From outside it looked as if the
 * form had reset and nothing was happening. For good.
 *
 * THERE IS NO LOCK HERE AT ALL. It was a flag for the “transition already scheduled” state,
 * and now that state has a name: `moving`. Nothing can get stuck — any start of work moves
 * the machine to `busy`, which by definition has no scheduled transition.
 *
 * WHY NOT IN THE STORE. `useTransition` is a hook; it keeps the previous screen visible while
 * the next one's chunk loads. External store updates aren't deferred by transitions, so a
 * step in zustand would cost that smoothness. Only the rules live here, without React; the
 * component sets up the timer and the transition.
 */
import { MIN_SCREEN_BUSY_MS, type WizardStep } from './types'

export type NavState =
  /** Resting state: the person is on a step, no overlay. */
  | { phase: 'idle'; step: WizardStep }
  /** Work in progress: overlay shown, no transition scheduled. */
  | { phase: 'busy'; step: WizardStep; since: number }
  /** Transition scheduled: waiting for the overlay to stay up for its minimum. */
  | { phase: 'moving'; step: WizardStep; since: number; to: WizardStep }
  /** The step has changed; waiting for React to finish building the new screen. */
  | { phase: 'settling'; step: WizardStep }

export type NavEvent =
  /** Work started. `restart` restarts the overlay's minimum display time. */
  | { type: 'busy'; now: number; restart?: boolean }
  /** Request a transition. Ignored in `moving` — that's what the old lock was. */
  | { type: 'go'; to: WizardStep; now: number }
  /** Minimum time elapsed: change the step. */
  | { type: 'commit' }
  /** React finished building the screen. */
  | { type: 'settled' }
  /** Go immediately, cancelling anything scheduled. */
  | { type: 'jump'; to: WizardStep }
  /**
   * Cancel a scheduled transition, KEEPING the overlay.
   *
   * Needed when new work has started: the lock from the previous navigation has nothing
   * to do with it, and it's too early to drop the overlay.
   */
  | { type: 'release'; now: number }
  /** Work finished: drop the overlay and anything scheduled. */
  | { type: 'done' }

export const initialNav = (step: WizardStep): NavState => ({ phase: 'idle', step })

export function nav(state: NavState, event: NavEvent): NavState {
  switch (event.type) {
    case 'busy': {
      // The minimum-time countdown continues if the overlay was already up: otherwise a chain
      // of jobs would stretch it to the sum of the minimums.
      const since =
        !event.restart && state.phase !== 'idle' && 'since' in state ? state.since : event.now
      return { phase: 'busy', step: state.step, since }
    }

    case 'go': {
      // A transition is already scheduled — drop the second request. This is the only place
      // where the lock used to be.
      if (state.phase === 'moving') return state
      const since = 'since' in state ? state.since : event.now
      return { phase: 'moving', step: state.step, since, to: event.to }
    }

    case 'commit':
      if (state.phase !== 'moving') return state
      return { phase: 'settling', step: state.to }

    case 'settled':
      if (state.phase !== 'settling') return state
      return { phase: 'idle', step: state.step }

    case 'jump':
      return { phase: 'idle', step: event.to }

    case 'release':
      // From `moving` back to busy: the transition is cancelled, the overlay stays.
      if (state.phase !== 'moving') return state
      return { phase: 'busy', step: state.step, since: state.since }

    case 'done':
      return { phase: 'idle', step: state.step }
  }
}

/** Whether to show the overlay. */
export const isBusy = (state: NavState): boolean => state.phase !== 'idle'

/** How much longer to keep the overlay before changing the step. */
export function remainingWait(state: NavState, now: number): number {
  if (state.phase !== 'moving') return 0
  return Math.max(0, MIN_SCREEN_BUSY_MS - (now - state.since))
}
