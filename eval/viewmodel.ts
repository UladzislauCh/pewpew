/**
 * Automatic weapon-region search: splits the frame into "moves with the scene" and "pinned to
 * the screen", then among the pinned looks for what moves at audio-candidate moments.
 *
 * The material is laid out by `eval/viewmodelPrep.ts`, the check against the human is `eval/viewmodelEval.ts`.
 *
 * Four pitfalls from the journal that the previous attempt stepped on, and what is done differently here:
 *
 *  1. THE PER-BLOCK MEDIAN SHIFT IS NOT THE SCENE SHIFT. There are two populations (pinned at zero
 *     and the scene), and the component-wise median lands BETWEEN them: on one frame 269 blocks
 *     were at (0,0), the scene was around (4,−3), the median gave (0,−2) and zero matches with either.
 *     Here the MODE of the joint distribution is taken.
 *  2. THE "SCENE" AND "PINNED" THRESHOLDS OVERLAP at small shifts. Here the hypothesis is chosen
 *     EXCLUSIVELY: whichever is closer — zero or the scene shift; a tie counts for neither.
 *  3. A STRICT ZERO SELECTS ONLY UI. The viewmodel sways, so "exactly 0" yields banners and
 *     black bars. Here there is a tolerance, plus weeding out "dead" blocks by variability.
 *  4. ABSOLUTE THRESHOLDS DO NOT TRANSFER between videos. Here everything possible is computed as
 *     fractions and percentiles within the clip; frame selection too — by the scene shift magnitude.
 */
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny'
import { sampleGrayFrame } from '../src/domain/detection/motion/motionFeatures'
import { saveResult } from './saveResult'

interface ViewmodelEntry {
  slug: string
  duration: number
  frames: number
  fps: number
  pickedFrames: number[]
  candidates: number[]
}

/** The frame is reduced to a square — human boxes are also given in fractions, so the scale is shared. */
const FRAME = 256
const BLOCK = 16
const GRID = FRAME / BLOCK
const MAX_SHIFT = 6
/** "Shift matched" tolerance: the viewmodel sways, and a strict zero selects only UI. */
const TOL = 1.5

/** Result for one grid block. Everything is fractions and ratios, no absolute magnitudes here. */
interface BlockStats {
  /** Share of analysed frames where the block stayed put despite scene motion. */
  pinned: number
  /** Share where the block moved with the scene. */
  scene: number
  /** Median of the absolute frame difference — whether the block is "alive" at all. */
  activity: number
  /** Frame difference at candidate moments divided by the usual one. The weapon jerks, the killfeed does not. */
  reacts: number
}

const log = (line: string): void => {
  const out = document.getElementById('out')
  if (out) out.textContent += line + '\n'
  window.scrollTo(0, document.body.scrollHeight)
}

/** Mean absolute block difference at shift (sx, sy). Every other pixel — twice as fast. */
function blockCost(
  data: Uint8Array, prev: number, cur: number, bx: number, by: number, sx: number, sy: number,
): number {
  const a = prev * FRAME * FRAME
  const b = cur * FRAME * FRAME
  let sum = 0
  let n = 0
  for (let y = by; y < by + BLOCK; y += 2) {
    const ty = y + sy
    if (ty < 0 || ty >= FRAME) continue
    for (let x = bx; x < bx + BLOCK; x += 2) {
      const tx = x + sx
      if (tx < 0 || tx >= FRAME) continue
      sum += Math.abs(data[a + ty * FRAME + tx] - data[b + y * FRAME + x])
      n++
    }
  }
  return n ? sum / n : Infinity
}

/** Best block shift within MAX_SHIFT. */
function blockShift(data: Uint8Array, prev: number, cur: number, bx: number, by: number): { dx: number; dy: number } {
  let best = Infinity
  let dx = 0
  let dy = 0
  for (let sy = -MAX_SHIFT; sy <= MAX_SHIFT; sy++) {
    for (let sx = -MAX_SHIFT; sx <= MAX_SHIFT; sx++) {
      const c = blockCost(data, prev, cur, bx, by, sx, sy)
      if (c < best) { best = c; dx = sx; dy = sy }
    }
  }
  return { dx, dy }
}

/**
 * Scene shift as the MODE of the joint distribution of block shifts.
 *
 * Not the median: there are two populations, and the median lands between them. The mode is
 * taken over non-empty cells, and the zero cell is excluded — that is where the pinned stuff sits.
 */
