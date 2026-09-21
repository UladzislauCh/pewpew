/**
 * Human labelling of the weapon region: draw a box around the viewmodel on a frame.
 *
 * The material is laid out by `eval/weaponRegionPrep.ts`, the page markup is `eval/weaponRegion.html`.
 *
 * The page is a browser one out of necessity: frames come from WebCodecs, which Node lacks.
 *
 * Why the box is set by a human, not a heuristic. The auto-search for the region was checked
 * by eye on five clips in a row and misses differently each time: on `usp-0` it takes the whole
 * bottom strip of the frame (the streamer's webcam), on `ssg08` it sits in the left half with
 * the weapon on the right, on `awp` it spreads over a quarter of the frame. Telling the barrel
 * from the killfeed, nicknames and webcam by the criteria "pinned to screen + changing + has
 * texture" failed (`findViewmodel.mjs` in the journal), while a human's poke resolves the
 * ambiguity in one move.
 */
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny'

interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

interface RegionClip {
  slug: string
  clip: string
  duration: number
  ownShots: number
  sparse: boolean
  frameTimes: number[]
  autoBox: Box | null
  autoMaskPx: number | null
}

interface RegionManifest {
  clips: RegionClip[]
}

/** Labelling of one clip. `box === null` with `absent` is a legitimate state, not a gap. */
interface Marking {
  box: Box | null
  /** No weapon in the frame: cropped out, holstered for running, or the player is scoped in with a sniper. */
  absent: boolean
  note: string
}

const STORE_KEY = 'pewpew.weaponRegion.marks'
const FRAME_W = 960

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`нет элемента #${id}`)
  return el
}

const marks: Record<string, Marking> = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}')
const save = (): void => localStorage.setItem(STORE_KEY, JSON.stringify(marks))

let manifest: RegionManifest
let current: RegionClip | null = null
let frames: (HTMLCanvasElement | null)[] = []
let frameIndex = 0
/** Box in fractions of the frame. Fractions, not pixels: clips have different resolutions. */
let box: Box | null = null

/**
 * What the mouse is dragging. `draw` — a new box, `move` — move as a whole, the rest — a side or a corner.
 *
 * The mode is NOT called `new`: below, the side is determined via `includes('n')`, and the string
 * "new" contains "n", "e" and "w" — the box would move along three edges at once.
 */
type DragMode = 'draw' | 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se'

interface Drag {
  mode: DragMode
  from: { x: number; y: number }
  /** The box at drag start: edits are computed from it, not cumulatively. */
  start: Box
}

let drag: Drag | null = null

/**
 * Handle half-size in fractions of the frame's LONGER side.
 *
 * Not in screen pixels: `getBoundingClientRect()` on the canvas sometimes returns a degenerate
 * rectangle (measured — 2x2 with an actual 960x1707), and a handle computed from it blows up
 * to the whole frame. The canvas scales with its aspect ratio preserved, so a square in frame
 * coordinates stays a square on screen too.
 */
const HANDLE_FRAC = 0.009

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

/** Normalises the box to x0 < x1 and y0 < y1: a side can be dragged "through" the opposite one. */
function normalize(b: Box): Box {
  return {
    x0: Math.min(b.x0, b.x1),
    y0: Math.min(b.y0, b.y1),
    x1: Math.max(b.x0, b.x1),
    y1: Math.max(b.y0, b.y1),
  }
}

/** The box's eight handles in fractions of the frame. */
function handles(b: Box): { mode: DragMode; x: number; y: number }[] {
  const mx = (b.x0 + b.x1) / 2
  const my = (b.y0 + b.y1) / 2
  return [
    { mode: 'nw', x: b.x0, y: b.y0 },
    { mode: 'n', x: mx, y: b.y0 },
    { mode: 'ne', x: b.x1, y: b.y0 },
    { mode: 'e', x: b.x1, y: my },
    { mode: 'se', x: b.x1, y: b.y1 },
    { mode: 's', x: mx, y: b.y1 },
    { mode: 'sw', x: b.x0, y: b.y1 },
    { mode: 'w', x: b.x0, y: my },
  ]
}

