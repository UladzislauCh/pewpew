/**
 * Shot markers: state and every operation on them.
 *
 * WHY SEPARATE FROM THE COMPONENT. These four operations used to be declared right in
 * `WizardApp` and threaded down three levels — wizard step, editor, track. Here they are
 * functions over an array that know nothing about React or the screen, so they can be
 * tested without booting the app. Before the move there wasn't a single test for them.
 *
 * A LINE BEST NOT CROSSED: data and its changes live here. Asking for confirmation,
 * showing messages, hitting the network — that's the component's job. Otherwise the store
 * stops being a store, and it can't be tested again.
 */
import type { StateCreator } from 'zustand'
import type { DetectedShot } from '../../../domain/detection/shotDetection'

export interface ShotsSlice {
  /** Markers are ALWAYS sorted by time, except mid-drag. */
  shots: DetectedShot[]
  /** Replace the whole set — this is how detection puts markers in. */
  setShots: (shots: DetectedShot[]) => void
  addShot: (time: number) => void
  removeShot: (index: number) => void
  /**
   * Move a marker in time WITHOUT re-sorting.
   *
   * Sorting here would break dragging: the marker's index would slip out from under the
   * finger as soon as it passed a neighbour. `finalizeShotOrder` restores the order
   * on mouse release.
   */
  moveShot: (index: number, time: number) => void
  /** Restore time order. Called when a drag ends. */
  finalizeShotOrder: () => void
  clearShots: () => void
}

const byTime = (a: DetectedShot, b: DetectedShot) => a.time - b.time

export const createShotsSlice: StateCreator<ShotsSlice, [], [], ShotsSlice> = (set) => ({
  shots: [],

  setShots: (shots) => set({ shots }),

  addShot: (time) =>
    set((s) => ({
      // Confidence of one: a person placed this marker, there's nothing to rank it by.
      shots: [...s.shots, { time, strength: 1, relativeLoudness: 1 }].sort(byTime),
    })),

  removeShot: (index) => set((s) => ({ shots: s.shots.filter((_, i) => i !== index) })),

  moveShot: (index, time) =>
    set((s) => {
      if (!s.shots[index]) return s
      const next = [...s.shots]
      next[index] = { ...next[index], time }
      return { shots: next }
    }),

  finalizeShotOrder: () => set((s) => ({ shots: [...s.shots].sort(byTime) })),

  clearShots: () => set({ shots: [] }),
})
