/**
 * EVENT METRIC: what a human hears after the sound is replaced.
 *
 * THE RULES ARE DERIVED FROM 40 VERDICTS BY EAR, not from theory. The user went through
 * all 33 clips with bursts and said for each whether it was good or not. The previous
 * version of the metric agreed with these verdicts poorly: on approved clips it credited
 * 47% of events and declared defects that nobody hears. The current one gives 98.5%
 * on approved clips versus 22.7% on suppressed-weapon clips.
 *
 * WHAT A HUMAN ACTUALLY HEARS:
 *
 *   FAST fire (period <= 140 ms, 4 shots or more) — a continuous sound. Misses inside
 *   and a miss at the edge are inaudible: `bizon`, 18 labels for 26 shots — "all the
 *   misses drown in the replacement sound". Only a GAP longer than half a second is heard.
 *
 *   SLOW — the ear counts the pops, and what matters is the NUMBER of labels, not their
 *   accuracy. `galil`: three shots 179 ms apart, three labels, the last one 100 ms off —
 *   "good". `neityu`: two or three shots, one label — defect. `tec9`: two shots and two
 *   inaccurate labels — "good", `p250`: two shots and one label — defect. FEWER labels
 *   than shots is audible, MORE inside a burst is not.
 *
 *   A CONSTANT OFFSET across the clip is not a defect: the silence-trim slider fixes it.
 *   `scar20` — all labels 102 ms late, verdict "all good". So the offset is removed
 *   before scoring.
 *
 *   EXTRAS IN SILENCE are always heard: `magixx` — "1 extra", `3-kill` — "3 extra".
 *
 *   FLASHBANG WINDOWS drop out of scoring entirely, together with their labels: a flashbang
 *   blinds and deafens the player, knocking out both of our sensors at once, and the player
 *   does not hear shots there either. Windows come from `eval/flashbangs.json`,
 *   computed by `python/tools/flashbangs.py`.
 *
 * THESE NUMBERS ARE NOT COMPARABLE with the per-shot ones from `pnpm eval` or with the
 * previous version of this metric. When quoting them, always say which metric was computed.
 *
 *   pnpm exec tsx eval/eventScore.ts eval/.cache/speedMarks.json
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LABELS_DIR } from './fixtures'

/** Gap at which firing is cut into events: this much silence the ear hears as
 *  "the shooting stopped". Same constant as `BURST_GAP_S` in `fireRates.ts`. */
const GAP_S = 0.4
/** Base tolerance for a label hit. */
const TOL_S = 0.05
/** A period faster than this — shots merge into a spray... */
const FAST_PERIOD_S = 0.14
/** ...but only from this number of shots on: the ear counts a pistol double-tap
 *  one by one even at a hundred milliseconds. */
const BLUR_MIN_SHOTS = 4
/** Tolerance of a counted event — a fraction of its own period. */
const TOL_PERIOD = 0.6
/** Silence inside a fast burst that is already audible. Measured by verdicts: gaps of
 *  333-467 ms are not heard, while a second and a half (`mac10`, switch to a suppressed
 *  weapon) is. */
const HOLE_S = 0.5
/** An EXTRA is a sound WHERE THERE WAS NO SHOT, not an inaccurate label. `galil`:
 *  18 labels for 18 shots and the verdict "good", while a strict tolerance counted
 *  three extras there. */
const FP_TOL_S = 0.15
/** Margin around a flashbang window. */
const FB_PAD_S = 0.2
/** Pairs further apart than this are not used to estimate the constant offset. */
const SHIFT_MAX_S = 0.25
const SHIFT_MIN_PAIRS = 4

type Window = readonly [number, number]

const MARKS_PATH = process.argv[2] ?? 'eval/.cache/speedMarks.json'

function group(times: readonly number[], gap = GAP_S): number[][] {
  const runs: number[][] = []
  for (const t of [...times].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1]
    if (last && t - last[last.length - 1] <= gap) last.push(t)
    else runs.push([t])
  }
  return runs
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  // For even length — the mean of the two middle values. This is not cosmetic: otherwise
  // the period of a burst with an even number of intervals shifts by half a step, and an
  // event right at the fast/counted boundary moves to the other class.
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

const period = (run: readonly number[]): number =>
  median(run.slice(1).map((t, i) => t - run[i]))

/** Constant offset of the whole clip: the user fixes it with the slider, not us. */
function clipShift(ref: readonly number[], marks: readonly number[]): number {
  const d: number[] = []
  for (const m of marks) {
    let best = Infinity
    for (const r of ref) if (Math.abs(r - m) < Math.abs(best)) best = r - m
    if (Math.abs(best) <= SHIFT_MAX_S) d.push(best)
  }
  return d.length >= SHIFT_MIN_PAIRS ? median(d) : 0
}

type Kind = 'одиночный' | 'быстрая' | 'считаемая'

const kindOf = (run: readonly number[]): Kind =>
  run.length === 1
    ? 'одиночный'
    : period(run) <= FAST_PERIOD_S && run.length >= BLUR_MIN_SHOTS
      ? 'быстрая'
      : 'считаемая'

/** The longest silence: before the first label, between labels, after the last. */
function worstHole(run: readonly number[], inside: readonly number[]): number {
  if (!inside.length) return run[run.length - 1] - run[0] + 1
  const holes = [
    Math.max(0, inside[0] - run[0]),
    Math.max(0, run[run.length - 1] - inside[inside.length - 1]),
    ...inside.slice(1).map((m, i) => m - inside[i]),
  ]
  return Math.max(...holes)
}

