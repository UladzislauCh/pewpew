/**
 * Google Analytics primitives: the `dataLayer` queue, `gtag` and `trackEvent`.
 *
 * This is the only file in `src/` that mentions `dataLayer`. It deliberately imports
 * nothing from `shared/config/env` and never reads `import.meta.env`: the wizard store
 * (and through it, this module) also runs in Node under Vitest, and `eval/` and
 * `scripts/` run outside Vite altogether. The only guard is “is there a `window` with a
 * queue on it”.
 *
 * Whether analytics is on at all is decided elsewhere (`app/analytics.ts`, from
 * `VITE_GA_ID`): only that setup path creates the queue. Events never do — with an empty
 * ID every dev session would otherwise pile hits into an array nobody drains, and a
 * late-arriving gtag.js could flush that stale backlog. No queue means no-op.
 */
interface DataLayerHost {
  dataLayer?: unknown[]
}

/**
 * The `window` object, reached as a property of `globalThis` so the identifier `window`
 * is never named: `tsconfig.node.json` has no DOM lib, and this module is type-checked
 * there too. In a browser `globalThis.window === window`; in Node it is `undefined`.
 */
function dataLayerHost(): DataLayerHost | undefined {
  return (globalThis as { window?: DataLayerHost }).window
}

/**
 * Creates the queue if it isn't there yet. Called by the setup path only — never by
 * `gtag` or `trackEvent`, see the module comment.
 */
export function ensureDataLayer(): void {
  const host = dataLayerHost()
  if (!host) return
  host.dataLayer = host.dataLayer ?? []
}

/**
 * The queue entry must be the `arguments` object, not an array.
 *
 * gtag.js reads every `dataLayer` entry as `arguments`: it checks `length` and takes
 * the command out of `[0]`, but an `Array` is rejected by its type check, so `js` and
 * `config` are dropped without a word and no request to `/g/collect` is ever made.
 * The official snippet is `function gtag(){dataLayer.push(arguments)}` — hence a
 * function declaration here instead of a rest-parameter arrow. Do not “modernise” it.
 *
 * Without a queue (no `window` in Node, or analytics not set up) it silently does
 * nothing and never throws.
 */
function gtagImpl(): void {
  const queue = dataLayerHost()?.dataLayer
  if (!Array.isArray(queue)) return
  // oxlint-disable-next-line prefer-rest-params -- see the comment above: must be `arguments`
  queue.push(arguments)
}

export const gtag = gtagImpl as (...args: unknown[]) => void

/** Sends a GA event. A silent no-op when analytics isn't set up. */
export function trackEvent(name: string, params?: Record<string, string | number>): void {
  gtag('event', name, params)
}
