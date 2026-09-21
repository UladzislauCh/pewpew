/**
 * Research material served under a URL, but OUTSIDE the build.
 *
 * WHY. These folders used to live in `public/`, and Vite copied them into `dist` whole,
 * following symlinks: the clip corpus ended up in the build SEVEN times, and the artifact
 * weighed 2.1 GB against 44 MB for the actual app.
 *
 * Here the same material lives in `fixtures/` and is only served by the dev server. URLs
 * didn't change (`/__ammo/...`, `/__models/...`), so every research page works exactly as
 * before, and nothing ships to prod.
 *
 * `/__models/` is three models needed ONLY by the motion stage, which isn't called from
 * the wizard. The product models stayed in `public/models/`.
 */
import { createReadStream, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import type { Plugin } from 'vite'

const ROOT = join(process.cwd(), 'fixtures')
const PREFIXES = ['__ammo', '__region', '__review', '__signal', '__stacks', '__test', '__viewmodel', '__weighted', '__models']

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wav': 'audio/wav',
  '.bin': 'application/octet-stream',
}

export function fixtureServer(): Plugin {
  return {
    name: 'pewpew-fixtures',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0]
        const prefix = PREFIXES.find((p) => url.startsWith(`/${p}/`))
        if (!prefix) return next()

        // `normalize` plus the prefix check: without it, `..` in the URL escapes the folder.
        const path = normalize(join(ROOT, decodeURIComponent(url)))
        if (!path.startsWith(ROOT)) {
          res.statusCode = 403
          return res.end('за пределами fixtures')
        }
        let size: number
        try {
          const stat = statSync(path)
          if (!stat.isFile()) return next()
          size = stat.size
        } catch {
          return next()
        }

        res.setHeader('Content-Type', TYPES[extname(path)] ?? 'application/octet-stream')
        // The browser fetches clips in chunks: without Range support, the frame-review
        // pages would rewind the whole file from the start on every seek.
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
        if (range) {
          const start = range[1] ? Number(range[1]) : 0
          const end = range[2] ? Number(range[2]) : size - 1
          res.statusCode = 206
          res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
          res.setHeader('Content-Length', String(end - start + 1))
          createReadStream(path, { start, end }).pipe(res)
          return
        }
        res.setHeader('Content-Length', String(size))
        res.setHeader('Accept-Ranges', 'bytes')
        createReadStream(path).pipe(res)
      })
    },
  }
}
