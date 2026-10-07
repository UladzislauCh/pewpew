import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupAnalytics } from './analytics'

// The test runs in Node, so `document` and `window` are minimal fakes. Only the calls
// `setupAnalytics` makes are modelled: querySelector('script[data-ga]'), createElement,
// head.appendChild, window.dataLayer.

interface FakeScript {
  async?: boolean
  src?: string
  dataset: Record<string, string>
}

let scripts: FakeScript[]
let fakeWindow: { dataLayer?: unknown[] }

beforeEach(() => {
  scripts = []
  fakeWindow = {}
  vi.stubGlobal('window', fakeWindow)
  vi.stubGlobal('document', {
    querySelector: (selector: string) =>
      selector === 'script[data-ga]' ? (scripts.find((s) => 'ga' in s.dataset) ?? null) : null,
    createElement: (): FakeScript => ({ dataset: {} }),
    head: { appendChild: (s: FakeScript) => void scripts.push(s) },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('setupAnalytics', () => {
  it('queues gtag commands as `arguments` objects, which gtag.js requires', () => {
    setupAnalytics('G-TEST123')

    const queue = fakeWindow.dataLayer ?? []
    expect(queue).toHaveLength(2)
    for (const entry of queue) {
      expect(Array.isArray(entry)).toBe(false)
      expect(Object.prototype.toString.call(entry)).toBe('[object Arguments]')
    }
  })

  it('queues the js and config commands in order', () => {
    setupAnalytics('G-TEST123')

    const [first, second] = (fakeWindow.dataLayer ?? []) as ArrayLike<unknown>[]
    expect(first.length).toBe(2)
    expect(first[0]).toBe('js')
    expect(first[1]).toBeInstanceOf(Date)
    expect(second.length).toBe(2)
    expect(second[0]).toBe('config')
    expect(second[1]).toBe('G-TEST123')
  })

  it('injects one async gtag script with the encoded ID', () => {
    setupAnalytics('G-TEST/123')

    expect(scripts).toHaveLength(1)
    expect(scripts[0].async).toBe(true)
    expect(scripts[0].src).toBe('https://www.googletagmanager.com/gtag/js?id=G-TEST%2F123')
  })

  it.each(['', '   ', '\t\n'])('adds no script and queues nothing for ID %j', (id) => {
    setupAnalytics(id)

    expect(scripts).toHaveLength(0)
    expect(fakeWindow.dataLayer).toBeUndefined()
  })

  it('does not inject a second script or queue again on a repeated call', () => {
    setupAnalytics('G-TEST123')
    setupAnalytics('G-TEST123')

    expect(scripts).toHaveLength(1)
    expect(fakeWindow.dataLayer).toHaveLength(2)
  })

  it('keeps entries already in an existing dataLayer', () => {
    const existing = ['pre-existing']
    fakeWindow.dataLayer = existing

    setupAnalytics('G-TEST123')

    expect(fakeWindow.dataLayer).toBe(existing)
    expect(existing).toHaveLength(3)
    expect(existing[0]).toBe('pre-existing')
  })
})
