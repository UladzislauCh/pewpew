import { describe, expect, it, vi } from 'vitest'
import { submitToWeb3Forms, WEB3FORMS_ENDPOINT } from './web3forms'

describe('submitToWeb3Forms', () => {
  const respond = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

  it('success — only when success: true is in the body', async () => {
    const fetchImpl = respond(200, { success: true })
    expect(await submitToWeb3Forms({ access_key: 'KEY', message: 'привет' }, { fetchImpl })).toBe('sent')
    expect(fetchImpl).toHaveBeenCalledWith(WEB3FORMS_ENDPOINT, expect.objectContaining({ method: 'POST' }))
  })

  it('body is FormData with the request fields, no manual Content-Type', async () => {
    const fetchImpl = respond(200, { success: true })
    await submitToWeb3Forms({ access_key: 'KEY', message: 'привет' }, { fetchImpl })
    const init = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1]
    expect(init.body).toBeInstanceOf(FormData)
    const body = init.body as FormData
    expect(body.get('access_key')).toBe('KEY')
    expect(body.get('message')).toBe('привет')
    expect(init.headers).toBeUndefined()
  })

  it('status 200 with success: false — did not go through', async () => {
    expect(await submitToWeb3Forms({}, { fetchImpl: respond(200, { success: false }) })).toBe('failed')
  })

  it('a network error and a timeout — did not go through', async () => {
    const broken = vi.fn(async () => {
      throw new TypeError('network')
    }) as unknown as typeof fetch
    expect(await submitToWeb3Forms({}, { fetchImpl: broken })).toBe('failed')

    const hanging = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    ) as unknown as typeof fetch
    expect(await submitToWeb3Forms({}, { fetchImpl: hanging, timeoutMs: 10 })).toBe('failed')
  })
})
