/**
 * Check of the pure video path: shot moments come only from the model, no sound at all.
 *
 * Measures with the same code the wizard calls (`detectByFlash`) — otherwise it would check
 * something other than what the user will see.
 *
 *   pnpm dev  ->  /eval/flashOnly.html?limit=5
 */
import { detectByFlash } from '../src/domain/detection/flash/detectByFlash'
import type { OwnFlash } from '../src/domain/detection/flash/ownWeapon'
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

async function main(): Promise<void> {
  const params0 = new URLSearchParams(window.location.search)
  // ?mode=windows — frames are taken only around audio candidates, as before.
  // The selection logic is the same: exactly the way frames are obtained is compared.
  const windows = params0.get('mode') === 'windows'
  // ?file=name — analyse a video from fixtures/__test instead of a corpus clip. Needed to
  // check on the same video the user is watching.
  const file = params0.get('file')
  if (file) {
    log(`ролик ${file}, звук не участвует\n`)
    const blob = await fetch(`/__test/${file}`).then((r) => r.blob())
    let captured: OwnFlash[] = []
    const started = performance.now()
    const shots = await detectByFlash(blob, { onReference: (own) => (captured = own) })
    log(captured.length
      ? `опор своей вспышки ${captured.length}: ` +
          captured.map((o) => `${(100 * o.area).toFixed(2)}% в ${o.cx.toFixed(2)},${o.cy.toFixed(2)} по ${o.members}`).join('; ')
      : 'опор нет — фильтр не применялся')
    log(`\nметок ${shots.length}, за ${((performance.now() - started) / 1000).toFixed(1)} с:`)
    for (const s of shots) log(`   ${s.time.toFixed(3)}   уверенность ${s.strength.toFixed(3)}`)
    return
  }

  const manifest = await fetch('/__ammo/manifest.json').then((r) => (r.ok ? r.json() : null))
  if (!manifest) {
    log('нет /__ammo/manifest.json — сначала pnpm exec tsx eval/ammoPrep.ts')
    return
  }
  const only = params0.get('only')
  const limit = Number(params0.get('limit') ?? 0)
  const all: Entry[] = manifest.entries
  const picked = only ? all.filter((e) => e.slug.includes(only)) : all
  const entries = limit > 0 ? picked.slice(0, limit) : picked

  log(`клипов ${entries.length}, звук не участвует\n`)
  const rows: { slug: string; source: string; times: number[]; seconds: number }[] = []
  for (const entry of entries) {
    const started = performance.now()
    try {
      const file = await fetch(`/__ammo/${entry.slug}.mp4`).then((r) => r.blob())
      // The assignment happens in a callback, and without an explicit type narrowing decides
      // the variable is null forever.
      let captured: OwnFlash[] = []
      const sourceSeen: ('ammo' | 'flash')[] = []
      const shots = await detectByFlash(file, {
        onReference: (own) => (captured = own),
        candidates: windows ? entry.candidates : undefined,
        // Candidates are needed by the COUNTER to pick the slot; they do not affect flash moments.
        audioShots: (entry.candidates ?? []).map((time, i) => ({
          time,
          strength: entry.confidence?.[i] ?? 1,
          relativeLoudness: 1,
        })),
        onSource: (s) => sourceSeen.push(s),
      })
      const reference = captured[0] ?? null
      const refCount = captured.length
      const seconds = (performance.now() - started) / 1000
      rows.push({
        slug: entry.slug,
        source: sourceSeen[0] ?? 'flash',
        times: shots.map((s) => Math.round(s.time * 1000) / 1000),
        seconds,
      })
      log(
        `${entry.slug.slice(0, 42).padEnd(44)} ${sourceSeen[0] === 'ammo' ? 'СЧЁТЧИК' : 'вспышка'} ` +
          `меток ${String(shots.length).padStart(3)}` +
          `   ${seconds.toFixed(1)} с  (${(seconds / entry.duration).toFixed(2)}x)` +
          (reference
            ? `   опор ${refCount}, главная ${(100 * reference.area).toFixed(2)}% в ${reference.cx.toFixed(2)},${reference.cy.toFixed(2)} по ${reference.members} вспышкам`
            : '   опор нет'),
      )
    } catch (error) {
      log(`${entry.slug.slice(0, 42).padEnd(44)} ОШИБКА: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  await saveResult(windows ? 'flashOnly-windows.json' : 'flashOnly.json', JSON.stringify(rows, null, 1), 'application/json')
  log(`\nготово, записано в eval/.cache/${windows ? 'flashOnly-windows.json' : 'flashOnly.json'}`)
}

void main()
