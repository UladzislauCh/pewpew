import { GA_ID } from '../shared/config/env'

/**
 * Google Analytics setup.
 *
 * The script used to sit right in `index.html` and always load — so visits to
 * `pnpm dev` ended up in production stats too. Now the ID comes from an environment
 * variable (ADR 0011), and when it's empty not a single request goes to
 * googletagmanager: neither the script nor the tracker.
 *
 * That's exactly why the script is injected by hand rather than in markup: “no key —
 * no analytics” can't be expressed in HTML.
 */
declare global {
  interface Window {
    dataLayer?: unknown[]
  }
}

/**
 * The queue entry must be the `arguments` object, not an array.
 *
 * gtag.js reads every `dataLayer` entry as `arguments`: it checks `length` and takes
 * the command out of `[0]`, but an `Array` is rejected by its type check, so `js` and
 * `config` are dropped without a word and no request to `/g/collect` is ever made.
 * The official snippet is `function gtag(){dataLayer.push(arguments)}` — hence a
 * function declaration here instead of a rest-parameter arrow. Do not “modernise” it.
 */
function gtagImpl(): void {
  // oxlint-disable-next-line prefer-rest-params -- see the comment above: must be `arguments`
  window.dataLayer?.push(arguments)
}

const gtag = gtagImpl as (...args: unknown[]) => void

export function setupAnalytics(id: string = GA_ID ?? ''): void {
  if (id.trim() === '') return
  if (document.querySelector('script[data-ga]')) return

  const script = document.createElement('script')
  script.async = true
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`
  script.dataset.ga = id
  document.head.appendChild(script)

  // The queue is filled before the script arrives: once loaded, gtag.js drains it
  // itself, so early commands aren't lost while it's still on the wire.
  window.dataLayer = window.dataLayer ?? []
  gtag('js', new Date())
  gtag('config', id)
}