/** Handle half-size in canvas pixels — the same on both axes, so the handle is square. */
function handlePx(canvas: HTMLCanvasElement): number {
  return Math.max(4, Math.round(Math.max(canvas.width, canvas.height) * HANDLE_FRAC))
}

/** Hit tolerance in fractions of the frame. It differs by axis: the frame is not square, and fractions are per side. */
function tolerance(): { tx: number; ty: number } {
  const canvas = $('view') as HTMLCanvasElement
  const px = handlePx(canvas)
  return { tx: px / Math.max(1, canvas.width), ty: px / Math.max(1, canvas.height) }
}

function hitTest(p: { x: number; y: number }): DragMode | null {
  if (!box) return null
  const { tx, ty } = tolerance()
  for (const h of handles(box)) {
    if (Math.abs(p.x - h.x) <= tx && Math.abs(p.y - h.y) <= ty) return h.mode
  }
  if (p.x > box.x0 && p.x < box.x1 && p.y > box.y0 && p.y < box.y1) return 'move'
  return null
}

const CURSORS: Record<DragMode, string> = {
  draw: 'crosshair',
  move: 'move',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
}

function applyDrag(p: { x: number; y: number }): void {
  if (!drag) return
  const dx = p.x - drag.from.x
  const dy = p.y - drag.from.y
  const s = drag.start

  if (drag.mode === 'draw') {
    box = normalize({ x0: drag.from.x, y0: drag.from.y, x1: p.x, y1: p.y })
    return
  }
  if (drag.mode === 'move') {
    // Moving does not change the size: the box stops at the frame edge as a whole.
    const w = s.x1 - s.x0
    const h = s.y1 - s.y0
    const x0 = Math.min(1 - w, Math.max(0, s.x0 + dx))
    const y0 = Math.min(1 - h, Math.max(0, s.y0 + dy))
    box = { x0, y0, x1: x0 + w, y1: y0 + h }
    return
  }

  const b = { ...s }
  if (drag.mode.includes('w')) b.x0 = clamp01(s.x0 + dx)
  if (drag.mode.includes('e')) b.x1 = clamp01(s.x1 + dx)
  if (drag.mode.includes('n')) b.y0 = clamp01(s.y0 + dy)
  if (drag.mode.includes('s')) b.y1 = clamp01(s.y1 + dy)
  box = normalize(b)
}

const clipButtons = new Map<string, HTMLElement>()

function markOf(slug: string): Marking {
  return marks[slug] ?? { box: null, absent: false, note: '' }
}

function updateClipList(): void {
  for (const [slug, button] of clipButtons) {
    const m = marks[slug]
    const done = Boolean(m && (m.box || m.absent))
    button.classList.toggle('done', done)
    const tag = button.querySelector('.state')
    if (tag) tag.textContent = !m ? '' : m.absent ? 'нет оружия' : m.box ? 'размечен' : ''
  }
  const done = manifest.clips.filter((c) => { const m = marks[c.slug]; return m && (m.box || m.absent) }).length
  $('progress').textContent = `размечено ${done} из ${manifest.clips.length}`
}

