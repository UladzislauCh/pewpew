/**
 * Visual review of second-stage errors: frames around candidates where the motion model
 * was wrong, with its score and with what is actually there according to the labels.
 *
 * The material is laid out by `eval/errorReviewPrep.ts`, the page markup is `eval/errorReview.html`.
 *
 * The page is a browser one out of necessity, not convenience: frames come from WebCodecs,
 * which Node lacks. Nothing is recomputed — numbers come from the manifest, so that what is
 * on screen matches what the cases were selected by.
 *
 * THREE things are shown, and the third is not decoration:
 *  1. frames in a ±400 ms window (the model's summary window is ±250, the shape FFT window 32 frames);
 *  2. the kind of error and the truth according to the labels;
 *  3. the gameplay band and the "weapon" mask box over the frame. The mask was checked by eye
 *     on eight clips and lands on the streamer's webcam, smoke and editing captions, not on the
 *     weapon (docs/RESEARCH-journal.md, "IMPORTANT: the 'weapon' mask is not on the weapon"). While
 *     this holds, 22 features out of 74 measure the wrong thing, and they must be looked at in every case reviewed.
 */
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny'

interface ReviewCase {
  id: string
  slug: string
  time: number
  audio: number
  score: number
  kind: 'fp' | 'fn'
  truth: 'own' | 'enemy' | 'noise'
  nearest: { dtMs: number; source: 'own' | 'enemy' } | null
}

interface ReviewClip {
  slug: string
  clip: string
  duration: number
  ownShots: number
  sparse: boolean
  band: { y0: number; y1: number } | null
  maskBox: { x0: number; x1: number; y0: number; y1: number } | null
  maskPx: number | null
  totals: { candidates: number; fp: number; fn: number; kept: number }
}

interface ReviewManifest {
  threshold: number
  toleranceS: number
  frameOffsetsMs: number[]
  clips: ReviewClip[]
  cases: ReviewCase[]
}

/** Frame width in the internal canvas. It is smaller on screen but expands on click. */
const FRAME_W = 720
/** Geometry of the weapon band — the same as the model's: the mask was computed in a 320x140 crop. */
const WEAPON_W = 320
const WEAPON_H = 140

const NOTES_KEY = 'pewpew.errorReview.notes'

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`нет элемента #${id}`)
  return el
}

const notes: Record<string, string> = JSON.parse(localStorage.getItem(NOTES_KEY) ?? '{}')
const saveNotes = (): void => localStorage.setItem(NOTES_KEY, JSON.stringify(notes))

const TRUTH_RU: Record<ReviewCase['truth'], string> = {
  own: 'свой выстрел',
  enemy: 'чужой выстрел',
  noise: 'не выстрел',
}

/**
 * The nearest labelled shot, in words.
 *
 * Shown ALWAYS, not only for "not a shot": a distance of 63 ms and a distance of two
 * seconds are two completely different cases, yet their `truth` caption is the same.
 */
function nearestLabel(c: ReviewCase): string {
  if (!c.nearest) return 'размеченных выстрелов в клипе нет'
  const { dtMs, source } = c.nearest
  const who = source === 'own' ? 'свой' : 'чужой'
  const sign = dtMs > 0 ? '+' : ''
  const far = Math.abs(dtMs) > manifest.toleranceS * 1000
  return `ближайший размеченный — ${who} ${sign}${dtMs} мс${far ? ' (вне допуска)' : ''}`
}

let manifest: ReviewManifest
let overlayOn = true
/** One player per clip: for extra labels, "what is there instead of a shot" is a question for the ear. */
let player: HTMLVideoElement | null = null
let stopAt = 0
/** List buttons by slug: the "how many reviewed" mark updates as notes are entered. */
const clipButtons = new Map<string, HTMLElement>()

/**
 * Progress mark in the list. With 49 clips the review does not happen in one sitting,
 * and without it it is unclear where you stopped.
 */
