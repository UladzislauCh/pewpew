import { WEB3FORMS_KEY } from '../config/env'

/**
 * Sending to Web3Forms.
 *
 * The project has no backend: the request goes straight from the browser. The Web3Forms
 * access key is public by design — all it can do is send mail to the linked address.
 * It lives in an environment variable rather than the code (`shared/config/env`, ADR 0011):
 * not for secrecy — Vite inlines the value into the bundle anyway — but so that a fork of
 * the public repo doesn't send mail to someone else's inbox. Their server-side sending is
 * paid, and we don't need it.
 */

export const WEB3FORMS_ENDPOINT = 'https://api.web3forms.com/submit'

/**
 * KEY FROM THE ENVIRONMENT. If it's set, mail always goes out — from development too.
 *
 * There's no stub or fake response here: submitting the form under `pnpm dev` with a filled
 * `.env.local` sends a real message to the linked inbox rather than faking success. So when
 * walking through form states by hand, better not press submit — or the inbox fills up with
 * test messages. Web3Forms has no separate dev key, and the quota is shared:
 * 250 messages a month (see `docs/HANDOFF-design.md`, “What the mockup lacks”, item 7).
 */
export const WEB3FORMS_ACCESS_KEY = WEB3FORMS_KEY ?? ''

/**
 * The only guard is against an EMPTY key: without one the request must not go out at all,
 * because Web3Forms will refuse it and the person will see the same “didn't get through”,
 * just after a pointless round trip to someone else's server. A missing key (no `.env.local`
 * at build time) gives an honest failure right away.
 */
export function isAccessKeyConfigured(key: string): boolean {
  return key.trim() !== ''
}

export type SubmitResult = 'sent' | 'failed'

/**
 * How long to wait for a response. Any longer and people decide it's broken and close it.
 * The draft stays intact, so a timeout error costs nothing.
 */
const TIMEOUT_MS = 15_000

/**
 * One request, and the response IS READ.
 *
 * Success is `success: true` in the body, not just a 200: Web3Forms returns 200 for some
 * rejections too, e.g. from the spam check. Any exception, timeout or
 * unreadable body means “didn't get through”.
 */
export async function submitToWeb3Forms(
  payload: Record<string, string>,
  { fetchImpl = fetch, timeoutMs = TIMEOUT_MS }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<SubmitResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  /*
   * FORM DATA, NOT JSON, AND NOT A SINGLE CUSTOM HEADER — as Web3Forms itself recommends.
   *
   * It's about the preflight. `Content-Type: application/json` isn't a form-safe header,
   * so the browser must first ask permission with a separate OPTIONS request.
   * That's an extra round trip to someone else's server on the path of feedback that only
   * gets one attempt anyway: if the preflight isn't answered, the message never goes out and
   * the person sees “didn't get through” despite doing everything right. `FormData` is a simple
   * type, needs no permission, and the request goes out immediately.
   *
   * No header is set AT ALL: the browser adds `multipart/form-data` along with the
   * boundary itself, and the boundary can't be built by hand — it's tied to the body.
   */
  const form = new FormData()
  for (const [name, value] of Object.entries(payload)) form.append(name, value)

  try {
    const response = await fetchImpl(WEB3FORMS_ENDPOINT, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    })
    const body = (await response.json().catch(() => null)) as { success?: unknown } | null
    return response.ok && body?.success === true ? 'sent' : 'failed'
  } catch {
    return 'failed'
  } finally {
    clearTimeout(timer)
  }
}


export async function sendFeedback(payload: Record<string, string>): Promise<SubmitResult> {
  if (isAccessKeyConfigured(WEB3FORMS_ACCESS_KEY)) return submitToWeb3Forms(payload)
  return 'failed'
}
