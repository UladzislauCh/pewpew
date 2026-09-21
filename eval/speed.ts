/**
 * SPEED BENCHMARK of the production video analysis.
 *
 * Measures exactly what the wizard calls (`detectByFlash`), with the same code and in the
 * same browser. The Python pipeline and the full-video pass from `flash_curve.py` are
 * different numbers and must not be added in here.
 *
 *   pnpm exec tsx eval/ammoPrep.ts     # if /__ammo/manifest.json does not exist yet
 *   pnpm dev  ->  /eval/speed.html
 *
 * ?limit=N — first N clips, ?only=substring — a single clip,
 * ?backend=webgpu|wasm — force the executor, ?repeat=N — N runs per clip,
 * ?set=quick — the quick set of ten clips instead of the whole corpus,
 * ?model=name — a model from public/models (without .onnx), ?imgsz=WIDTHxHEIGHT — its input,
 * ?minhot=N — how many consecutive hot frames a label needs at 60 fps,
 * ?threshold=X — flash confirmation threshold instead of DEFAULT_FLASH_THRESHOLD.
 *
 * The threshold is exposed for CONTROL AT EQUAL RECALL: any rule that buys recall at the
 * cost of precision must be compared with the detector's own curve, not with a single
 * point on it. Run files differ by the `-tX` suffix.
 *
 * WHAT EXACTLY IS MEASURED. Three numbers per clip, and they must not be confused:
 *
 *   wall    — from the call to the labels: decoding, frame transfer, model, anchor selection;
 *   model   — sum of `ms` from the worker: tensor preparation plus the network run itself;
 *   rest    — wall minus model, i.e. decoding and everything around it.
 *
 * The rest is NOT the cost of decoding on the critical path: frames are decoded while the
 * worker computes, and part of the rest is hidden behind the model. So "removing the model"
 * will not win back its share — this was already checked and cost a wrong conclusion.
 *
 * Labels are written to a second file in the `eval/flashScore.ts` format, so that the
 * quality of this same run is computed by the real `scoreDetections`, not by eye:
 *
 *   pnpm exec tsx eval/flashScore.ts 0.05 eval/.cache/speedMarks.json
 */
import { detectByFlash } from '../src/domain/detection/flash/detectByFlash'
import { saveResult } from './saveResult'

/**
 * QUICK SET for checking hypotheses: 156 seconds of video instead of 1031, a run of about
 * two minutes instead of eleven. Chosen along six axes, not for convenience:
 *
 *   frame rate       30 and 60 (ump45, mag7 are sixty-frame);
 *   recall           0, 7, 23, 44, 74, 86, 88, 100 — the whole range;
 *   speed            from 1.90x (ump45) to 0.55x;
 *   length           from 5.5 s (aug) to 33 s (usp-0);
 *   density          from 2 shots (this-isn-t-legal) to 93 (m249);
 *   no muzzle flash  — BOTH cases: suppressor (m4a1s) and scope (aug).
 *
 * usp-0 covers the case where enemy shots outnumber own ones two to one: 37 vs 15.
 * this-isn-t-legal is included not for variety but as a SENTINEL — it exposed that
 * the aggregate count is blind to swapped labels.
 *
 * CONCLUSIONS FROM HERE ARE HYPOTHESES, NOT RESULTS. Confirm a win on the full corpus:
 * ten clips catch neither throttling on long videos nor rare combinations.
 */
const QUICK_SET = [
  'ak47-dbf13655',
  'ump45-53cf447f',
  'mag7-9be72a14',
  'm249-01da2208',
  'm4a1s-06df7ea2',
  'aug-8ce4830d',
  'usp-0-fdf2debd',
  'five-seven-b6c3c48a',
  'm0nesy-awp-flicks-vs-vitality-cs2-cs2pov-iemmelb-cf310d35',
  'this-isn-t-legal-m0nesy-s-filthy-double-with-a-w-f3a83c40',
]

interface Entry {
  slug: string
  duration: number
  candidates?: number[]
  confidence?: number[]
}