function updateProgress(): void {
  for (const [slug, button] of clipButtons) {
    const cases = manifest.cases.filter((c) => c.slug === slug)
    const done = cases.filter((c) => (notes[c.id] ?? '').trim().length > 0).length
    const mark = button.querySelector('.done')
    if (!mark) continue
    mark.textContent = done ? `${done}/${cases.length}` : ''
    button.classList.toggle('complete', done === cases.length && cases.length > 0)
  }
}
/** Canvases of the current clip: kept so the boxes can be redrawn when toggling. */
let drawn: { canvas: HTMLCanvasElement; frame: ImageBitmap | HTMLCanvasElement; clip: ReviewClip }[] = []

/**
 * Boxes over the frame: the gameplay band and the mask box.
 *
 * Mask coordinates come in pixels of the 320x140 crop, and the crop itself is taken from the
 * `band` across the full frame width — so the reverse mapping goes through the fraction within the band.
 */
function drawOverlay(ctx: CanvasRenderingContext2D, clip: ReviewClip, w: number, h: number): void {
  if (!clip.band) return
  const bandY0 = clip.band.y0 * h
  const bandY1 = clip.band.y1 * h
  ctx.lineWidth = Math.max(1, w / 360)
  ctx.strokeStyle = 'rgba(90, 170, 255, 0.85)'
  ctx.strokeRect(0.5, bandY0, w - 1, bandY1 - bandY0)

  if (!clip.maskBox) return
  const bandH = bandY1 - bandY0
  const x0 = (clip.maskBox.x0 / WEAPON_W) * w
  const x1 = ((clip.maskBox.x1 + 1) / WEAPON_W) * w
  const y0 = bandY0 + (clip.maskBox.y0 / WEAPON_H) * bandH
  const y1 = bandY0 + ((clip.maskBox.y1 + 1) / WEAPON_H) * bandH
  ctx.strokeStyle = 'rgba(255, 170, 60, 0.95)'
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0)
}

function redrawAll(): void {
  for (const item of drawn) {
    const ctx = item.canvas.getContext('2d')
    if (!ctx) continue
    ctx.clearRect(0, 0, item.canvas.width, item.canvas.height)
    ctx.drawImage(item.frame, 0, 0, item.canvas.width, item.canvas.height)
    if (overlayOn) drawOverlay(ctx, item.clip, item.canvas.width, item.canvas.height)
  }
}

/** Enlarged view: the frame full screen, arrows page through frames of the same case. */
function openLightbox(canvases: HTMLCanvasElement[], index: number): void {
  const box = $('lightbox')
  const img = $('lightboxImage') as HTMLCanvasElement
  let i = index
  const show = (): void => {
    const src = canvases[i]
    img.width = src.width
    img.height = src.height
    const ctx = img.getContext('2d')
    ctx?.drawImage(src, 0, 0)
    $('lightboxLabel').textContent = `${i + 1} из ${canvases.length}   ${manifest.frameOffsetsMs[i] > 0 ? '+' : ''}${manifest.frameOffsetsMs[i]} мс`
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close()
    else if (e.key === 'ArrowRight') { i = Math.min(canvases.length - 1, i + 1); show() }
    else if (e.key === 'ArrowLeft') { i = Math.max(0, i - 1); show() }
  }
  const close = (): void => {
    box.style.display = 'none'
    window.removeEventListener('keydown', onKey)
  }
  box.style.display = 'flex'
  box.onclick = (e) => { if (e.target === box) close() }
  window.addEventListener('keydown', onKey)
  show()
}

/**
 * Plays the candidate's neighbourhood. Half a second before — to hear WHAT led to the sound
 * (footsteps, reload, a hit), not just the click itself.
 */
function playAround(time: number): void {
  if (!player) return
  player.pause()
  player.currentTime = Math.max(0, time - 0.5)
  stopAt = time + 0.7
  void player.play()
}

