/**
 * Operations on shot labels. Before moving into the store they couldn't be tested
 * without mounting the whole app, and not a single test existed for them.
 *
 * The main thing here is the drag-and-drop CONTRACT: `moveShot` deliberately does NOT
 * sort, otherwise the index would drift out from under the cursor, and order is
 * restored by `finalizeShotOrder` on release. The contract isn't obvious, and it's
 * easy to break by "tidying up" one of the two functions.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useWizardStore } from '../src/features/wizard/store/wizardStore'

const times = () => useWizardStore.getState().shots.map((s) => s.time)
const store = () => useWizardStore.getState()

beforeEach(() => {
  useWizardStore.setState({ shots: [] })
})

describe('shot labels', () => {
  it('inserts by time, not at the end', () => {
    store().addShot(2)
    store().addShot(1)
    store().addShot(1.5)
    expect(times()).toEqual([1, 1.5, 2])
  })

  it('gives a manually added label full confidence', () => {
    store().addShot(1)
    expect(store().shots[0]).toMatchObject({ strength: 1, relativeLoudness: 1 })
  })

  it('removes by index without touching neighbors', () => {
    store().setShots([1, 2, 3].map((time) => ({ time, strength: 1, relativeLoudness: 1 })))
    store().removeShot(1)
    expect(times()).toEqual([1, 3])
  })

  it('dragging does NOT re-sort: the index must stay under the cursor', () => {
    store().setShots([1, 2, 3].map((time) => ({ time, strength: 1, relativeLoudness: 1 })))
    // Drag the first label past the third — order must temporarily break.
    store().moveShot(0, 3.5)
    expect(times()).toEqual([3.5, 2, 3])
    // And the label at index 0 is still the one being dragged.
    expect(store().shots[0].time).toBe(3.5)
  })

  it('order is restored on release', () => {
    store().setShots([1, 2, 3].map((time) => ({ time, strength: 1, relativeLoudness: 1 })))
    store().moveShot(0, 3.5)
    store().finalizeShotOrder()
    expect(times()).toEqual([2, 3, 3.5])
  })

  it('moving a nonexistent label breaks nothing', () => {
    store().setShots([{ time: 1, strength: 1, relativeLoudness: 1 }])
    const before = store().shots
    store().moveShot(7, 5)
    expect(store().shots).toBe(before)
  })

  it('clearing empties the set', () => {
    store().setShots([{ time: 1, strength: 1, relativeLoudness: 1 }])
    store().clearShots()
    expect(times()).toEqual([])
  })
})