function sceneShift(shifts: { dx: number; dy: number }[]): { dx: number; dy: number } | null {
  const counts = new Map<string, number>()
  for (const s of shifts) {
    if (Math.abs(s.dx) <= TOL && Math.abs(s.dy) <= TOL) continue
    const key = `${s.dx},${s.dy}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let bestKey: string | null = null
  let bestN = 0
  for (const [k, n] of counts) if (n > bestN) { bestN = n; bestKey = k }
  // The mode must be a real population, not a stray block.
  if (!bestKey || bestN < shifts.length * 0.06) return null
  const [dx, dy] = bestKey.split(',').map(Number)
  return { dx, dy }
}

async function analyse(entry: ViewmodelEntry): Promise<BlockStats[] | null> {
  const blob = await (await fetch(`/__viewmodel/${entry.slug}.mp4`)).blob()
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track || !(await track.canDecode())) throw new Error('видеодорожка не читается')
    const sink = new CanvasSink(track, { poolSize: 1 })

    const picked = new Set(entry.pickedFrames)
    const candFrames = new Set(entry.candidates.map((t) => Math.round(t * entry.fps)))
    const area = FRAME * FRAME
    const pair = new Uint8Array(area * 2)
    const nBlocks = GRID * GRID

    const pinned = new Float64Array(nBlocks)
    const scene = new Float64Array(nBlocks)
    let analysed = 0
    const diffAll: number[][] = Array.from({ length: nBlocks }, () => [])
    const diffCand: number[][] = Array.from({ length: nBlocks }, () => [])

    let index = 0
    let havePrev = false
    for await (const result of sink.canvases()) {
      if (!result) continue
      const canvas = result.canvas as HTMLCanvasElement | OffscreenCanvas
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | null
      if (!ctx) continue
      const { width, height } = canvas
      const rgba = ctx.getImageData(0, 0, width, height).data
      const slot = index % 2
      sampleGrayFrame(rgba, width, height, { x0: 0, y0: 0, x1: 1, y1: 1 }, FRAME, FRAME, pair, slot * area)

      if (havePrev) {
        const prev = 1 - slot
        // Block difference is needed on EVERY frame: both "liveness" and candidate response rely on it.
        const nearCandidate = candFrames.has(index) || candFrames.has(index - 1) || candFrames.has(index + 1)
        for (let b = 0; b < nBlocks; b++) {
          const bx = (b % GRID) * BLOCK
          const by = ((b / GRID) | 0) * BLOCK
          const d = blockCost(pair, prev, slot, bx, by, 0, 0)
          diffAll[b].push(d)
          if (nearCandidate) diffCand[b].push(d)
        }

        if (picked.has(index)) {
          const shifts: { dx: number; dy: number }[] = []
          for (let b = 0; b < nBlocks; b++) {
            const bx = (b % GRID) * BLOCK
            const by = ((b / GRID) | 0) * BLOCK
            shifts.push(blockShift(pair, prev, slot, bx, by))
          }
          const sc = sceneShift(shifts)
          if (sc) {
            analysed++
            for (let b = 0; b < nBlocks; b++) {
              const s = shifts[b]
              const toZero = Math.hypot(s.dx, s.dy)
              const toScene = Math.hypot(s.dx - sc.dx, s.dy - sc.dy)
              // The hypothesis is chosen exclusively; a tie counts for neither.
              if (toZero + TOL < toScene) pinned[b]++
              else if (toScene + TOL < toZero) scene[b]++
            }
          }
        }
      }
      havePrev = true
      index++
    }

    if (!analysed) return null
    const median = (v: number[]): number => {
      if (!v.length) return 0
      const s = [...v].sort((a, b) => a - b)
      return s[s.length >> 1]
    }
    return Array.from({ length: nBlocks }, (_, b) => {
      const base = median(diffAll[b])
      return {
        pinned: pinned[b] / analysed,
        scene: scene[b] / analysed,
        activity: base,
        reacts: diffCand[b].length ? median(diffCand[b]) / Math.max(0.5, base) : 1,
      }
    })
  } finally {
    input.dispose()
  }
}

async function main(): Promise<void> {
  const r = await fetch('/__viewmodel/manifest.json')
  if (!r.ok) {
    log('нет /__viewmodel/manifest.json — сначала pnpm exec tsx eval/viewmodelPrep.ts')
    return
  }
  const { entries } = (await r.json()) as { framesUsed: number; entries: ViewmodelEntry[] }
  log(`клипов ${entries.length}, сетка ${GRID}x${GRID} блоков по ${BLOCK} px, кадр ${FRAME}x${FRAME}`)
  log('')

  const out: Record<string, BlockStats[] | null> = {}
  const started = performance.now()
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const t0 = performance.now()
    try {
      out[e.slug] = await analyse(e)
      const n = out[e.slug]?.filter((b) => b.pinned > 0.5).length ?? 0
      log(
        `${String(i + 1).padStart(2)}/${entries.length} ${e.slug.slice(0, 40).padEnd(42)} ` +
          `прибитых блоков ${String(n).padStart(3)}, ${((performance.now() - t0) / 1000).toFixed(1)} с`,
      )
    } catch (error) {
      out[e.slug] = null
      log(`${String(i + 1).padStart(2)}/${entries.length} ${e.slug.slice(0, 40).padEnd(42)} ОШИБКА: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  log('')
  log(`готово за ${((performance.now() - started) / 1000 / 60).toFixed(1)} мин`)

  log(await saveResult('viewmodelBlocks.json', JSON.stringify({ frame: FRAME, block: BLOCK, grid: GRID, clips: out }), 'application/json'))
}

void main()