interface Event {
  kind: Kind
  ok: boolean
  run: number[]
  tol: number
}

export function scoreClip(
  ref: readonly number[],
  rawMarks: readonly number[],
  flash: readonly Window[] = [],
): { events: Event[]; fp: number } {
  const shift = rawMarks.length ? clipShift(ref, rawMarks) : 0
  const marks = [...rawMarks].map((m) => m + shift).sort((a, b) => a - b)
  const blind = (a: number, b: number) =>
    flash.some(([x, y]) => !(y < a - FB_PAD_S || x > b + FB_PAD_S))

  const events: Event[] = []
  const dropped: number[][] = []
  for (const run of group(ref)) {
    if (blind(run[0], run[run.length - 1])) {
      // The event dropped out of scoring — so its labels are not extras either. Without this
      // the metric discarded the event but counted the labels inside it as junk.
      dropped.push(run)
      continue
    }
    const kind = kindOf(run)
    if (kind === 'одиночный') {
      events.push({ kind, ok: marks.some((m) => Math.abs(m - run[0]) <= TOL_S), run, tol: TOL_S })
      continue
    }
    const p = period(run)
    const tol = Math.max(TOL_S, TOL_PERIOD * p)
    const lo = run[0] - tol
    const hi = run[run.length - 1] + tol
    const inside = marks.filter((m) => m >= lo && m <= hi)
    // Counted: NO FEWER labels than shots. A missed pop is audible, an extra INSIDE
    // a burst is not, it merges with its neighbours. An extra in SILENCE is audible,
    // but it does not land here: the extras count below catches it.
    const ok = kind === 'считаемая' ? inside.length >= run.length : worstHole(run, inside) <= HOLE_S
    events.push({ kind, ok, run, tol })
  }

  const excused = (m: number) =>
    flash.some(([x, y]) => m >= x - FB_PAD_S && m <= y + FB_PAD_S) ||
    dropped.some((r) => m >= r[0] - FP_TOL_S && m <= r[r.length - 1] + FP_TOL_S) ||
    events.some(
      (e) =>
        (e.kind === 'быстрая' &&
          m >= e.run[0] - e.tol &&
          m <= e.run[e.run.length - 1] + e.tol) ||
        e.run.some((t) => Math.abs(m - t) <= Math.max(FP_TOL_S, e.tol)),
    )

  return { events, fp: group(marks.filter((m) => !excused(m))).length }
}

async function main(): Promise<void> {
  const marks = JSON.parse(await readFile(MARKS_PATH, 'utf8')) as Record<string, { prod: number[] }>
  let flash: Record<string, Window[]> = {}
  try {
    flash = JSON.parse(await readFile('eval/flashbangs.json', 'utf8'))
  } catch {
    console.log('ВНИМАНИЕ: eval/flashbangs.json не найден, окна флешки не исключаются\n')
  }

  let tp = 0
  let fp = 0
  let fn = 0
  const singles = { tp: 0, total: 0 }
  const bursts = { tp: 0, total: 0 }
  const rows: { slug: string; ok: number; n: number; fp: number }[] = []

  for (const slug of Object.keys(marks)) {
    let raw: string
    try {
      raw = await readFile(join(LABELS_DIR, `${slug}.json`), 'utf8')
    } catch {
      continue
    }
    const labels = JSON.parse(raw) as { shots: { time: number; source: string }[] }
    const ref = labels.shots.filter((s) => s.source === 'own').map((s) => s.time)
    if (!ref.length) continue

    const got = scoreClip(ref, marks[slug].prod, flash[slug] ?? [])
    for (const e of got.events) {
      const bucket = e.kind === 'одиночный' ? singles : bursts
      bucket.total++
      if (e.ok) {
        bucket.tp++
        tp++
      } else fn++
    }
    fp += got.fp
    rows.push({ slug, ok: got.events.filter((e) => e.ok).length, n: got.events.length, fp: got.fp })
  }

  const p = tp + fp === 0 ? 1 : tp / (tp + fp)
  const r = tp + fn === 0 ? 1 : tp / (tp + fn)
  const f1 = p + r === 0 ? 0 : (2 * p * r) / (p + r)
  console.log(`метки: ${MARKS_PATH}`)
  console.log(
    `разрыв ${GAP_S} с, быстрая очередь — период до ${FAST_PERIOD_S} с от ${BLUR_MIN_SHOTS} выстрелов\n`,
  )
  console.log(
    `СОБЫТИЯ  F1 ${(f1 * 100).toFixed(1)}  точность ${(p * 100).toFixed(1)}` +
      `  полнота ${(r * 100).toFixed(1)}   (нашли ${tp}, лишних ${fp}, пропущено ${fn})`,
  )
  console.log(
    `  одиночные ${singles.tp}/${singles.total} ` +
      `(${((singles.tp / singles.total) * 100).toFixed(0)}%)` +
      `   очереди ${bursts.tp}/${bursts.total} ` +
      `(${((bursts.tp / bursts.total) * 100).toFixed(0)}%)`,
  )

  rows.sort((a, b) => a.ok / a.n - b.ok / b.n || b.fp - a.fp)
  console.log('\nхудшие клипы по событиям:')
  for (const row of rows.slice(0, 8)) {
    console.log(
      `  ${row.slug.slice(0, 46).padEnd(46)} ${`${row.ok}/${row.n}`.padStart(6)}  лишних ${row.fp}`,
    )
  }
}

if (process.argv[1]?.endsWith('eventScore.ts')) void main()