function caseRow(c: ReviewCase, clip: ReviewClip): { row: HTMLElement; strip: HTMLElement } {
  const row = document.createElement('div')
  row.className = 'case'

  const head = document.createElement('div')
  head.className = 'head'
  const kindLabel = c.kind === 'fp' ? 'ЛИШНЯЯ МЕТКА' : 'СВОЙ ВЫСТРЕЛ ЗАРЕЗАН'
  head.innerHTML =
    `<span class="badge ${c.kind}">${kindLabel}</span>` +
    `<span class="truth">в допуске ${(manifest.toleranceS * 1000).toFixed(0)} мс: <b>${TRUTH_RU[c.truth]}</b></span>` +
    `<span class="near">${nearestLabel(c)}</span>` +
    `<span class="num">оценка движения <b>${c.score.toFixed(3)}</b> при пороге ${manifest.threshold}</span>` +
    `<span class="num">звук ${c.audio.toFixed(3)}</span>` +
    `<span class="num">${c.time.toFixed(2)} с</span>`
  const listen = document.createElement('button')
  listen.className = 'listen'
  listen.textContent = '▶ звук'
  listen.onclick = () => playAround(c.time)
  head.appendChild(listen)
  row.appendChild(head)

  const strip = document.createElement('div')
  strip.className = 'strip'
  row.appendChild(strip)

  const note = document.createElement('textarea')
  note.placeholder =
    c.kind === 'fp'
      ? 'Что в кадре говорит, что здесь НЕ свой выстрел? Что тут вместо него?'
      : 'По чему видно, что это ваш выстрел? Чего не хватило модели?'
  note.value = notes[c.id] ?? ''
  note.oninput = () => {
    notes[c.id] = note.value
    saveNotes()
    row.classList.toggle('noted', note.value.trim().length > 0)
    updateProgress()
  }
  row.classList.toggle('noted', note.value.trim().length > 0)
  row.appendChild(note)

  void clip
  return { row, strip }
}

async function loadClip(clip: ReviewClip): Promise<void> {
  const host = $('cases')
  host.innerHTML = ''
  drawn = []
  $('status').textContent = `${clip.slug}: загружаю клип…`

  const cases = manifest.cases.filter((c) => c.slug === clip.slug)
  const strips = new Map<string, HTMLElement>()
  for (const c of cases) {
    const { row, strip } = caseRow(c, clip)
    host.appendChild(row)
    strips.set(c.id, strip)
  }

  const blob = await (await fetch(`/__review/${clip.slug}.mp4`)).blob()

  if (player) URL.revokeObjectURL(player.src)
  player = document.createElement('video')
  player.src = URL.createObjectURL(blob)
  player.preload = 'auto'
  player.ontimeupdate = () => {
    if (player && player.currentTime >= stopAt) player.pause()
  }

  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track || !(await track.canDecode())) throw new Error('видеодорожка не читается')
    const sink = new CanvasSink(track, { width: FRAME_W })

    // One pass in increasing time: mediabunny seeks on its own, and a list in random order
    // would make it jump back to keyframes.
    const wanted: { id: string; index: number; t: number }[] = []
    for (const c of cases) {
      manifest.frameOffsetsMs.forEach((ms, index) => {
        const t = Math.max(0, Math.min(clip.duration - 0.001, c.time + ms / 1000))
        wanted.push({ id: c.id, index, t })
      })
    }
    wanted.sort((a, b) => a.t - b.t)

    const perCase = new Map<string, HTMLCanvasElement[]>()
    let done = 0
    let i = 0
    for await (const result of sink.canvasesAtTimestamps(wanted.map((w) => w.t))) {
      const want = wanted[i++]
      done++
      if (done % 20 === 0) $('status').textContent = `${clip.slug}: кадр ${done} из ${wanted.length}`
      if (!result) continue

      const src = result.canvas as HTMLCanvasElement | OffscreenCanvas
      const canvas = document.createElement('canvas')
      canvas.width = src.width
      canvas.height = src.height
      const ctx = canvas.getContext('2d')
      if (!ctx) continue
      ctx.drawImage(src, 0, 0)

      // A copy of the frame without boxes: boxes are redrawn on top when the checkbox toggles.
      const clean = document.createElement('canvas')
      clean.width = src.width
      clean.height = src.height
      clean.getContext('2d')?.drawImage(src, 0, 0)
      if (overlayOn) drawOverlay(ctx, clip, canvas.width, canvas.height)
      drawn.push({ canvas, frame: clean, clip })

      const list = perCase.get(want.id) ?? []
      list[want.index] = canvas
      perCase.set(want.id, list)
    }

    for (const c of cases) {
      const strip = strips.get(c.id)
      const list = perCase.get(c.id)
      if (!strip || !list) continue
      const present = list.filter(Boolean)
      list.forEach((canvas, index) => {
        if (!canvas) return
        const cell = document.createElement('figure')
        cell.className = manifest.frameOffsetsMs[index] === 0 ? 'cell centre' : 'cell'
        canvas.onclick = () => openLightbox(present, present.indexOf(canvas))
        cell.appendChild(canvas)
        const cap = document.createElement('figcaption')
        const ms = manifest.frameOffsetsMs[index]
        cap.textContent = ms === 0 ? 'кандидат' : `${ms > 0 ? '+' : ''}${ms}`
        cell.appendChild(cap)
        strip.appendChild(cell)
      })
    }

    const t = clip.totals
    $('status').textContent =
      `${clip.slug} — своих ${clip.ownShots}, клип ${clip.sparse ? 'разреженный' : 'плотный'}. ` +
      `По клипу целиком: кандидатов ${t.candidates}, меток ${t.kept}, лишних ${t.fp}, зарезано своих ${t.fn}. ` +
      `Маска оружия ${clip.maskPx ?? 0} px.`
  } finally {
    input.dispose()
  }
}

