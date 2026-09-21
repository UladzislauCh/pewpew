/**
 * Export of the finished clip: process state, cancellation and the result URL.
 *
 * WHAT'S UNUSUAL HERE. The slice doesn't know HOW the video is encoded: the caller brings
 * that as a separate function. The reason is exactly the one behind the previous slice:
 * it makes the process testable. Otherwise a test for “progress reached the end, then a
 * cancel arrived” would need a real encoder and a real clip.
 *
 * ITS OWN CANCELLATION, not the wizard's shared job counter. Export used to be cancelled by
 * the same `workIdRef` that cancelled media analysis and audio splicing: bump the number and
 * everything died at once. From outside you couldn't tell what exactly was being cancelled.
 * Here the cancellation has a name and must be called explicitly.
 *
 * THE RESULT URL lives here too and is released on replacement. That used to be done by an
 * effect in the component, and the URL lived exactly as long as the component did.
 *
 * BOUNDARY: the error message is stored AS IS, untranslated. The component translates —
 * otherwise the store would have to pull in i18n, and everything that comes with it.
 */
import type { StateCreator } from 'zustand'

export type ExportStatus = 'idle' | 'exporting' | 'done' | 'error'

/** How exactly to encode. Returns the finished file, reporting progress along the way. */
export type ExportRun = (onProgress: (value: number) => void) => Promise<Blob>

export interface ExportSlice {
  exportStatus: ExportStatus
  /** From zero to one. */
  exportProgress: number
  /** The message as the encoder gave it, untranslated. `null` — no error. */
  exportError: string | null
  exportBlob: Blob | null
  /** Download URL for the file. Created and released right here. */
  exportUrl: string | null

  /**
   * Start encoding. A second concurrent start is rejected immediately — before
   * React has a chance to re-render.
   */
  startExport: (run: ExportRun) => Promise<Blob | null>
  /**
   * Abort encoding if it's running.
   *
   * A FINISHED file is KEPT. The difference matters: the user may already have downloaded
   * the result, and dropping the URL because they stepped back would lose their work.
   * Forgetting the result is `resetExport`.
   */
  cancelExport: () => void
  /** Cancel and forget the result — e.g. when the audio track has changed. */
  resetExport: () => void
}

/**
 * The slice's internal state. It sits in the shared store because zustand has no notion
 * of privacy; the underscore prefix is a “don't touch from outside” convention.
 */
interface ExportInternals {
  /** Run generation. Bumped on cancel, so a stale run can recognise itself. */
  _exportRun: number
  /** Synchronous lock: a second click must not get in before the re-render. */
  _exportBusy: boolean
}

export type ExportState = ExportSlice & ExportInternals

const IDLE = {
  exportStatus: 'idle' as ExportStatus,
  exportProgress: 0,
  exportError: null,
  exportBlob: null,
}

export const createExportSlice: StateCreator<ExportState, [], [], ExportState> = (set, get) => ({
  ...IDLE,
  exportUrl: null,
  _exportRun: 0,
  _exportBusy: false,

  cancelExport: () =>
    set((s) => ({
      _exportRun: s._exportRun + 1,
      _exportBusy: false,
      // From “running” we go back to idle; “done” and “error” are outcomes and stay as they are.
      exportStatus: s.exportStatus === 'exporting' ? 'idle' : s.exportStatus,
      exportProgress: 0,
    })),

  resetExport: () => {
    const { exportUrl } = get()
    if (exportUrl) URL.revokeObjectURL(exportUrl)
    set((s) => ({ ...IDLE, exportUrl: null, _exportRun: s._exportRun + 1, _exportBusy: false }))
  },

  startExport: async (run) => {
    if (get()._exportBusy) return null
    const runId = get()._exportRun
    const stale = () => get()._exportRun !== runId

    // The previous file is stale: release its URL right away, otherwise over a long
    // session the browser keeps every intermediate result in memory.
    const previous = get().exportUrl
    if (previous) URL.revokeObjectURL(previous)
    set({ ...IDLE, exportUrl: null, exportStatus: 'exporting', _exportBusy: true })

    try {
      const blob = await run((value) => {
        if (!stale()) set({ exportProgress: value })
      })
      if (stale()) return null
      set({ exportBlob: blob, exportUrl: URL.createObjectURL(blob), exportStatus: 'done' })
      return blob
    } catch (error) {
      if (stale()) return null
      set({
        exportError: error instanceof Error ? error.message : String(error),
        exportStatus: 'error',
      })
      return null
    } finally {
      if (!stale()) set({ _exportBusy: false })
    }
  },
})
