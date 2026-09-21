/**
 * Background preloading of the heavy engine: 24.6 MB of the ONNX runtime and 11.7 MB of model.
 *
 * WHAT IS NOT HERE AND WHY. Entering the page was NOT blocked by this before either: the worker
 * lives in a separate chunk, and ORT pulls its wasm only when a session is created. On entry only
 * `index` and translations load, that is all. The task is not "unblock entry" but to hide 36 MB
 * that would otherwise land entirely on the FIRST analysis — i.e. at the moment the user is
 * already waiting.
 *
 * ONLY BYTES ARE DOWNLOADED. No session is created, the model is not compiled, no memory is taken:
 * the files simply settle in the browser cache, and the real analysis takes them from there. A
 * warm-up that created a session would cost a hundred or two megabytes of memory for someone who
 * may never analyse anything at all.
 *
 * BEING POLITE TO THE NETWORK. No download with data saver on or on a slow connection: 36 MB
 * silently there is someone else's money. Request priority is low, the start is deferred to idle.
 */
import { WASM_URL } from './wasmUrl'

const MODEL_URL = '/models/flashNet416.onnx'

let started = false

interface SaveDataConnection {
  saveData?: boolean
  effectiveType?: string
}

/** Whether it is worth spending someone else's traffic on preloading. */
function networkAllows(): boolean {
  const connection = (navigator as Navigator & { connection?: SaveDataConnection }).connection
  if (!connection) return true
  if (connection.saveData) return false
  return connection.effectiveType !== 'slow-2g' && connection.effectiveType !== '2g'
}

/**
 * Start preloading when the browser is idle.
 *
 * Can be called any number of times: the work is done once per page load.
 */
export function warmFlashEngine(): void {
  if (started || typeof window === 'undefined') return
  started = true
  if (!networkAllows()) return

  const run = () => {
    for (const url of [WASM_URL, MODEL_URL]) {
      // `low` tells the browser to let through first everything the page needs right now.
      // The response is deliberately not read: the goal is a cache entry, not data in memory.
      void fetch(url, { priority: 'low', mode: 'cors', credentials: 'omit' }).catch(() => {})
    }
  }

  const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
    .requestIdleCallback
  if (idle) idle(run, { timeout: 5000 })
  else window.setTimeout(run, 2000)
}