/** Draws the current frame, the heuristic box and the human box. */
function paint(): void {
  const canvas = $('view') as HTMLCanvasElement
  const frame = frames[frameIndex]
  const ctx = canvas.getContext('2d')
  if (!ctx || !frame || !current) return

  canvas.width = frame.width
  canvas.height = frame.height
  ctx.drawImage(frame, 0, 0)

  const { width: W, height: H } = canvas
  if (current.autoBox) {
    const a = current.autoBox
    ctx.setLineDash([6, 5])
    ctx.lineWidth = 2
    ctx.strokeStyle = 'rgba(255, 170, 60, 0.55)'
    ctx.strokeRect(a.x0 * W, a.y0 * H, (a.x1 - a.x0) * W, (a.y1 - a.y0) * H)
    ctx.setLineDash([])
  }
  if (box) {
    ctx.lineWidth = 3
    ctx.strokeStyle = 'rgba(90, 230, 130, 0.95)'
    ctx.strokeRect(box.x0 * W, box.y0 * H, (box.x1 - box.x0) * W, (box.y1 - box.y0) * H)
    // Dimming outside the box: it shows right away exactly what goes into the features.
    ctx.fillStyle = 'rgba(8, 10, 13, 0.55)'
    ctx.fillRect(0, 0, W, box.y0 * H)
    ctx.fillRect(0, box.y1 * H, W, H - box.y1 * H)
    ctx.fillRect(0, box.y0 * H, box.x0 * W, (box.y1 - box.y0) * H)
    ctx.fillRect(box.x1 * W, box.y0 * H, W - box.x1 * W, (box.y1 - box.y0) * H)

    const hp = handlePx(canvas)
    ctx.fillStyle = 'rgba(90, 230, 130, 0.95)'
    ctx.strokeStyle = 'rgba(8, 10, 13, 0.9)'
    ctx.lineWidth = 1
    for (const h of handles(box)) {
      ctx.fillRect(h.x * W - hp, h.y * H - hp, hp * 2, hp * 2)
      ctx.strokeRect(h.x * W - hp, h.y * H - hp, hp * 2, hp * 2)
    }
  }

  const area = box ? ((box.x1 - box.x0) * (box.y1 - box.y0) * 100).toFixed(1) : '—'
  $('boxInfo').textContent = box
    ? `рамка: x ${box.x0.toFixed(3)}–${box.x1.toFixed(3)}, y ${box.y0.toFixed(3)}–${box.y1.toFixed(3)} — ${area}% кадра`
    : 'рамка не поставлена'
}

/** Event coordinates in fractions of the frame, clamped to bounds. */
function atFraction(e: MouseEvent): { x: number; y: number } {
  const canvas = $('view') as HTMLCanvasElement
  const r = canvas.getBoundingClientRect()
  return {
    x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
  }
}

function renderFrameStrip(): void {
  const strip = $('frameStrip')
  strip.innerHTML = ''
  frames.forEach((frame, i) => {
    const button = document.createElement('button')
    button.className = i === frameIndex ? 'frameBtn active' : 'frameBtn'
    button.textContent = frame ? `кадр ${i + 1}` : `${i + 1} —`
    button.disabled = !frame
    button.onclick = () => {
      frameIndex = i
      renderFrameStrip()
      paint()
    }
    strip.appendChild(button)
  })
}

async function loadClip(clip: RegionClip): Promise<void> {
  current = clip
  frames = []
  frameIndex = 0
  const m = markOf(clip.slug)
  box = m.box
  drag = null
  ;($('absent') as HTMLInputElement).checked = m.absent
  ;($('note') as HTMLTextAreaElement).value = m.note
  $('status').textContent = `${clip.slug}: загружаю…`
  $('clipInfo').textContent =
    `своих выстрелов ${clip.ownShots}, клип ${clip.sparse ? 'разреженный' : 'плотный'}` +
    (clip.autoMaskPx ? `, эвристика нашла ${clip.autoMaskPx} px` : ', эвристика области не нашла')

  const blob = await (await fetch(`/__region/${clip.slug}.mp4`)).blob()
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track || !(await track.canDecode())) throw new Error('видеодорожка не читается')
    const sink = new CanvasSink(track, { width: FRAME_W })

    let i = 0
    for await (const result of sink.canvasesAtTimestamps(clip.frameTimes)) {
      const index = i++
      if (!result) {
        frames[index] = null
        continue
      }
      const src = result.canvas as HTMLCanvasElement | OffscreenCanvas
      const canvas = document.createElement('canvas')
      canvas.width = src.width
      canvas.height = src.height
      canvas.getContext('2d')?.drawImage(src, 0, 0)
      frames[index] = canvas
    }
    const first = frames.findIndex(Boolean)
    frameIndex = first < 0 ? 0 : first
    renderFrameStrip()
    paint()
    $('status').textContent = `${clip.slug} — обведите оружие мышью`
  } finally {
    input.dispose()
  }
}

