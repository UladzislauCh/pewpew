/**
 * Cuts screenshots for the "How it works" page — in two languages.
 *
 * WHY. Step images live in `public/{ru,en}/` and show the interface. The interface changes,
 * the images don't: by the time a step got renamed to "Check", the first image still had
 * the old green throw zone with a crosshair, which has been gone from the product for a
 * while. Reshooting by hand is eight screenshots with identical cropping in two languages,
 * and nobody's going to do that every time. Here it's done with a single command.
 *
 * HOW. A real headless Chrome over the debugger protocol: no third-party dependencies
 * needed, WebSocket is built into Node. The screenshot is cropped to the exact rectangle of
 * the NEEDED element (`Page.captureScreenshot` with `clip`), not cropped afterward by eye —
 * so the crop is identical and repeatable in both languages.
 *
 *   pnpm dev                      # needs the dev server: the clip is passed via ?clip=
 *   pnpm exec tsx scripts/pageShots.ts     # optional: --base=http://localhost:5173 --clip=slug
 */
import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9339
/** Corpus clip the steps are shot on: 22 seconds and a couple dozen shots. */
const DEFAULT_CLIP = 'ak47-dbf13655'
const LANGS = ['ru', 'en'] as const

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const BASE = arg('base', 'http://localhost:5173')
const CLIP = arg('clip', DEFAULT_CLIP)

/** Minimal debugger-protocol client: id → response, plus per-session routing. */
class Cdp {
  private socket!: WebSocket
  private nextId = 1
  private waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()

  static async connect(url: string): Promise<Cdp> {
    const cdp = new Cdp()
    cdp.socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      cdp.socket.addEventListener('open', () => resolve(), { once: true })
      cdp.socket.addEventListener('error', () => reject(new Error(`не подключиться: ${url}`)), { once: true })
    })
    cdp.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      const pending = message.id ? cdp.waiting.get(message.id) : undefined
      if (!pending) return
      cdp.waiting.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
    return cdp
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = this.nextId++
    this.socket.send(JSON.stringify({ id, method, params, sessionId }))
    return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }))
  }

  close(): void {
    this.socket.close()
  }
}

/** Evaluate an expression in the page and return its value. */
async function evaluate<T>(cdp: Cdp, session: string, expression: string): Promise<T> {
  const result = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    session,
  )
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'ошибка в странице')
  }
  return result.result.value as T
}

/**
 * Helpers available to the expressions below: wait for an element and compute the
 * combined rectangle of several. The combined one is needed when a screenshot spans
 * several blocks in a row — say, the track, transport controls, and the question on
 * the check screen.
 */
const HELPERS = `
  const wait = async (selector, timeoutMs = 180000) => {
    const started = Date.now()
    for (;;) {
      const found = document.querySelector(selector)
      if (found) return found
      if (Date.now() - started > timeoutMs) throw new Error('не дождались: ' + selector)
      await new Promise((r) => setTimeout(r, 150))
    }
  }
  // Padding around the crop: without it the value on the right («0.60 s») touches the
  // very edge and looks cut off, even though it fully fits.
  const PAD = 10
  const box = (...selectors) => {
    const rects = selectors.map((s) => {
      const el = document.querySelector(s)
      if (!el) throw new Error('нет элемента: ' + s)
      return el.getBoundingClientRect()
    })
    const left = Math.min(...rects.map((r) => r.left)) - PAD
    const top = Math.min(...rects.map((r) => r.top)) - PAD
    return {
      x: Math.max(0, left + scrollX),
      y: Math.max(0, top + scrollY),
      width: Math.max(...rects.map((r) => r.right)) + PAD - left,
      height: Math.max(...rects.map((r) => r.bottom)) + PAD - top,
    }
  }
`

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Screenshot of a block — as webp.
 *
 * The protocol returns png, and at 2x resolution ten screenshots weighed 3.8 MB. Brotli
 * doesn't compress png, so that's dead-weight page size; in webp the same screenshots take
 * 0.8 MB. Encoded by `cwebp` (homebrew: `brew install webp`) — a standard ffmpeg build has
 * no webp encoder.
 */
async function shoot(cdp: Cdp, session: string, rect: Rect, file: string): Promise<void> {
  const shot = await cdp.send(
    'Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: true, clip: { ...rect, scale: 2 } },
    session,
  )
  const png = `${file}.png`
  await writeFile(png, Buffer.from(shot.data, 'base64'))
  await new Promise<void>((resolve, reject) => {
    const encode = spawn('cwebp', ['-quiet', '-q', '82', png, '-o', file])
    encode.on('error', () => reject(new Error('нет cwebp: brew install webp')))
    encode.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('cwebp упал'))))
  })
  await rm(png, { force: true })
  console.log(`  ${file}  ${Math.round(rect.width)}×${Math.round(rect.height)} @2x`)
}

