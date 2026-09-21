/**
 * Shot detection progress: what's been computed so far and which clip the answer is ready for.
 *
 * THE DETECTION ITSELF IS NOT HERE, on purpose. The detection pipeline — audio network, ammo
 * counter, flash model — is assembled in the wizard, alongside all the measured facts that
 * explain why it's built that way. The slice owns the lifecycle: started, video stage
 * running, finished, ready for this particular file.
 *
 * WHY READINESS IS A FILE, NOT A FLAG. The wizard moves to the edit screen only once
 * analysis and detection are done. A flag doesn't work: the transition effect is declared
 * ABOVE the detection effect and in the same tick still sees the flag down — the transition
 * fired too early, and the person landed on “check the markers” with a spinner instead of
 * markers. Comparing against the file doesn't depend on effect order.
 *
 * MARKERS LIVE IN A NEIGHBOURING SLICE and are put there by the wizard: slices deliberately
 * don't know about each other, otherwise each would have to be typed via the whole store, in a circle.
 */
import type { StateCreator } from 'zustand'
import type { OnsetAnalysis } from '../../../domain/detection/onsetDetection'

/** What the pipeline reports about itself as it runs. */
export interface DetectionReport {
  /** Spectral flux curve: the editor draws it as a backdrop under the markers. */
  onset: (analysis: OnsetAnalysis | null) => void
  /** Whether the video pass is running — it takes seconds, and without the flag the screen looks frozen. */
  scanningVideo: (active: boolean) => void
  /** What the model runs on. `wasm` is seventeen times slower than WebGPU. */
  backend: (backend: 'webgpu' | 'wasm') => void
  /** How many shots have been found so far. The waiting screen shows this number. */
  found: (count: number) => void
  /**
   * Cancellation signal for the pipeline.
   *
   * Without it, cancel only stops listening for the answer: a stale run recognises itself
   * by generation and stays quiet, but keeps computing to the end of the clip.
   */
  signal: AbortSignal
}

export interface DetectionSlice {
  onsetAnalysis: OnsetAnalysis | null
  /** Detection is running. Meanwhile the edit screen is covered by the overlay: nothing to edit yet. */
  isDetecting: boolean
  /** The video pass is running — part of detection, a separate flag for the on-screen label. */
  isScanningVideo: boolean
  /** The file for which detection is FINISHED. Not a flag — see the header. */
  shotsReadyFor: File | null
  /** The model ran on wasm, i.e. the GPU wasn't picked up. */
  slowBackend: boolean
  /** How many shots were found. `null` — not counted yet. */
  foundShots: number | null

  /**
   * Run detection for a file. The caller brings the pipeline itself, which reports
   * on its progress via `report`.
   *
   * The “running” flag is set SYNCHRONOUSLY, before the first await: otherwise the editor
   * had time to flash empty between analysis finishing and detection starting.
   */
  runDetection: (
    file: File | null,
    run: (report: DetectionReport) => Promise<void>,
  ) => Promise<void>
  clearDetection: () => void
  /** Cancel detection: abort the pipeline and forget everything it has computed so far. */
  cancelDetection: () => void
}

interface DetectionInternals {
  /** Detection generation: bumped on each new run, so a stale run recognises itself. */
  _detectRun: number
}

export type DetectionState = DetectionSlice & DetectionInternals

const EMPTY = {
  onsetAnalysis: null,
  isDetecting: false,
  isScanningVideo: false,
  shotsReadyFor: null,
  slowBackend: false,
  foundShots: null,
}

/**
 * Aborter for the current run. Lives outside the state: it's not render data but a handle
 * that cancel pulls, and putting it in the store would re-render subscribers on every new
 * run for no reason at all.
 */
let running: AbortController | null = null

export const createDetectionSlice: StateCreator<
  DetectionState,
  [],
  [],
  DetectionState
> = (set, get) => ({
  ...EMPTY,
  _detectRun: 0,

  clearDetection: () => {
    running?.abort()
    running = null
    set((s) => ({ ...EMPTY, _detectRun: s._detectRun + 1 }))
  },

  cancelDetection: () => {
    running?.abort()
    running = null
    set((s) => ({ ...EMPTY, _detectRun: s._detectRun + 1 }))
  },

  runDetection: async (file, run) => {
    const runId = get()._detectRun + 1
    const stale = () => get()._detectRun !== runId
    running?.abort()
    const controller = new AbortController()
    running = controller
    set({
      _detectRun: runId,
      isDetecting: true,
      isScanningVideo: false,
      onsetAnalysis: null,
      shotsReadyFor: null,
      foundShots: null,
    })

    const report: DetectionReport = {
      onset: (analysis) => {
        if (!stale()) set({ onsetAnalysis: analysis })
      },
      scanningVideo: (active) => {
        if (!stale()) set({ isScanningVideo: active })
      },
      backend: (backend) => {
        if (!stale()) set({ slowBackend: backend === 'wasm' })
      },
      found: (count) => {
        if (!stale()) set({ foundShots: count })
      },
      signal: controller.signal,
    }

    try {
      await run(report)
    } finally {
      // Readiness is marked on failure too: otherwise the wizard would stay forever on the
      // upload form with a spinning overlay and not a word of explanation.
      // A cancelled run doesn't count as ready: `cancelDetection` has already cleared
      // everything, and writing `shotsReadyFor` here would send the wizard back to editing.
      if (!stale() && !controller.signal.aborted) {
        set({ isDetecting: false, isScanningVideo: false, shotsReadyFor: file })
      }
    }
  },
})
