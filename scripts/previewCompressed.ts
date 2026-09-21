/**
 * Local `dist/` serving that behaves like a real server: serves the pre-built `.br`/`.gz` files.
 *
 * WHY SEPARATE FROM `vite preview`. That one serves files as-is — no on-the-fly compression,
 * no pre-compressed copies alongside (verified: wasm arrives at the full 25.7 MB even with
 * `Accept-Encoding: br`). Python's `http.server` is even worse. So a plain local check shows
 * load speed THREE TIMES worse than the real thing, and it can't tell you how long a person
 * waits for the first analysis.
 *
 * Here the file choice is exactly what nginx does with `brotli_static`: if a `.br` sits
 * alongside and the browser said `Accept-Encoding: br`, that's what's served, with a
 * `Content-Encoding` header. Not a single file is compressed on the fly.
 *
 *   pnpm build && pnpm preview:compressed
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'

const ROOT = join(process.cwd(), 'dist')
const PORT = Number(process.env.PORT ?? 4173)

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
}

createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]
  let path = normalize(join(ROOT, decodeURIComponent(url)))
  // Without this check, `..` in the URL escapes the folder.
  if (!path.startsWith(ROOT)) {
    res.statusCode = 403
    return res.end('за пределами dist')
  }
  if (!existsSync(path) || statSync(path).isDirectory()) path = join(ROOT, 'index.html')

  res.setHeader('Content-Type', TYPES[extname(path)] ?? 'application/octet-stream')
  res.setHeader('Vary', 'Accept-Encoding')

  // Order matters: brotli is smaller, so it's checked first — nginx decides the same way.
  const accepts = req.headers['accept-encoding'] ?? ''
  for (const [encoding, suffix] of [['br', '.br'], ['gzip', '.gz']] as const) {
    if (accepts.includes(encoding) && existsSync(path + suffix)) {
      res.setHeader('Content-Encoding', encoding)
      res.setHeader('Content-Length', String(statSync(path + suffix).size))
      return createReadStream(path + suffix).pipe(res)
    }
  }
  res.setHeader('Content-Length', String(statSync(path).size))
  createReadStream(path).pipe(res)
}).listen(PORT, () => {
  console.log(`сборка на http://localhost:${PORT} — с пред-сжатием, как на настоящем сервере`)
})
