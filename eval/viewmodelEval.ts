/**
 * Checks automatic weapon-region search against boxes labelled by a human.
 *
 *   pnpm exec tsx eval/viewmodelEval.ts            # expects eval/.cache/viewmodelBlocks.json
 *   pnpm exec tsx eval/viewmodelEval.ts --sweep    # sweep block-selection thresholds
 *
 * The judge here is IoU with `eval/weaponRegions.json`, NOT detection quality on the same
 * candidates. The third selection criterion ("the block moves at candidate moments") uses the
 * candidates, so measuring the result with them would measure peeking.
 *
 * Separately it counts "did the centre of the found region land inside the human one": for
 * features, not missing the weapon matters more than matching by area. The heuristic that
 * is in prod now gives a median IoU of 0.065 and misses on 31 clips out of 46 — that is the
 * bar to beat.
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PROJECT_ROOT } from './fixtures'

const BLOCKS_PATH = join(PROJECT_ROOT, 'eval/.cache/viewmodelBlocks.json')
const REGIONS_PATH = join(PROJECT_ROOT, 'eval/weaponRegions.json')

interface BlockStats { pinned: number; scene: number; activity: number; reacts: number }
interface Rect { x0: number; y0: number; x1: number; y1: number }

interface Params {
  /** Minimum share of frames where the block stayed put despite scene motion. */
  minPinned: number
  /** Within-clip "liveness" percentile: below it a block counts as a dead field. */
  aliveQ: number
  /** Which share of the remaining blocks to keep by response to candidates. */
  reactTop: number
}

function quantile(v: number[], q: number): number {
  if (!v.length) return 0
  const s = [...v].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]
}

/** Largest connected region of the selected blocks, 4-neighbour traversal. */
function largestComponent(sel: boolean[], grid: number): number[] {
  const seen = new Array<boolean>(sel.length).fill(false)
  let best: number[] = []
  for (let s = 0; s < sel.length; s++) {
    if (!sel[s] || seen[s]) continue
    const comp: number[] = []
    const stack = [s]
    seen[s] = true
    while (stack.length) {
      const p = stack.pop() as number
      comp.push(p)
      const x = p % grid
      const y = (p / grid) | 0
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= grid || ny >= grid) continue
        const q = ny * grid + nx
        if (sel[q] && !seen[q]) { seen[q] = true; stack.push(q) }
      }
    }
    if (comp.length > best.length) best = comp
  }
  return best
}

function detect(blocks: BlockStats[], grid: number, p: Params): Rect | null {
  const alive = quantile(blocks.map((b) => b.activity), p.aliveQ)
  const eligible = blocks.map((b) => b.pinned >= p.minPinned && b.activity > alive)
  const idx = eligible.map((ok, i) => (ok ? i : -1)).filter((i) => i >= 0)
  if (idx.length < 2) return null

  // Response to candidates — the third criterion, absent from the previous attempt:
  // the killfeed and nicknames are pinned to the screen just the same but do not move at shot moments.
  const cut = quantile(idx.map((i) => blocks[i].reacts), 1 - p.reactTop)
  const sel = blocks.map((b, i) => eligible[i] && b.reacts >= cut)
  const comp = largestComponent(sel, grid)
  if (comp.length < 2) return null

  let x0 = grid, x1 = -1, y0 = grid, y1 = -1
  for (const b of comp) {
    const x = b % grid
    const y = (b / grid) | 0
    x0 = Math.min(x0, x); x1 = Math.max(x1, x)
    y0 = Math.min(y0, y); y1 = Math.max(y1, y)
  }
  return { x0: x0 / grid, y0: y0 / grid, x1: (x1 + 1) / grid, y1: (y1 + 1) / grid }
}

const area = (r: Rect): number => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0)
function iou(a: Rect, b: Rect): number {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0))
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0))
  const inter = ix * iy
  const union = area(a) + area(b) - inter
  return union > 0 ? inter / union : 0
}
const centreInside = (found: Rect, truth: Rect): boolean => {
  const cx = (found.x0 + found.x1) / 2
  const cy = (found.y0 + found.y1) / 2
  return cx >= truth.x0 && cx <= truth.x1 && cy >= truth.y0 && cy <= truth.y1
}

