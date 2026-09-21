/**
 * Export state: cancellation, restart, releasing the file URL.
 *
 * There used to be no way to test this: export lived in a component and required
 * a real encoder. Here the slice doesn't know how the video is encoded — the caller
 * supplies the method, and the test feeds it a fake one.
 *
 * `URL.createObjectURL` doesn't exist in Node, so it's stubbed: this also shows that
 * URLs are actually released and not leaking.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWizardStore } from '../src/features/wizard/store/wizardStore'

const store = () => useWizardStore.getState()

let created: string[] = []
let revoked: string[] = []

beforeEach(() => {
  created = []
  revoked = []
  let n = 0
  globalThis.URL.createObjectURL = vi.fn(() => {
    const url = `blob:fake/${++n}`
    created.push(url)
    return url
  })
  globalThis.URL.revokeObjectURL = vi.fn((url: string) => void revoked.push(url))
  useWizardStore.setState({
    exportStatus: 'idle',
    exportProgress: 0,
    exportError: null,
    exportBlob: null,
    exportUrl: null,
    _exportRun: 0,
    _exportBusy: false,
  })
})

const blob = () => new Blob(['x'])

describe('export', () => {
  it('reaches done and creates a file URL', async () => {
    const result = await store().startExport(async (onProgress) => {
      onProgress(0.5)
      return blob()
    })
    expect(result).not.toBeNull()
    expect(store().exportStatus).toBe('done')
    expect(store().exportProgress).toBe(0.5)
    expect(store().exportUrl).toBe(created[0])
  })

  it('rejects a second start while one is running', async () => {
    let release: (() => void) | null = null
    const slow = store().startExport(async () => {
      await new Promise<void>((r) => (release = r))
      return blob()
    })
    const second = await store().startExport(async () => blob())
    expect(second).toBeNull()
    release!()
    await slow
    expect(store().exportStatus).toBe('done')
  })

  it('a cancelled run does not write a result', async () => {
    let release: (() => void) | null = null
    const running = store().startExport(async () => {
      await new Promise<void>((r) => (release = r))
      return blob()
    })
    store().cancelExport()
    release!()
    expect(await running).toBeNull()
    // Cancellation returns to idle: the progress bar must not stay stuck.
    expect(store().exportStatus).toBe('idle')
    expect(store().exportBlob).toBeNull()
  })

  it('a cancelled run does not move the progress bar', async () => {
    let step: ((v: number) => void) | null = null
    let release: (() => void) | null = null
    const running = store().startExport(async (onProgress) => {
      step = onProgress
      await new Promise<void>((r) => (release = r))
      return blob()
    })
    await Promise.resolve()
    store().cancelExport()
    step!(0.9)
    expect(store().exportProgress).toBe(0)
    release!()
    await running
  })

  it('status is "exporting" while running, otherwise there would be no progress bar', async () => {
    let release: (() => void) | null = null
    const running = store().startExport(async () => {
      await new Promise<void>((r) => (release = r))
      return blob()
    })
    await Promise.resolve()
    expect(store().exportStatus).toBe('exporting')
    release!()
    await running
  })

  it('cancelling does NOT erase an already finished file', async () => {
    await store().startExport(async () => blob())
    const url = store().exportUrl
    store().cancelExport()
    expect(store().exportStatus).toBe('done')
    expect(store().exportUrl).toBe(url)
  })

  it('keeps the encoder error as-is, without translation', async () => {
    const result = await store().startExport(async () => {
      throw new Error('кодек не поддерживается')
    })
    expect(result).toBeNull()
    expect(store().exportStatus).toBe('error')
    expect(store().exportError).toBe('кодек не поддерживается')
  })

  it('a repeated export releases the previous URL', async () => {
    await store().startExport(async () => blob())
    const first = store().exportUrl
    await store().startExport(async () => blob())
    expect(revoked).toContain(first)
    expect(store().exportUrl).not.toBe(first)
  })

  it('reset releases the URL and clears state', async () => {
    await store().startExport(async () => blob())
    const url = store().exportUrl
    store().resetExport()
    expect(revoked).toContain(url)
    expect(store()).toMatchObject({ exportStatus: 'idle', exportBlob: null, exportUrl: null })
  })
})
