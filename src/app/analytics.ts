import { GA_ID } from '../shared/config/env'
import { ensureDataLayer, gtag } from '../shared/analytics/track'

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
  ensureDataLayer()
  gtag('js', new Date())
  gtag('config', id)
}