interface Row {
  slug: string
  duration: number
  seconds: number
  frames: number
  modelMs: number
  prepMs: number
  runMs: number
  drawMs: number
  readMs: number
  fillMs: number
  marks: number
  backend: string
}

const out = document.getElementById('out') as HTMLPreElement
const log = (line: string): void => {
  out.textContent += line + '\n'
  window.scrollTo(0, document.body.scrollHeight)
}

const num = (v: number, w: number, d = 1) => v.toFixed(d).padStart(w)

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search)
  const only = params.get('only')
  const limit = Number(params.get('limit') ?? 0)
  const repeat = Math.max(1, Number(params.get('repeat') ?? 1))
  const backend = params.get('backend') as 'webgpu' | 'wasm' | null
  const modelName = params.get('model')
  const minHot = Number(params.get('minhot') ?? 0)
  // Flash confirmation threshold. Needed for CONTROL AT EQUAL RECALL: a rule that buys
  // recall at the cost of precision has to be compared not with a single point but with
  // the detector's own curve. Without this parameter the curve cannot be built.
  const thresholdRaw = params.get('threshold')
  const threshold = thresholdRaw === null ? undefined : Number(thresholdRaw)
  const imgszRaw = params.get('imgsz')
  // A "width x height" pair or a single number. The order must not be wrong: ONNX input is
  // NCHW, and on a rectangle swapped sides give garbage, not just a distortion.
  const imgsz: number | [number, number] | undefined = imgszRaw
    ? (imgszRaw.includes('x')
        ? (imgszRaw.split('x').map(Number) as [number, number])
        : Number(imgszRaw))
    : undefined

  const manifest = await fetch('/__ammo/manifest.json').then((r) => (r.ok ? r.json() : null))
  if (!manifest) {
    log('нет /__ammo/manifest.json — сначала pnpm exec tsx eval/ammoPrep.ts')
    return
  }

  const all: Entry[] = manifest.entries
  const quick = params.get('set') === 'quick'
  const bySet = quick ? all.filter((e) => QUICK_SET.includes(e.slug)) : all
  const picked = only ? bySet.filter((e) => e.slug.includes(only)) : bySet
  const entries = limit > 0 ? picked.slice(0, limit) : picked

  log(`клипов ${entries.length}, прогонов на клип ${repeat}, исполнитель ${backend ?? 'по умолчанию'}`)
  log(`модель ${modelName ?? 'по умолчанию'}, вход ${imgszRaw ?? 'по умолчанию'}, горячих кадров минимум ${minHot || 1}, порог ${thresholdRaw ?? 'по умолчанию'}\n`)
  log('клип                                          стена    x    кадров  мс/кадр  модель  остаток  меток')

  const rows: Row[] = []
  const marks: Record<string, Record<string, number[]>> = {}

  for (const entry of entries) {
    try {
      const file = await fetch(`/__ammo/${entry.slug}.mp4`).then((r) => r.blob())
      let best: Row | null = null
      let times: number[] = []

      for (let i = 0; i < repeat; i++) {
        let frames = 0
        let modelMs = 0
        let prepMs = 0
        let runMs = 0
        let drawMs = 0
        let readMs = 0
        let fillMs = 0
        let seen = backend ?? 'webgpu'

        const started = performance.now()
        const shots = await detectByFlash(file, {
          backend: backend ?? undefined,
          // Defaults live in DEFAULTS, and undefined must not be passed here:
          // object spread would overwrite them. Hence the conditional fields.
          ...(modelName ? { modelUrl: `/models/${modelName}.onnx` } : {}),
          ...(imgsz ? { imgsz } : {}),
          ...(minHot > 0 ? { minHotFrames: minHot } : {}),
          ...(threshold !== undefined ? { threshold } : {}),
          // The ammo counter needs candidates to pick the slot. Without them what is
          // measured is not the production path but half of it.
          audioShots: (entry.candidates ?? []).map((time, k) => ({
            time,
            strength: entry.confidence?.[k] ?? 1,
            relativeLoudness: 1,
          })),
          onBackend: (b) => (seen = b),
          onFrame: (f) => {
            frames++
            modelMs += f.ms ?? 0
            prepMs += f.prepMs ?? 0
            runMs += f.runMs ?? 0
            drawMs += f.drawMs ?? 0
            readMs += f.readMs ?? 0
            fillMs += f.fillMs ?? 0
          },
        })
        const seconds = (performance.now() - started) / 1000
        const row: Row = {
          slug: entry.slug,
          duration: entry.duration,
          seconds,
          frames,
          modelMs,
          prepMs,
          runMs,
          drawMs,
          readMs,
          fillMs,
          marks: shots.length,
          backend: seen,
        }
        // The BEST of the repeats is taken, not the mean: slow runs are noise from
        // neighbouring tabs and throttling, not a property of the code.
        if (!best || seconds < best.seconds) best = row
        times = shots.map((s) => Math.round(s.time * 1000) / 1000)
      }

      const row = best as Row
      rows.push(row)
      marks[entry.slug] = { prod: times }

      const rest = row.seconds * 1000 - row.modelMs
      log(
        `${entry.slug.slice(0, 42).padEnd(44)} ` +
          `${num(row.seconds, 5)}с ${num(row.seconds / row.duration, 5, 2)}x ` +
          `${String(row.frames).padStart(7)} ` +
          `${num((row.seconds * 1000) / Math.max(1, row.frames), 8)} ` +
          `${num(row.modelMs / Math.max(1, row.frames), 7)} ` +
          `${num(rest / Math.max(1, row.frames), 8)} ` +
          `${String(row.marks).padStart(6)}`,
      )
    } catch (error) {
      log(`${entry.slug.slice(0, 42).padEnd(44)} ОШИБКА: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (!rows.length) {
    log('\nни один клип не прошёл')
    return
  }

  const sum = (pick: (r: Row) => number) => rows.reduce((n, r) => n + pick(r), 0)
  const wall = sum((r) => r.seconds)
  const dur = sum((r) => r.duration)
  const frames = sum((r) => r.frames)
  const model = sum((r) => r.modelMs)
  const prep = sum((r) => r.prepMs)
  const run = sum((r) => r.runMs)
  const rest = wall * 1000 - model

  log('\n' + '='.repeat(96))
  log(`клипов ${rows.length}, видео ${dur.toFixed(0)} с, разбор ${wall.toFixed(1)} с`)
  log(`ИТОГО ${(wall / dur).toFixed(3)}x реального времени, кадров ${frames}, ${(wall * 1000 / frames).toFixed(1)} мс/кадр`)
  log('')
  log(`  модель   ${(model / frames).toFixed(1)} мс/кадр   ${(100 * model / (wall * 1000)).toFixed(0)}% стены`)
  log(`    подготовка тензора ${(prep / frames).toFixed(2)} мс, прогон сети ${(run / frames).toFixed(2)} мс`)
  log(`      рисование ${(sum((r) => r.drawMs) / frames).toFixed(2)}  чтение пикселей ${(sum((r) => r.readMs) / frames).toFixed(2)}  раскладка ${(sum((r) => r.fillMs) / frames).toFixed(2)}`)
  log(`  остаток  ${(rest / frames).toFixed(1)} мс/кадр   ${(100 * rest / (wall * 1000)).toFixed(0)}% стены`)
  log(`    декодирование и передача кадров; часть спрятана за моделью`)
  log(`  исполнитель ${[...new Set(rows.map((r) => r.backend))].join(', ')}`)
  log('')
  log(`меток всего ${sum((r) => r.marks)} — качество этого прогона считать так:`)
  log(`  pnpm exec tsx eval/flashScore.ts 0.05 eval/.cache/speedMarks.json`)

  const tag = `${backend ? `-${backend}` : ''}${quick ? '-quick' : ''}${modelName ? `-${modelName}` : ''}${minHot > 0 ? `-hot${minHot}` : ''}${threshold !== undefined ? `-t${threshold}` : ''}`
  await saveResult(`speed${tag}.json`, JSON.stringify(rows, null, 1), 'application/json')
  await saveResult(`speedMarks${tag}.json`, JSON.stringify(marks, null, 1), 'application/json')
  log(`\nзаписано в eval/.cache/speed${tag}.json и speedMarks${tag}.json`)
}

void main()
