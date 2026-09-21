/**
 * Trains the block classifier on human boxes and exports weights for the product.
 *
 *   pnpm exec tsx eval/exportBlockModel.ts            # to public/models/blockModel.json
 *
 * Training uses ALL clips with no held-out set — this is a release build, not a measurement.
 * Honest numbers come from `pnpm exec tsx eval/viewmodelEval.ts --learn` (folds by clip): median
 * IoU 0.209 against human boxes, centre inside the box on 31 clips out of 46. Quality must not
 * be checked on the weights from here, exactly as with the motion model.
 *
 * Block labels come from `eval/weaponRegions.json`: a block is positive if its centre lies
 * inside the box the human drew around the weapon.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FIXTURES_DIR, PROJECT_ROOT } from './fixtures'
import { BLOCK_FEATURE_NAMES, BLOCK_GRID, blockFeatures, type BlockStats } from '../src/domain/detection/motion/blockMotion'

const OUT = join(FIXTURES_DIR, 'models/blockModel.json')

function train(rows: number[][], y: number[], steps = 2500, lr = 0.5): { w: number[]; b: number } {
  const d = rows[0].length
  const w = new Array<number>(d).fill(0)
  let b = 0
  const nPos = y.filter((v) => v === 1).length || 1
  const wPos = y.length / (2 * nPos)
  const wNeg = y.length / (2 * Math.max(1, y.length - nPos))
  for (let step = 0; step < steps; step++) {
    const g = new Array<number>(d).fill(0)
    let gb = 0
    let total = 0
    for (let i = 0; i < rows.length; i++) {
      let z = b
      for (let j = 0; j < d; j++) z += w[j] * rows[i][j]
      const p = 1 / (1 + Math.exp(-z))
      const cw = y[i] === 1 ? wPos : wNeg
      const e = cw * (p - y[i])
      for (let j = 0; j < d; j++) g[j] += e * rows[i][j]
      gb += e
      total += cw
    }
    for (let j = 0; j < d; j++) w[j] -= (lr * g[j]) / total
    b -= (lr * gb) / total
  }
  return { w, b }
}

async function main(): Promise<void> {
  const blocks = JSON.parse(await readFile(join(PROJECT_ROOT, 'eval/.cache/viewmodelBlocks.json'), 'utf8')) as {
    grid: number
    clips: Record<string, BlockStats[] | null>
  }
  const regions = JSON.parse(await readFile(join(PROJECT_ROOT, 'eval/weaponRegions.json'), 'utf8')).regions as Record<
    string,
    { x0?: number; y0?: number; x1?: number; y1?: number; absent?: boolean }
  >
  if (blocks.grid !== BLOCK_GRID) throw new Error(`кэш посчитан на сетке ${blocks.grid}, код ждёт ${BLOCK_GRID}`)

  const X: number[][] = []
  const Y: number[] = []
  let clips = 0
  for (const [slug, stats] of Object.entries(blocks.clips)) {
    const r = regions[slug]
    if (!stats || !r || r.absent) continue
    clips++
    const features = blockFeatures(stats)
    stats.forEach((_, i) => {
      const x = ((i % BLOCK_GRID) + 0.5) / BLOCK_GRID
      const y = ((i / BLOCK_GRID | 0) + 0.5) / BLOCK_GRID
      X.push(features[i])
      Y.push(x >= r.x0! && x <= r.x1! && y >= r.y0! && y <= r.y1! ? 1 : 0)
    })
  }

  const { w, b } = train(X, Y)
  await writeFile(
    OUT,
    JSON.stringify(
      {
        version: 1,
        note:
          'Вероятность «блок лежит на оружии». Обучено на рамках человека из eval/weaponRegions.json, ' +
          'на всех клипах без отложенной выборки — мерить качество на этих весах нельзя. ' +
          'Честная оценка фолдами: pnpm exec tsx eval/viewmodelEval.ts --learn, медиана IoU 0.209.',
        features: [...BLOCK_FEATURE_NAMES],
        weights: w.map((v) => +v.toFixed(6)),
        bias: +b.toFixed(6),
      },
      null,
      1,
    ),
  )
  console.log(`обучено на ${clips} клипах, ${X.length} блоков (положительных ${Y.filter((v) => v).length})`)
  console.log(`сохранено: public/models/blockModel.json`)
  console.log('веса:')
  BLOCK_FEATURE_NAMES.forEach((n, i) => console.log(`  ${w[i] >= 0 ? '+' : ''}${w[i].toFixed(3)}  ${n}`))
}

void main()