function renderClipList(): void {
  const list = $('clips')
  for (const clip of manifest.clips) {
    const item = document.createElement('button')
    item.className = clip.sparse ? 'clip sparse' : 'clip'
    item.innerHTML =
      `<span class="name">${clip.slug}<span class="done"></span></span>` +
      `<span class="meta">своих ${clip.ownShots} · лишних ${clip.totals.fp} · зарезано ${clip.totals.fn}</span>`
    clipButtons.set(clip.slug, item)
    item.onclick = () => {
      for (const el of list.querySelectorAll('.clip')) el.classList.remove('active')
      item.classList.add('active')
      void loadClip(clip).catch((e) => {
        $('status').textContent = `ошибка: ${e instanceof Error ? e.message : String(e)}`
      })
    }
    list.appendChild(item)
  }
}

function downloadNotes(): void {
  const rows = manifest.cases
    .filter((c) => (notes[c.id] ?? '').trim().length > 0)
    .map((c) => ({ ...c, note: notes[c.id].trim() }))
  const blob = new Blob([JSON.stringify({ written: new Date().toISOString(), rows }, null, 2)], {
    type: 'application/json',
  })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'errorReview-notes.json'
  a.click()
  URL.revokeObjectURL(a.href)
}

async function main(): Promise<void> {
  const r = await fetch('/__review/manifest.json')
  if (!r.ok) {
    $('status').textContent = 'нет /__review/manifest.json — сначала pnpm exec tsx eval/errorReviewPrep.ts'
    return
  }
  manifest = (await r.json()) as ReviewManifest

  const totals = manifest.clips.reduce((a, c) => ({ fp: a.fp + c.totals.fp, fn: a.fn + c.totals.fn }), { fp: 0, fn: 0 })
  $('summary').textContent =
    `клипов ${manifest.clips.length}, к разбору ${manifest.cases.length} случаев ` +
    `(всего ошибок: лишних меток ${totals.fp}, зарезано кандидатов на своих выстрелах ${totals.fn})`

  renderClipList()
  updateProgress()
  ;($('overlay') as HTMLInputElement).onchange = (e) => {
    overlayOn = (e.target as HTMLInputElement).checked
    redrawAll()
  }
  $('download').onclick = downloadNotes

  const first = manifest.clips[0]
  if (first) {
    ;($('clips').querySelector('.clip') as HTMLElement | null)?.click()
  }
}

void main()
