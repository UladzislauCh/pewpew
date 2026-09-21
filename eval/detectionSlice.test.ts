/**
 * Shot detection lifecycle: the "running" flag, readiness for a specific file,
 * discarding a stale run.
 *
 * There used to be no way to test this: the lifecycle lived in a component effect
 * mixed together with the pipeline itself — the audio net, the ammo counter and the
 * flash model. Here the caller supplies the pipeline, and the test feeds it a fake one.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useWizardStore } from '../src/features/wizard/store/wizardStore'

const store = () => useWizardStore.getState()
const file = (name = 'clip.mp4') => new File([new Blob([])], name, { type: 'video/mp4' })

beforeEach(() => {
  useWizardStore.setState({
    onsetAnalysis: null,
    isDetecting: false,
    isScanningVideo: false,
    shotsReadyFor: null,
    slowBackend: false,
    _detectRun: 0,
  })
})

describe('shot detection', () => {
  it('raises the "running" flag SYNCHRONOUSLY, before the first await', () => {
    // Otherwise the editor flashes empty between parsing finishing and detection starting.
    void store().runDetection(file(), async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(store().isDetecting).toBe(true)
  })

  it('marks readiness for THIS SPECIFIC file when it finishes', async () => {
    const clip = file()
    await store().runDetection(clip, async () => {})
    expect(store().shotsReadyFor).toBe(clip)
    expect(store().isDetecting).toBe(false)
  })

  it('marks readiness even when the pipeline throws', async () => {
    const clip = file()
    await expect(
      store().runDetection(clip, async () => {
        throw new Error('модель не поднялась')
      }),
    ).rejects.toThrow()
    // Otherwise the wizard would stay stuck on the upload screen with a spinning overlay forever.
    expect(store().shotsReadyFor).toBe(clip)
    expect(store().isDetecting).toBe(false)
  })

  it('the pipeline reports progress as it runs', async () => {
    await store().runDetection(file(), async (report) => {
      report.onset({ times: [], values: [] } as never)
      report.scanningVideo(true)
      report.backend('wasm')
      expect(store().isScanningVideo).toBe(true)
      report.scanningVideo(false)
    })
    expect(store().onsetAnalysis).not.toBeNull()
    expect(store().slowBackend).toBe(true)
    expect(store().isScanningVideo).toBe(false)
  })

  it('a new run cancels the previous one: the stale one does not mark readiness', async () => {
    const first = file('первый.mp4')
    let release: (() => void) | null = null
    const slow = store().runDetection(first, async () => {
      await new Promise<void>((r) => (release = r))
    })
    const second = file('второй.mp4')
    const fast = store().runDetection(second, async () => {})
    await fast
    release!()
    await slow
    // Readiness must stick from the SECOND run, not from the first one catching up.
    expect(store().shotsReadyFor).toBe(second)
  })

  it('clearing resets everything and invalidates an in-flight run', async () => {
    let release: (() => void) | null = null
    const running = store().runDetection(file(), async () => {
      await new Promise<void>((r) => (release = r))
    })
    store().clearDetection()
    release!()
    await running
    expect(store().shotsReadyFor).toBeNull()
    expect(store().isDetecting).toBe(false)
  })
})