/**
 * Learned block selection instead of thresholds.
 *
 * Threshold selection was built on a criterion from the journal — "the block does not move
 * with the camera". A measurement over 46 human boxes rules that criterion out: the AUC of
 * "block inside the box" for `pinned` = 0.528, i.e. a coin toss. The other three work:
 *
 *   activity ("simply the most changing block")    0.710
 *   reacts   ("moves at candidate moments")        0.685
 *   neither  ("moves, but NOT with the scene")     0.631
 *
 * So blocks are labelled by human boxes and classified by logistic regression, and
 * validation uses folds BY CLIP: otherwise the model would learn where the weapon is
 * in this particular video.
 */
function trainBlocks(rows: number[][], y: number[], steps = 2500, lr = 0.5): number[] {
  const d = rows[0].length
  const w = new Array<number>(d + 1).fill(0)
  const nPos = y.filter((v) => v === 1).length || 1
  const wPos = y.length / (2 * nPos)
  const wNeg = y.length / (2 * Math.max(1, y.length - nPos))
  for (let step = 0; step < steps; step++) {
    const g = new Array<number>(d + 1).fill(0)
    let total = 0
    for (let i = 0; i < rows.length; i++) {
      let z = w[d]
      for (let j = 0; j < d; j++) z += w[j] * rows[i][j]
      const p = 1 / (1 + Math.exp(-z))
      const cw = y[i] === 1 ? wPos : wNeg
      const e = cw * (p - y[i])
      for (let j = 0; j < d; j++) g[j] += e * rows[i][j]
      g[d] += e
      total += cw
    }
    for (let j = 0; j <= d; j++) w[j] -= (lr * g[j]) / total
  }
  return w
}

const predictBlock = (w: number[], x: number[]): number => {
  let z = w[x.length]
  for (let j = 0; j < x.length; j++) z += w[j] * x[j]
  return 1 / (1 + Math.exp(-z))
}

/** Rank within the clip, 0..1. Absolute levels do not transfer between videos. */
function ranks(v: number[]): number[] {
  const order = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0])
  const out = new Array<number>(v.length).fill(0)
  order.forEach(([, i], k) => { out[i] = k / Math.max(1, v.length - 1) })
  return out
}