function commit(): void {
  if (!current) return
  marks[current.slug] = {
    box,
    absent: ($('absent') as HTMLInputElement).checked,
    note: ($('note') as HTMLTextAreaElement).value.trim(),
  }
  save()
  updateClipList()
}

function selectClip(clip: RegionClip): void {
  for (const el of $('clips').querySelectorAll('.clip')) el.classList.remove('active')
  clipButtons.get(clip.slug)?.classList.add('active')
  void loadClip(clip).catch((e) => {
    $('status').textContent = `ошибка: ${e instanceof Error ? e.message : String(e)}`
  })
}

function step(delta: number): void {
  if (!current) return
  const i = manifest.clips.findIndex((c) => c.slug === current!.slug)
  const next = manifest.clips[i + delta]
  if (next) selectClip(next)
}

function download(): void {
  const regions: Record<string, unknown> = {}
  for (const clip of manifest.clips) {
    const m = marks[clip.slug]
    if (!m || (!m.box && !m.absent)) continue
    regions[clip.slug] = m.absent ? { absent: true, note: m.note } : { ...m.box, note: m.note }
  }
  const blob = new Blob([JSON.stringify({ written: new Date().toISOString(), regions }, null, 2)], {
    type: 'application/json',
  })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'weaponRegions.json'
  a.click()
  URL.revokeObjectURL(a.href)
}

async function main(): Promise<void> {
  const r = await fetch('/__region/manifest.json')
  if (!r.ok) {
    $('status').textContent = 'нет /__region/manifest.json — сначала pnpm exec tsx eval/weaponRegionPrep.ts'
    return
  }
  manifest = (await r.json()) as RegionManifest

  const list = $('clips')
  for (const clip of manifest.clips) {
    const item = document.createElement('button')
    item.className = clip.sparse ? 'clip sparse' : 'clip'
    item.innerHTML = `<span class="name">${clip.slug}</span><span class="state"></span>`
    item.onclick = () => selectClip(clip)
    clipButtons.set(clip.slug, item)
    list.appendChild(item)
  }

  const canvas = $('view') as HTMLCanvasElement
  canvas.onmousedown = (e) => {
    const from = atFraction(e)
    const hit = hitTest(from)
    // Hit an existing box — edit it. Missed — draw a new one.
    const mode: DragMode = hit ?? 'draw'
    const start: Box = box ?? { x0: from.x, y0: from.y, x1: from.x, y1: from.y }
    drag = { mode, from, start }
    if (mode === 'draw') box = null
    paint()
  }
  canvas.onmousemove = (e) => {
    const p = atFraction(e)
    if (!drag) {
      canvas.style.cursor = CURSORS[hitTest(p) ?? 'draw']
      return
    }
    applyDrag(p)
    paint()
  }
  const finish = (): void => {
    if (!drag) return
    const wasDraw = drag.mode === 'draw'
    drag = null
    // A stray click off the box does not create it; a stray click ON the box does not erase it.
    if (wasDraw && box && (box.x1 - box.x0 < 0.01 || box.y1 - box.y0 < 0.01)) box = null
    paint()
    commit()
  }
  canvas.onmouseup = finish
  canvas.onmouseleave = finish

  $('clear').onclick = () => {
    box = null
    paint()
    commit()
  }
  $('prev').onclick = () => step(-1)
  $('next').onclick = () => step(1)
  $('download').onclick = download
  ;($('absent') as HTMLInputElement).onchange = commit
  ;($('note') as HTMLTextAreaElement).oninput = commit

  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement)?.tagName === 'TEXTAREA') return
    if (e.key === 'ArrowRight') step(1)
    else if (e.key === 'ArrowLeft') step(-1)
    else if (e.key >= '1' && e.key <= '6') {
      const i = Number(e.key) - 1
      if (frames[i]) {
        frameIndex = i
        renderFrameStrip()
        paint()
      }
    }
  })

  updateClipList()
  const first = manifest.clips[0]
  if (first) selectClip(first)
}

void main()