async function main(): Promise<void> {
  const probe = await fetch(BASE).catch(() => null)
  if (!probe?.ok) {
    console.error(`Нет dev-сервера на ${BASE}. Запустите «pnpm dev» и повторите.`)
    process.exit(1)
  }

  const profile = join(tmpdir(), `pewpew-shots-${Date.now()}`)
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--force-color-profile=srgb',
  ])
  chrome.on('error', (error) => {
    console.error('Chrome не запустился:', error.message)
    process.exit(1)
  })

  // The debugger port doesn't come up instantly.
  let version: { webSocketDebuggerUrl: string } | null = null
  for (let attempt = 0; attempt < 60 && !version; attempt++) {
    await new Promise((r) => setTimeout(r, 250))
    version = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      .then((r) => r.json() as Promise<{ webSocketDebuggerUrl: string }>)
      .catch(() => null)
  }
  if (!version) throw new Error('Chrome не отдал порт отладчика')

  const cdp = await Cdp.connect(version.webSocketDebuggerUrl)
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })

  await cdp.send('Page.enable', {}, sessionId)
  await cdp.send('Runtime.enable', {}, sessionId)
  // Width with margin around the 768 column: the column shouldn't touch the edges.
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 900, height: 1600, deviceScaleFactor: 2, mobile: false },
    sessionId,
  )

  const go = async (url: string) => {
    await cdp.send('Page.navigate', { url }, sessionId)
    await new Promise((r) => setTimeout(r, 400))
  }

  for (const lang of LANGS) {
    console.log(`\n${lang}:`)
    const dir = join('public', lang)
    await mkdir(dir, { recursive: true })

    // Language comes from localStorage: the app reads it under the same key on startup.
    await go(BASE)
    await evaluate(cdp, sessionId, `localStorage.setItem('pewpew.lang', ${JSON.stringify(lang)})`)

    // 1. Throw zone — without a clip in the URL.
    await go(BASE)
    const upload = await evaluate<Rect>(
      cdp,
      sessionId,
      `(async () => { ${HELPERS}; await wait('.dropzone-block'); await new Promise(r=>setTimeout(r,300)); return box('.dropzone-block') })()`,
    )
    await shoot(cdp, sessionId, upload, join(dir, '01-upload.webp'))

    // 2. Check: the clip is passed via the URL, then we wait for analysis to finish.
    //
    // Both answers must land in frame: without "yes, continue" and "no, fix it" the
    // screenshot doesn't show the main point — that the screen is asking a question. The
    // wizard's footer is sticky and on a tall window drifts down, leaving an empty gap in
    // the middle of the shot, so for the duration of the capture it's set to flow. It still
    // looks the same either way.
    await go(`${BASE}/?clip=${CLIP}`)
    const check = await evaluate<Rect>(
      cdp,
      sessionId,
      `(async () => { ${HELPERS}
        await wait('.check-shots__ask')
        const unstick = document.createElement('style')
        // The wizard column stretches to the full window height, and the footer is
        // pinned to its bottom: static alone isn't enough, otherwise a half-screen gap
        // would be left between the question and the buttons. Remove both the column's
        // stretch and the pinning.
        unstick.textContent = '.wizard { min-height: 0 } .wizard__main { flex: none } .wizard__footer { position: static; margin-top: 0 }'
        document.head.append(unstick)
        await new Promise(r=>setTimeout(r,600))
        return box('.onset-view', '.wizard__footer') })()`,
    )
    await shoot(cdp, sessionId, check, join(dir, '02-check.webp'))

    // 3. Fix: "no, fix it", then jump to the label — the reason the track zooms in.
    //    We wait for the window's move to finish, otherwise the shot catches it mid-way.
    const fix = await evaluate<Rect>(
      cdp,
      sessionId,
      `(async () => { ${HELPERS}
        document.querySelector('.wizard__secondary').click()
        await wait('.edit-shots__hop')
        document.querySelectorAll('.edit-shots__hop button')[1].click()
        await new Promise(r=>setTimeout(r,1400))
        document.querySelector('video').pause()
        return box('.onset-view', '.edit-shots__hint') })()`,
    )
    await shoot(cdp, sessionId, fix, join(dir, '03-fix.webp'))

    // 4. Meme: "done" from the fix step leads straight here.
    const sound = await evaluate<Rect>(
      cdp,
      sessionId,
      `(async () => { ${HELPERS}
        document.querySelector('.wizard__primary').click()
        await wait('.audio-source-picker__grid')
        await new Promise(r=>setTimeout(r,900))
        return box('.audio-source-picker') })()`,
    )
    await shoot(cdp, sessionId, sound, join(dir, '04-sound.webp'))

    // 5. Loot: summary and the meme-length slider — what gets adjusted on the last step.
    const loot = await evaluate<Rect>(
      cdp,
      sessionId,
      `(async () => { ${HELPERS}
        document.querySelector('.wizard__primary').click()
        await wait('.trim-slider')
        await new Promise(r=>setTimeout(r,900))
        return box('.preview__stat', '.trim-slider') })()`,
    )
    await shoot(cdp, sessionId, loot, join(dir, '05-loot.webp'))
  }

  cdp.close()
  chrome.kill()
  // Chrome keeps writing to the profile for a moment after the signal: without waiting,
  // cleanup fails with "directory not empty", after already capturing all the images.
  await new Promise((r) => setTimeout(r, 500))
  await rm(profile, { recursive: true, force: true }).catch(() => {})
  console.log('\nГотово.')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
