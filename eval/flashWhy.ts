/**
 * WHAT EACH LABEL LATCHED ONTO — an analysis of one clip, not a corpus-wide table.
 *
 * The question this was written for: the user sees a label where there is no flash on screen
 * at all, and asks what the system picked there. A collapsed score does not answer that.
 * Here, for each label, the winning class, the scores of all classes and the box are printed —
 * plus the own-flash reference the box was compared with.
 *
 * For clips where the answer came from the ammo counter, its breakdown is printed: which slot
 * was chosen, how often it was read and how it lined up with the sound. A label off the shot
 * most often means not a read error but someone else's row of digits taken for the counter.
 *
 * A TRAP that cost an hour twice. Editing ANY imported module (`ownWeapon`, `detectByFlash`)
 * reloads the page via HMR, the run starts over and overwrites the finished dump with its
 * first clip. Once a full run is done, copy the file under a protected name right away, and
 * only then edit code.
 *
 *   pnpm dev  ->  /eval/flashWhy.html?only=substring
 */
import { detectByFlash } from '../src/domain/detection/flash/detectByFlash'
import type { OwnFlash, Spot } from '../src/domain/detection/flash/ownWeapon'
import { DEFAULT_FLASH_THRESHOLD } from '../src/domain/detection/flash/thresholds'
import { saveResult } from './saveResult'

interface Entry {
  slug: string
  duration: number
  candidates?: number[]
  confidence?: number[]
}

const out = document.getElementById('out') as HTMLPreElement
const log = (line: string): void => {
  out.textContent += line + '\n'
  window.scrollTo(0, document.body.scrollHeight)
}

const fmtSpot = (s: Spot | null): string =>
  s && s.w > 0
    ? `${(100 * s.w * s.h).toFixed(2)}% в ${s.cx.toFixed(2)},${s.cy.toFixed(2)}`
    : 'рамки нет'

