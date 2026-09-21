/**
 * Pre-compresses the built static files: .br and .gz next to the original.
 *
 * WHY AHEAD OF TIME, NOT ON THE FLY. Brotli at level 11 — the level that gives real
 * savings — takes about thirty seconds to compress a 25 MB wasm file. Doing that on every
 * request is out of the question, and many static-file servers (nginx with
 * `gzip_static`/`brotli_static`, Caddy with `precompressed`, most CDNs) can simply SERVE a
 * pre-built `.br`/`.gz` if it sits alongside — then the server compresses nothing at all,
 * it just picks the file based on the `Accept-Encoding` header.
 *
 * WHAT GETS COMPRESSED. Text formats and wasm — where the browser's `Accept-Encoding: br`
 * header actually pays off. Files below the threshold are left alone: on a couple hundred
 * bytes, the compression headers themselves eat the gain.
 *
 * WHAT DOESN'T. `flashNet416*.onnx` — model weights are high-entropy by construction,
 * brotli at level 9 only gets 11.7 -> 10.6 MB, and an honest level-11 run on 12 MB of
 * weights would hold up the build noticeably longer for a percent or two. Images are
 * already webp or squeezed during prep — same story, a fraction of a percent.
 *
 * The server has to decide on its own which file to serve: set up `gzip_static`/
 * `brotli_static` (nginx), `precompressed` (Caddy), or the equivalent. Without that
 * config, the .br/.gz files just sit there unused — they don't replace the original.
 */
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

const DIST = join(process.cwd(), 'dist')
const COMPRESSIBLE = new Set(['.js', '.css', '.html', '.json', '.svg', '.wasm', '.txt'])
const MIN_SIZE = 1024

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}

function main(): void {
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(DIST)
  } catch {
    console.error('dist/ не найден — сначала сборка')
    process.exitCode = 1
    return
  }
  if (!stat.isDirectory()) return

  const targets = walk(DIST).filter(
    (p) => COMPRESSIBLE.has(extname(p)) && statSync(p).size >= MIN_SIZE,
  )

  let rawTotal = 0
  let brTotal = 0
  for (const path of targets) {
    const buf = readFileSync(path)
    rawTotal += buf.length

    const gz = gzipSync(buf, { level: 9 })
    writeFileSync(`${path}.gz`, gz)

    // The big wasm file is the only one where level 11 costs tens of seconds; for it,
    // that's a one-time build cost, not a runtime one, and the savings are nearly 7x (see header).
    const br = brotliCompressSync(buf, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    })
    writeFileSync(`${path}.br`, br)
    brTotal += br.length
  }

  console.log(
    `сжато файлов ${targets.length}: ${(rawTotal / 1048576).toFixed(1)} МБ -> ` +
      `${(brTotal / 1048576).toFixed(1)} МБ brotli (${targets.length ? Math.round((100 * brTotal) / rawTotal) : 0}%)`,
  )
}

main()
