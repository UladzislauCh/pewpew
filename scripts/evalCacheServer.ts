/**
 * Dev-only receiver for results from the research pages in `eval/`.
 *
 * Pages like `eval/weighted.html` compute in the browser, because there's no WebCodecs in
 * Node, and they used to hand back results VIA DOWNLOAD. The browser asked for confirmation
 * on every file, and a run produces three files — three dialogs per run, then they had to be
 * moved into `eval/.cache/` by hand.
 *
 * Here the page just sends the result as a POST request, and it lands right where it's needed.
 *
 * Only mounted by `vite dev`, never ships in the build. Writes are allowed strictly under
 * `eval/.cache/` and only under a plain filename: dot-dot and slashes in the name are
 * rejected, otherwise the dev server would become a write primitive to anywhere on disk.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import type { Connect, Plugin } from 'vite'

const API_PREFIX = '/__cache/'
/** Frame stacks at 64x64 are about 180 MB; the limit has headroom for larger ones. */
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024
/** Plain filename: letters, digits, dot, hyphen, underscore. No slashes, no «..». */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_UPLOAD_BYTES) {
        rej(new Error(`тело больше ${MAX_UPLOAD_BYTES} байт`))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => res(Buffer.concat(chunks)))
    req.on('error', rej)
  })
}

export function evalCacheServer(): Plugin {
  return {
    name: 'eval-cache-server',
    apply: 'serve',
    configureServer(server) {
      const dir = resolve(server.config.root, 'eval/.cache')
      const handler: Connect.NextHandleFunction = (req, res, next) => {
        const url = req.url ?? ''
        if (!url.startsWith(API_PREFIX)) return next()
        void handle(req, res as ServerResponse, url, dir)
      }
      server.middlewares.use(handler)
    },
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, url: string, dir: string): Promise<void> {
  const send = (code: number, body: unknown): void => {
    res.statusCode = code
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(body))
  }
  if (req.method !== 'POST') return send(405, { error: 'только POST' })

  const name = decodeURIComponent(url.slice(API_PREFIX.length).split('?')[0])
  if (!SAFE_NAME.test(name)) return send(400, { error: `недопустимое имя файла: ${name}` })

  try {
    const body = await readBody(req)
    await mkdir(dir, { recursive: true })
    await writeFile(resolve(dir, name), body)
    send(200, { saved: `eval/.cache/${name}`, bytes: body.length })
  } catch (error) {
    send(500, { error: error instanceof Error ? error.message : String(error) })
  }
}