async function main(): Promise<void> {
  const params = new URLSearchParams(window.location.search)
  const only = params.get('only')
  const manifest = await fetch('/__ammo/manifest.json').then((r) => (r.ok ? r.json() : null))
  if (!manifest) return log('нет /__ammo/manifest.json — сначала pnpm exec tsx eval/ammoPrep.ts')
  // ?only=a,b,c — several clips per run.
  const wanted = (only ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  const entries: Entry[] = (manifest.entries as Entry[]).filter(
    (e) => !wanted.length || wanted.some((w) => e.slug.includes(w)),
  )
  if (!entries.length) return log(`нет клипа по подстроке «${only}»`)

  const dumps: unknown[] = []
  for (const entry of entries) {
    log(`\n=== ${entry.slug} ===`)
    const file = await fetch(`/__ammo/${entry.slug}.mp4`).then((r) => r.blob())
    const seen: {
      time: number
      winner: string
      score: number
      spot: Spot | null
      scores: Record<string, number>
      ms: number
      prepMs: number
      runMs: number
    }[] = []
    let refs: OwnFlash[] = []
    const sources: string[] = []
    let ammo: any = null

    const startedAt = performance.now()
    const shots = await detectByFlash(file, {
      audioShots: (entry.candidates ?? []).map((time, i) => ({
        time,
        strength: entry.confidence?.[i] ?? 1,
        relativeLoudness: 1,
      })),
      onFrame: (f) => seen.push(f),
      onReference: (own) => (refs = own),
      onAmmo: (a) => (ammo = a),
      onSource: (s) => sources.push(s),
    })
    const wallMs = performance.now() - startedAt

    // Cost by parts: the model versus everything else (decoding, counter, analysis).
    // This is what decides whether selective frame slicing will help — on a phone it makes
    // sense only if the time is eaten by the model, not the decoder.
    const sum = (pick: (f: (typeof seen)[number]) => number) => seen.reduce((a, f) => a + pick(f), 0)
    const n = Math.max(1, seen.length)
    const totalMs = sum((f) => f.ms)
    const prepMs = sum((f) => f.prepMs)
    const runMs = sum((f) => f.runMs)
    const pct = (x: number) => `${Math.round((100 * x) / wallMs)}%`
    log(
      `кадров ${seen.length}, всего ${(wallMs / 1000).toFixed(1)} с\n` +
        `   подготовка кадра ${(prepMs / 1000).toFixed(1)} с (${pct(prepMs)}), ${(prepMs / n).toFixed(1)} мс на кадр\n` +
        `   прогон модели    ${(runMs / 1000).toFixed(1)} с (${pct(runMs)}), ${(runMs / n).toFixed(1)} мс на кадр\n` +
        `   всё остальное    ${((wallMs - totalMs) / 1000).toFixed(1)} с (${pct(wallMs - totalMs)}) — декодирование, счётчик, разбор`,
    )
    const source = sources[0] ?? 'flash'
    log(refs.length
      ? `опор своей вспышки ${refs.length}:\n` +
          refs
            .map((o, i) => `    ${i + 1}) ${(100 * o.area).toFixed(2)}% в ${o.cx.toFixed(2)},${o.cy.toFixed(2)} по ${o.members} вспышкам`)
            .join('\n')
      : 'опор нет — рамка не фильтровала')
    log(`ответ дала ступень: ${source === 'ammo' ? 'СЧЁТЧИК ПАТРОНОВ' : 'вспышка'}, меток ${shots.length}`)

    if (ammo) {
      if (ammo.times) {
        log(`  слот ${ammo.slot.x},${ammo.slot.y}  читался ${(100 * ammo.slot.readRate).toFixed(0)}% кадров, виден ${(100 * ammo.slot.presence).toFixed(0)}%`)
        log(`  на звук лёг: сдвиг ${(1000 * (ammo.alignment?.offset ?? 0)).toFixed(0)} мс, совпало ${ammo.alignment?.matched ?? '?'} из ${ammo.times.length}`)
        log(`  ряд счётчика: ${ammo.series.slice(0, 60).map(([f, v]: [number, number]) => `${f}:${v}`).join(' ')}${ammo.series.length > 60 ? ' …' : ''}`)
      } else {
        log(`  счётчик отвергнут: ${ammo.reason}`)
      }
    }

    // For each label — the frame it was taken from. For the counter the nearest frame is
    // printed too: it shows whether there was a flash on it at all.
    log('\n  метки:')
    shots.forEach((s, i) => {
      const near = seen.reduce((a, b) => (Math.abs(b.time - s.time) < Math.abs(a.time - s.time) ? b : a))
      const top = Object.entries(near.scores)
        .filter(([, v]) => v >= 0.05)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v.toFixed(2)}`)
        .join(', ')
      log(
        `  ${String(i + 1).padStart(3)}. ${s.time.toFixed(3)}  ` +
          `кадр ${near.time.toFixed(3)}: ${top || 'пусто'}  [${fmtSpot(near.spot)}]`,
      )
    })

    // Frames above the threshold that did NOT become labels: eaten either by the reference or by a neighbouring peak.
    const hot = seen.filter((f) => f.score >= DEFAULT_FLASH_THRESHOLD)
    const unused = hot.filter((f) => !shots.some((s) => Math.abs(s.time - f.time) < 0.04))
    log(`\n  горячих кадров ${hot.length}, из них не стали меткой ${unused.length}:`)
    for (const f of unused.slice(0, 40)) {
      log(`      ${f.time.toFixed(3)}  ${f.winner} ${f.score.toFixed(2)}  [${fmtSpot(f.spot)}]`)
    }
    if (unused.length > 40) log(`      … ещё ${unused.length - 40}`)

    // Boxes are stored as QUADRUPLES of numbers, not objects: on fifty clips that is the difference
    // between six megabytes and twenty, and only the rule sweep reads the file.
    dumps.push({
      slug: entry.slug,
      source,
      own: refs,
      shots: shots.map((s) => s.time),
      hot: seen
        .filter((f) => f.score >= DEFAULT_FLASH_THRESHOLD)
        .map((f) => ({
          t: f.time,
          s: f.score,
          c: f.winner,
          b: f.spot ? [f.spot.cx, f.spot.cy, f.spot.w, f.spot.h] : null,
        })),
      ammo: ammo?.times ? { slot: ammo.slot, times: ammo.times } : ammo?.reason ?? null,
    })
    // Save AFTER EACH clip: a corpus run takes about an hour, and the project has already
    // been through losing it to a crash on the fortieth video.
    await saveResult(params.get('out') ?? 'flashWhy.json', JSON.stringify(dumps), 'application/json')
  }
  log('\nготово')
}

void main()
