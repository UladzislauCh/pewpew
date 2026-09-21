/**
 * Dev-server backend for the ground-truth labeling tool at `/labeler.html`.
 *
 * The browser is the only place that can decode the example clips (Node has neither WebCodecs nor
 * ffmpeg available here), so the labeler decodes them client-side and posts the results back
 * through these endpoints: the human-made annotations land in `labels/`, and the decoded PCM is
 * cached to `examples/.cache/` so the Node evaluation harness can replay the exact same audio
 * without a browser.
 *
 * Only mounted by `vite dev` — never part of a production build.
 */
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import type { Connect, Plugin } from 'vite'
import { slugifyClipName } from '../src/domain/detection/labels'

const API_PREFIX = '/__labeler'
const MEDIA_EXTENSIONS = ['.mp4', '.mov', '.webm', '.mkv']
/** Refuse absurd payloads outright rather than buffering them; a 30 s stereo float WAV is ~10 MB. */
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024

export interface ClipEntry {
  slug: string
  file: string
  bytes: number
  hasLabels: boolean
  hasCache: boolean
  shotCount: number
  complete: boolean
}

interface Paths {
  examples: string
  cache: string
  labels: string
}

function resolvePaths(root: string): Paths {
  return {
    examples: resolve(root, 'examples'),
    cache: resolve(root, 'examples/.cache'),
    labels: resolve(root, 'labels'),
  }
}

async function listMediaFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && MEDIA_EXTENSIONS.some((ext) => entry.name.toLowerCase().endsWith(ext)))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function buildClipIndex(paths: Paths): Promise<Map<string, ClipEntry>> {
  const index = new Map<string, ClipEntry>()
  for (const file of await listMediaFiles(paths.examples)) {
    const slug = slugifyClipName(file)
    const labelsPath = join(paths.labels, `${slug}.json`)

    let shotCount = 0
    let complete = false
    let hasLabels = false
    try {
      const parsed = JSON.parse(await readFile(labelsPath, 'utf8')) as { shots?: unknown[]; complete?: boolean }
      hasLabels = true
      shotCount = Array.isArray(parsed.shots) ? parsed.shots.length : 0
      complete = parsed.complete === true
    } catch {
      // No labels yet (or unreadable) — reported as unlabeled.
    }

    index.set(slug, {
      slug,
      file,
      bytes: (await stat(join(paths.examples, file))).size,
      hasLabels,
      hasCache: await fileExists(join(paths.cache, `${slug}.wav`)),
      shotCount,
      complete,
    })
  }
  return index
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(payload)
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_UPLOAD_BYTES) {
        rejectPromise(new Error(`Payload exceeds ${MAX_UPLOAD_BYTES} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks)))
    req.on('error', rejectPromise)
  })
}

/** Streams a file, honouring a single `Range` header so `<video>` can seek. */
async function serveFile(req: IncomingMessage, res: ServerResponse, path: string, contentType: string): Promise<void> {
  const { size } = await stat(path)
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')

  if (range) {
    const startRaw = range[1]
    const endRaw = range[2]
    // A suffix range ("bytes=-500") asks for the final N bytes instead of an absolute offset.
    const start = startRaw === '' ? Math.max(0, size - Number(endRaw)) : Number(startRaw)
    const end = startRaw === '' || endRaw === '' ? size - 1 : Math.min(Number(endRaw), size - 1)

    if (!Number.isFinite(start) || start >= size || end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` })
      res.end()
      return
    }

    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    })
    createReadStream(path, { start, end }).pipe(res)
    return
  }

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  })
  createReadStream(path).pipe(res)
}

export function labelerServer(): Plugin {
  return {
    name: 'pewpew-labeler-server',
    apply: 'serve',
    configureServer(server) {
      const paths = resolvePaths(server.config.root)

      const handler: Connect.NextHandleFunction = (req, res, next) => {
        const url = req.url ?? ''
        if (!url.startsWith(`${API_PREFIX}/`)) {
          next()
          return
        }

        void (async () => {
          const [rawPath] = url.split('?')
          const segments = rawPath.slice(API_PREFIX.length + 1).split('/')
          const [route, encodedSlug] = segments
          // Slugs come straight back from our own index, so a mismatch means a bad request rather
          // than a path we should try to resolve on disk.
          const slug = encodedSlug ? decodeURIComponent(encodedSlug) : ''
          const clips = await buildClipIndex(paths)

          if (route === 'clips' && req.method === 'GET') {
            sendJson(res, 200, [...clips.values()])
            return
          }

          const clip = clips.get(slug)
          if (!clip) {
            sendJson(res, 404, { error: `Unknown clip "${slug}"` })
            return
          }

          if (route === 'media' && req.method === 'GET') {
            await serveFile(req, res, join(paths.examples, clip.file), 'video/mp4')
            return
          }

          if (route === 'labels' && req.method === 'GET') {
            try {
              const contents = await readFile(join(paths.labels, `${slug}.json`), 'utf8')
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
              res.end(contents)
            } catch {
              sendJson(res, 404, { error: 'No labels yet' })
            }
            return
          }

          if (route === 'labels' && req.method === 'PUT') {
            const body = await readBody(req)
            const parsed: unknown = JSON.parse(body.toString('utf8'))
            await mkdir(paths.labels, { recursive: true })
            await writeFile(join(paths.labels, `${slug}.json`), `${JSON.stringify(parsed, null, 2)}\n`)
            sendJson(res, 200, { ok: true, path: `labels/${slug}.json` })
            return
          }

          if (route === 'cache' && req.method === 'PUT') {
            const body = await readBody(req)
            await mkdir(paths.cache, { recursive: true })
            await writeFile(join(paths.cache, `${slug}.wav`), body)
            sendJson(res, 200, { ok: true, path: `examples/.cache/${slug}.wav`, bytes: body.length })
            return
          }

          sendJson(res, 405, { error: `Unsupported ${req.method} ${rawPath}` })
        })().catch((error: unknown) => {
          server.config.logger.error(`[labeler] ${String(error)}`)
          if (!res.headersSent) sendJson(res, 500, { error: String(error) })
          else res.end()
        })
      }

      server.middlewares.use(handler)
    },
  }
}
