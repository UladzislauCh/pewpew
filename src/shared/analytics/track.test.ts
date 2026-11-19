import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureDataLayer, gtag, trackEvent } from './track'

// Runs in Node: `window` is a minimal fake carrying only `dataLayer`. Unstubbing gives the
// no-window case (eval/, scripts/, the wizard store under Vitest).

let fakeWindow: { dataLayer?: unknown[] }

beforeEach(() => {
  fakeWindow = {}
  vi.stubGlobal('window', fakeWindow)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('gtag', () => {
  it('queues entries as `arguments` objects, which gtag.js requires', () => {
    fakeWindow.dataLayer = []

    gtag('config', 'G-TEST123')

    const [entry] = fakeWindow.dataLayer
    expect(Array.isArray(entry)).toBe(false)
    expect(Object.prototype.toString.call(entry)).toBe('[object Arguments]')
  })

  it('keeps the arguments in order and appends to entries already queued', () => {
    const existing = ['pre-existing']
    fakeWindow.dataLayer = existing

    gtag('set', 'a', 1)

    expect(fakeWindow.dataLayer).toBe(existing)
    expect(existing).toHaveLength(2)
    expect(existing[0]).toBe('pre-existing')
    const entry = existing[1] as ArrayLike<unknown>
    expect(entry.length).toBe(3)
    expect([entry[0], entry[1], entry[2]]).toEqual(['set', 'a', 1])
  })

  it('does nothing and does not throw without a window', () => {
    vi.unstubAllGlobals()

    expect(() => gtag('event', 'x')).not.toThrow()
  })

  it('does nothing and does not create a queue when the window has none', () => {
    expect(() => gtag('event', 'x')).not.toThrow()

    expect(fakeWindow.dataLayer).toBeUndefined()
  })
})

describe('trackEvent', () => {
  it('queues the event command first, then the name, then the params', () => {
    fakeWindow.dataLayer = []
    const params = { reason: 'too_large', size_mb: 12 }

    trackEvent('video_rejected', params)

    expect(fakeWindow.dataLayer).toHaveLength(1)
    const entry = fakeWindow.dataLayer[0] as ArrayLike<unknown>
    expect(Object.prototype.toString.call(entry)).toBe('[object Arguments]')
    expect(entry.length).toBe(3)
    expect(entry[0]).toBe('event')
    expect(entry[1]).toBe('video_rejected')
    expect(entry[2]).toBe(params)
  })

  it('queues an event without params, leaving the params slot empty', () => {
    fakeWindow.dataLayer = []

    trackEvent('video_upload')

    const entry = fakeWindow.dataLayer[0] as ArrayLike<unknown>
    expect(entry[0]).toBe('event')
    expect(entry[1]).toBe('video_upload')
    expect(entry[2]).toBeUndefined()
  })

  it('never creates the queue when analytics was not set up', () => {
    trackEvent('video_upload', { size_mb: 3 })

    expect(fakeWindow.dataLayer).toBeUndefined()
  })

  it('does nothing and does not throw without a window', () => {
    vi.unstubAllGlobals()

    expect(() => trackEvent('video_upload', { size_mb: 3 })).not.toThrow()
  })
})

describe('ensureDataLayer', () => {
  it('creates an empty queue when there is none', () => {
    ensureDataLayer()

    expect(fakeWindow.dataLayer).toEqual([])
  })

  it('is idempotent: repeated calls keep the same queue', () => {
    ensureDataLayer()
    const first = fakeWindow.dataLayer

    ensureDataLayer()

    expect(fakeWindow.dataLayer).toBe(first)
  })

  it('keeps an existing queue as the same object with its entries', () => {
    const existing = ['pre-existing']
    fakeWindow.dataLayer = existing

    ensureDataLayer()

    expect(fakeWindow.dataLayer).toBe(existing)
    expect(existing).toEqual(['pre-existing'])
  })

  it('does nothing and does not throw without a window', () => {
    vi.unstubAllGlobals()

    expect(() => ensureDataLayer()).not.toThrow()
  })

  it('is what makes later events land in the queue', () => {
    ensureDataLayer()

    trackEvent('video_upload', { size_mb: 3 })

    expect(fakeWindow.dataLayer).toHaveLength(1)
  })
})