async function main(): Promise<void> {
  if (!existsSync(BLOCKS_PATH)) {
    console.log(`нет ${BLOCKS_PATH}`)
    console.log('Сначала: pnpm exec tsx eval/viewmodelPrep.ts, затем /eval/viewmodel.html,')
    console.log('и положить скачанный viewmodelBlocks.json в eval/.cache/')
    return
  }
  const data = JSON.parse(await readFile(BLOCKS_PATH, 'utf8')) as {
    grid: number
    clips: Record<string, BlockStats[] | null>
  }
  const regions = JSON.parse(await readFile(REGIONS_PATH, 'utf8')).regions as Record<string, Rect & { absent?: boolean; note?: string }>

  const truthOf = (slug: string): Rect | null => {
    const r = regions[slug]
    return !r || r.absent ? null : { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 }
  }

  const run = (p: Params) => {
    const ious: number[] = []
    let hit = 0
    let found = 0
    let total = 0
    const rows: { slug: string; iou: number; found: Rect | null; truth: Rect }[] = []
    for (const [slug, blocks] of Object.entries(data.clips)) {
      const truth = truthOf(slug)
      if (!truth || !blocks) continue
      total++
      const box = detect(blocks, data.grid, p)
      if (box) found++
      const v = box ? iou(box, truth) : 0
      ious.push(v)
      if (box && centreInside(box, truth)) hit++
      rows.push({ slug, iou: v, found: box, truth })
    }
    ious.sort((a, b) => a - b)
    return {
      p,
      total,
      found,
      median: ious[ious.length >> 1] ?? 0,
      mean: ious.reduce((a, b) => a + b, 0) / Math.max(1, ious.length),
      miss: ious.filter((v) => v < 0.2).length,
      centre: hit,
      rows,
    }
  }

  if (process.argv.includes('--sweep')) {
    console.log('перебор порогов отбора блоков (судья — IoU с рамками человека)')
    console.log()
    console.log('  minPinned'.padEnd(12), 'aliveQ'.padStart(7), 'reactTop'.padStart(9), 'медиана IoU'.padStart(12), 'центр внутри'.padStart(13), 'мимо'.padStart(6))
    console.log('  ' + '-'.repeat(64))
    let best = run({ minPinned: 0.5, aliveQ: 0.4, reactTop: 0.3 })
    for (const minPinned of [0.4, 0.55, 0.7, 0.85]) {
      for (const aliveQ of [0.3, 0.5, 0.7]) {
        for (const reactTop of [0.15, 0.3, 0.5]) {
          const r = run({ minPinned, aliveQ, reactTop })
          if (r.median > best.median) best = r
          console.log(
            `  ${String(minPinned).padEnd(10)}`, String(aliveQ).padStart(7), String(reactTop).padStart(9),
            r.median.toFixed(3).padStart(12), `${r.centre}/${r.total}`.padStart(13), String(r.miss).padStart(6),
          )
        }
      }
    }
    console.log()
    console.log(`лучшее: minPinned ${best.p.minPinned}, aliveQ ${best.p.aliveQ}, reactTop ${best.p.reactTop} → медиана IoU ${best.median.toFixed(3)}`)
    return
  }

  if (process.argv.includes('--learn')) {
    const withPos = !process.argv.includes('--nopos')
    const clips = Object.entries(data.clips).filter(([slug, b]) => b && truthOf(slug)) as [string, BlockStats[]][]
    const grid = data.grid

    const featuresOf = (blocks: BlockStats[]): number[][] => {
      const act = ranks(blocks.map((b) => b.activity))
      const rea = ranks(blocks.map((b) => b.reacts))
      const nei = blocks.map((b) => Math.max(0, 1 - b.pinned - b.scene))
      return blocks.map((b, i) => {
        const x = (i % grid + 0.5) / grid
        const y = ((i / grid | 0) + 0.5) / grid
        const base = [act[i], rea[i], nei[i], b.pinned, b.scene]
        return withPos ? [...base, x, y, x * y] : base
      })
    }

    const labelsOf = (slug: string, blocks: BlockStats[]): number[] => {
      const t = truthOf(slug)!
      return blocks.map((_, i) => {
        const x = (i % grid + 0.5) / grid
        const y = ((i / grid | 0) + 0.5) / grid
        return x >= t.x0 && x <= t.x1 && y >= t.y0 && y <= t.y1 ? 1 : 0
      })
    }

    const FOLDS = 5
    /** Boxes found by a model that has NOT SEEN this clip. These are what the end-to-end measurement must check. */
    const autoBoxes: Record<string, Rect> = {}
    /**
     * Per-block probabilities from the same model — a weight map instead of a rectangle.
     *
     * A rectangle throws away everything the classifier knows: a block with probability 0.9
     * and a block with 0.3 inside the box weigh the same, and outside the box both weigh zero.
     * Hence scheme D not surviving auto-search — what hurts it is not the box size but the background inside.
     */
    const blockWeights: Record<string, number[]> = {}
    const ious: number[] = []
    let centreHits = 0
    const rows: { slug: string; iou: number }[] = []
    for (let k = 0; k < FOLDS; k++) {
      const train = clips.filter((_, i) => i % FOLDS !== k)
      const test = clips.filter((_, i) => i % FOLDS === k)
      const X: number[][] = []
      const Y: number[] = []
      for (const [slug, blocks] of train) { X.push(...featuresOf(blocks)); Y.push(...labelsOf(slug, blocks)) }
      const w = trainBlocks(X, Y)

      for (const [slug, blocks] of test) {
        const truth = truthOf(slug)!
        const p = featuresOf(blocks).map((f) => predictBlock(w, f))
        // Keep blocks above the clip's 75th percentile, then the largest connected region.
        const cut = quantile(p, 0.75)
        const comp = largestComponent(p.map((v) => v >= cut), grid)
        let box: Rect | null = null
        if (comp.length >= 2) {
          let x0 = grid, x1 = -1, y0 = grid, y1 = -1
          for (const b of comp) {
            const x = b % grid, y = (b / grid) | 0
            x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
          }
          box = { x0: x0 / grid, y0: y0 / grid, x1: (x1 + 1) / grid, y1: (y1 + 1) / grid }
        }
        const v = box ? iou(box, truth) : 0
        ious.push(v)
        if (box && centreInside(box, truth)) centreHits++
        rows.push({ slug, iou: v })
        if (box) autoBoxes[slug] = box
        blockWeights[slug] = p.map((v) => +v.toFixed(4))
      }
    }
    const sorted = [...ious].sort((a, b) => a - b)
    console.log(`обучаемый отбор блоков, ${FOLDS} фолдов по клипам, признаки положения ${withPos ? 'ВКЛЮЧЕНЫ' : 'выключены'}`)
    console.log()
    console.log('  показатель'.padEnd(34), 'обучаемый'.padStart(10), 'пороговый'.padStart(11), 'эвристика'.padStart(11))
    console.log('  ' + '-'.repeat(68))
    console.log(`  ${'медиана IoU'.padEnd(32)}`, (sorted[sorted.length >> 1] ?? 0).toFixed(3).padStart(10), '0.221'.padStart(11), '0.065'.padStart(11))
    console.log(`  ${'среднее IoU'.padEnd(32)}`, (ious.reduce((a, b) => a + b, 0) / ious.length).toFixed(3).padStart(10), ''.padStart(11), ''.padStart(11))
    console.log(`  ${'центр внутри рамки'.padEnd(32)}`, `${centreHits}/${ious.length}`.padStart(10), '23/46'.padStart(11), ''.padStart(11))
    console.log(`  ${'промахов (IoU < 0.2)'.padEnd(32)}`, `${ious.filter((v) => v < 0.2).length}/${ious.length}`.padStart(10), '22/46'.padStart(11), '31/46'.padStart(11))
    const byIou = rows.sort((a, b) => b.iou - a.iou)
    console.log('\n  лучшие:', byIou.slice(0, 4).map((r) => `${r.slug.slice(0, 22)} ${r.iou.toFixed(2)}`).join(', '))
    console.log('  худшие:', byIou.slice(-4).map((r) => `${r.slug.slice(0, 22)} ${r.iou.toFixed(2)}`).join(', '))

    const outPath = join(PROJECT_ROOT, 'eval/.cache/weaponRegions.auto.json')
    await writeFile(outPath, JSON.stringify({
      note: 'Рамки автопоиска, полученные фолдами по клипам: каждая от модели, не видевшей свой клип.',
      regions: Object.fromEntries(Object.entries(autoBoxes).map(([k, v]) => [k, { ...v, note: 'auto' }])),
    }, null, 1))
    console.log(`\nрамки выгружены в ${outPath} (${Object.keys(autoBoxes).length} клипов)`)

    const weightsPath = join(PROJECT_ROOT, 'eval/.cache/blockWeights.json')
    await writeFile(weightsPath, JSON.stringify({
      grid,
      note: 'Вероятность «блок лежит на оружии», фолдами по клипам: каждая карта от модели, не видевшей свой клип.',
      clips: blockWeights,
    }))
    console.log(`карты весов выгружены в ${weightsPath}`)
    return
  }

  const r = run({ minPinned: 0.55, aliveQ: 0.5, reactTop: 0.3 })
  console.log(`клипов с человеческой рамкой ${r.total}, область найдена на ${r.found}`)
  console.log()
  console.log('  показатель'.padEnd(34), 'автопоиск'.padStart(10), 'эвристика в проде'.padStart(18))
  console.log('  ' + '-'.repeat(64))
  console.log(`  ${'медиана IoU с рамкой человека'.padEnd(32)}`, r.median.toFixed(3).padStart(10), '0.065'.padStart(18))
  console.log(`  ${'среднее IoU'.padEnd(32)}`, r.mean.toFixed(3).padStart(10), ''.padStart(18))
  console.log(`  ${'центр попал внутрь рамки'.padEnd(32)}`, `${r.centre}/${r.total}`.padStart(10), ''.padStart(18))
  console.log(`  ${'промахов (IoU < 0.2)'.padEnd(32)}`, `${r.miss}/${r.total}`.padStart(10), '31/46'.padStart(18))
  console.log()
  const sorted = [...r.rows].sort((a, b) => b.iou - a.iou)
  console.log('лучшие:')
  for (const x of sorted.slice(0, 5)) console.log(`  ${x.slug.slice(0, 40).padEnd(42)} IoU ${x.iou.toFixed(3)}`)
  console.log('худшие:')
  for (const x of sorted.slice(-6)) {
    const f = x.found ? `x ${x.found.x0.toFixed(2)}–${x.found.x1.toFixed(2)} y ${x.found.y0.toFixed(2)}–${x.found.y1.toFixed(2)}` : 'не найдено'
    console.log(`  ${x.slug.slice(0, 40).padEnd(42)} IoU ${x.iou.toFixed(3)}  нашли ${f}`)
  }
}

void main()
