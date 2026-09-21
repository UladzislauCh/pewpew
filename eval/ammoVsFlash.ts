/**
 * Witness against witness: does the FLASH confirm the COUNTER's readings.
 *
 * Both stages are already computed in one pass over the frames, so the check costs nothing —
 * it compares two ready lists of numbers. Right now the ladder simply discards the flash if
 * the counter returned anything, and on `m0nesy-awp-flicks` this cost three correct labels:
 * the row of alive players "4 VS 2" at the top edge of the frame was taken for the counter.
 *
 * THE CHECK IS ASYMMETRIC, and that is the main point. At 30 frames per second the flash is
 * visible for about 71% of shots, and less often inside bursts — which is exactly why the counter is valuable. So:
 *
 *     flash -> shot -> counter dropped          IS CHECKED
 *     counter dropped -> flash visible          NOT CHECKED, false at 30 fps
 *
 * What is counted is the share of confident OWN flashes with NO counter event nearby.
 * For a real counter it should be low, for someone else's row — high.
 *
 *   pnpm exec tsx eval/ammoVsFlash.ts [tolerance, s]
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FASTEST_PERIOD_S } from '../src/domain/detection/flash/fireRates'
import { findOwnFlashes, isOwnFlash, type Spot } from '../src/domain/detection/flash/ownWeapon'
import { PROJECT_ROOT } from './fixtures'

/**
 * The tolerance is SYMMETRIC, and a one-sided window was CHECKED AND REJECTED here.
 *
 * It seemed the counter must lag: the event is the frame where the new value is first read,
 * and it appears after the shot. The measurement said otherwise — on `my-skills` counter
 * events come EARLIER than flashes, and a one-sided window gave 7 misses out of 7 there,
 * on a clip the user checked by eye and called flawless.
 *
 * The reason is that `shotsFromAmmo` moves its times by aligning to the sound, and that shift
 * goes either way. So a counter event has no lag of known sign at all.
 *
 * Below ±100 ms the check falls apart: at ±50 ms `xm1014` jumps from 0 misses to 8 of 8.
 * That is exactly the alignment spread, and the tolerance must accommodate it.
 */
const TOLERANCE_S = Number(process.argv[2] ?? 0.1)
/** Below this confidence a flash does not count as a witness: a doubtful trigger proves nothing. */
const SURE = 0.8

interface Hot { t: number; s: number; c: string; b: [number, number, number, number] | null }
interface Dump { slug: string; source: string; hot: Hot[]; ammo: { times: number[] } | string | null }

const spotOf = (h: Hot): Spot | null => (h.b ? { cx: h.b[0], cy: h.b[1], w: h.b[2], h: h.b[3] } : null)

function flashMarks(hot: Hot[]): { t: number; s: number }[] {
  const own = findOwnFlashes(hot.map(spotOf).filter((s): s is Spot => !!s))
  if (!own.length) return []
  const mine = hot.filter((h) => isOwnFlash(spotOf(h), own))
  const kept: { t: number; s: number }[] = []
  for (const f of [...mine].sort((a, b) => b.s - a.s)) {
    if (kept.some((k) => Math.abs(k.t - f.t) < FASTEST_PERIOD_S)) continue
    kept.push({ t: f.t, s: f.s })
  }
  return kept.sort((a, b) => a.t - b.t)
}

async function main(): Promise<void> {
  const dumps: Dump[] = JSON.parse(
    await readFile(join(PROJECT_ROOT, 'eval/.cache/flashWhySweep-50.json'), 'utf8'),
  )
  const ammoClips = dumps.filter((d) => d.source === 'ammo' && d.ammo && typeof d.ammo !== 'string')
  console.log(
    `клипов со счётчиком ${ammoClips.length}, допуск ±${(1000 * TOLERANCE_S).toFixed(0)} мс, ` +
      `вспышка считается свидетелем от ${SURE}, и нужно их минимум 3\n`,
  )
  console.log('клип'.padEnd(42) + 'вспышек'.padStart(9) + 'без спуска'.padStart(12) + 'доля'.padStart(8) + '   счётчик')

  const rows: { slug: string; sure: number; orphan: number }[] = []
  for (const d of ammoClips.sort((a, b) => a.slug.localeCompare(b.slug))) {
    const times = (d.ammo as { times: number[] }).times
    const sure = flashMarks(d.hot).filter((f) => f.s >= SURE)
    const orphan = sure.filter((f) => !times.some((t) => Math.abs(t - f.t) <= TOLERANCE_S))
    rows.push({ slug: d.slug, sure: sure.length, orphan: orphan.length })
    console.log(
      d.slug.slice(0, 40).padEnd(42) +
        String(sure.length).padStart(9) +
        String(orphan.length).padStart(12) +
        (sure.length ? `${Math.round((100 * orphan.length) / sure.length)}%` : '—').padStart(8) +
        `   меток ${times.length}`,
    )
  }

  // Clips WITHOUT confident flashes are those where the check must stay silent: suppressor,
  // scope, a webcam over the frame. Rejecting the counter there means losing the only source.
  // With fewer than three witnesses the share takes values of 0% or 100% and decides the
  // counter's fate by a coin toss. The check does not judge such clips.
  const mute = rows.filter((r) => r.sure < 3)
  const judged = rows.filter((r) => r.sure >= 3)
  console.log(`\nпроверка молчит на ${mute.length} клипах (свидетелей меньше трёх): ${mute.map((m) => `${m.slug.slice(0, 16)} (${m.sure})`).join(', ')}`)
  console.log(`\nпроверяемых клипов ${judged.length}:`)
  for (const share of [0.3, 0.5, 0.8]) {
    const rejected = judged.filter((r) => r.orphan / r.sure > share)
    console.log(
      `  порог «без спуска больше ${Math.round(100 * share)}%» отвергает ${rejected.length}: ` +
        rejected.map((r) => `${r.slug.slice(0, 18)} (${r.orphan}/${r.sure})`).join(', '),
    )
  }
}

void main()
