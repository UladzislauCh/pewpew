/**
 * Wizard navigation state machine.
 *
 * The main thing pinned down here is a bug the user described as "the form
 * reset itself and nothing happens." The transition lock used to live in a
 * separate ref and was only released together with the overlay; an incomplete
 * transition could leave it armed, and the next transition would silently
 * never fire AGAIN. There was no way to catch this before.
 */
import { describe, expect, it } from 'vitest'
import { MIN_SCREEN_BUSY_MS } from '../src/features/wizard/model/types'
import { initialNav, isBusy, nav, remainingWait, type NavState } from '../src/features/wizard/model/navigation'

const run = (state: NavState, ...events: Parameters<typeof nav>[1][]) =>
  events.reduce(nav, state)

describe('wizard navigation', () => {
  it('idle: no overlay', () => {
    const s = initialNav('upload')
    expect(isBusy(s)).toBe(false)
    expect(s.step).toBe('upload')
  })

  it('raises the overlay on busy without changing the step', () => {
    const s = nav(initialNav('upload'), { type: 'busy', now: 0 })
    expect(isBusy(s)).toBe(true)
    expect(s.step).toBe('upload')
  })

  it('holds the minimum before changing the step on transition', () => {
    let s = run(initialNav('upload'), { type: 'busy', now: 0 }, { type: 'go', to: 'edit-shots', now: 0 })
    expect(s.step).toBe('upload')
    expect(remainingWait(s, 0)).toBe(MIN_SCREEN_BUSY_MS)
    expect(remainingWait(s, MIN_SCREEN_BUSY_MS)).toBe(0)
    s = nav(s, { type: 'commit' })
    expect(s.step).toBe('edit-shots')
    expect(isBusy(s)).toBe(true) // overlay stays up while React builds the screen
    s = nav(s, { type: 'settled' })
    expect(isBusy(s)).toBe(false)
  })

  it('does NOT restart the hold on every busy event', () => {
    // Otherwise a chain of busy events would stretch the overlay by the sum of the minimums.
    const s = run(
      initialNav('upload'),
      { type: 'busy', now: 0 },
      { type: 'busy', now: 500 },
      { type: 'go', to: 'edit-shots', now: 500 },
    )
    expect(remainingWait(s, 700)).toBe(0)
  })

  it('restarts the hold when restart is requested', () => {
    const s = run(
      initialNav('upload'),
      { type: 'busy', now: 0 },
      { type: 'busy', now: 500, restart: true },
      { type: 'go', to: 'edit-shots', now: 500 },
    )
    expect(remainingWait(s, 700)).toBeGreaterThan(0)
  })

  it('drops a second transition request until the first one completes', () => {
    const s = run(
      initialNav('upload'),
      { type: 'go', to: 'edit-shots', now: 0 },
      { type: 'go', to: 'preview', now: 10 },
    )
    expect(s.phase).toBe('moving')
    expect(s.phase === 'moving' && s.to).toBe('edit-shots')
  })

  it('AN INCOMPLETE TRANSITION DOES NOT BLOCK THE NEXT ONE', () => {
    // Exactly the case that looked like "the form reset itself and nothing happens".
    let s = nav(initialNav('upload'), { type: 'go', to: 'edit-shots', now: 0 })
    // A new busy event cancels the planned transition, the overlay stays.
    s = nav(s, { type: 'release', now: 100 })
    expect(s.phase).toBe('busy')
    // And the next transition must fire.
    s = nav(s, { type: 'go', to: 'edit-shots', now: 200 })
    expect(s.phase).toBe('moving')
  })

  it('an immediate transition cancels everything planned', () => {
    const s = run(
      initialNav('edit-shots'),
      { type: 'busy', now: 0 },
      { type: 'go', to: 'preview', now: 0 },
      { type: 'jump', to: 'upload' },
    )
    expect(s).toEqual({ phase: 'idle', step: 'upload' })
  })

  it('finishing busy clears the overlay along with any plans', () => {
    const s = run(
      initialNav('upload'),
      { type: 'busy', now: 0 },
      { type: 'go', to: 'edit-shots', now: 0 },
      { type: 'done' },
    )
    expect(s).toEqual({ phase: 'idle', step: 'upload' })
  })

  it('events that do not match the current phase change nothing', () => {
    const idle = initialNav('upload')
    expect(nav(idle, { type: 'commit' })).toBe(idle)
    expect(nav(idle, { type: 'settled' })).toBe(idle)
    expect(nav(idle, { type: 'release', now: 0 })).toBe(idle)
  })
})
