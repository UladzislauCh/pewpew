/**
 * The ammo counter as the PRIMARY source of own shots.
 *
 * Everything else in the project infers shots from indirect cues — timbre, attack shape,
 * camera motion. Yet the frame holds a direct answer: the CS2 counter decreases by exactly
 * one on every OWN shot and does not react to anyone else's.
 *
 * Where the counter is readable it is more accurate than anything else in the product. Where
 * it is not, the old scheme (audio plus motion) works, and `detectWithMotion` decides that.
 *
 * Measured on 45 labelled clips, metric `scoreDetections`, tolerance ±50 ms: on clips with a
 * counter recall 76.6, precision 80.4; on dense ones 80.7 / 88.1. Coverage is 17 clips of 45.
 * The uncovered ones are mostly clips where the HUD is NOT in the frame: the player's webcam
 * over the bottom of the frame, sponsor banners, third-person view.
 */
import { extractShots, type ShotEvents } from './events'
import { align, type Alignment } from './align'
import { scoreSeries, type SlotScore } from './identify'
import type { ScanResult, SlotResult } from './scan'

/**
 * Below this score a slot does not count as ammo. Better to honestly say "no counter" and fall
 * back to the old scheme than to pass off a foreign row as shots.
 */
const MIN_SLOT_SCORE = 0.6

/**
 * Share of events that found an audio candidate nearby. Every own shot makes a sound, so for a
 * real counter it is high; for a timer, the score or money it is not. The check is free: the
 * candidates are needed for alignment anyway.
 */
const MIN_SNAP_RATE = 0.6

/** With few events the share means nothing: three of them will match anything. */
const MIN_EVENTS_FOR_SNAP_CHECK = 4

/**
 * Share of the slot's frames on which a value was read at all.
 *
 * A holey series loses shots silently: the counter is found and correct, but decrements go by
 * between reads that nobody saw. The split on the corpus turned out perfect — on all nineteen
 * clips where the counter works the share is 0.97..1.00, and on the three where it is read in
 * snatches it is 0.57, 0.79 and 0.80. And those three are BETTER without the counter: `mp7`
 * gives 74.6 with motion against 15.4 with the counter, `biguzera-backstabs` 41.7 against 32.6.
 *
 * So a holey counter is not "better than nothing" but worse than the old scheme, and must
 * yield to it explicitly.
 */
const MIN_READ_RATE = 0.9

/**
 * Share of the slot's frames with the RESERVE read, below which the reserve does not enter the decision.
 *
 * The gate is on read reliability, not on "the pair was confirmed by a reload": a short clip
 * may have no reload at all — `ssg08` has none — and such a condition would cut exactly the
 * clip the reserve is needed for. There it is read on 81% of frames, which is enough.
 */
const MIN_RESERVE_READ_RATE = 0.6

export interface AmmoResult {
  times: number[]
  slot: { x: number; y: number; presence: number; readRate: number }
  score: SlotScore
  alignment: Alignment
  reloads: number[]
  /** All found locations — for reconciling with the research pipeline. */
  slots: SlotReport[]
  /** Readings of the chosen slot at CHANGE points: [time, value]. */
  series: [number, number][]
  /**
   * Time spans on which the counter was ACTUALLY READ, in seconds.
   *
   * Needed to choose the label source per segment rather than per whole clip: the counter is not
   * read for the whole clip, the median slot visibility is about 75%. Where it is read densely,
   * its readings are the game's direct answer; where it is lost, the flash works.
   *
   * `series` does not fit this: it stores only value CHANGE points, and a quiet stretch where
   * the counter reads perfectly looks like silence in it.
   */
  readSpans: [number, number][]
  /**
   * Shot moments BEFORE alignment to audio — what the video said.
   *
   * Needed for analysis: with them and the candidates, any alignment scheme can be swept locally
   * in seconds instead of driving the browser over forty-five clips for nine minutes.
   */
  shotsVideo: number[]
}

export interface AmmoRejection {
  times: null
  reason: string
  /** The best of the considered slots — so a rejection can be analysed rather than guessed at. */
  best: SlotReport | null
  /** All found locations, longest-lived first. Without them a rejection is analysed by guessing. */
  slots: SlotReport[]
}

/**
 * Runs of consecutive read frames.
 *
 * A gap of a couple of frames does NOT break a span: a single classifier miss is noise, not a
 * lost counter. Three frames is 100 ms at 30 fps, well below any pause at which switching
 * the source would be worthwhile.
 */
function readSpansOf(frames: number[], fps: number, startTime: number): [number, number][] {
  if (!frames.length) return []
  const out: [number, number][] = []
  let start = frames[0]
  let prev = frames[0]
  for (const f of frames.slice(1)) {
    if (f - prev > 3) {
      out.push([start, prev])
      start = f
    }
    prev = f
  }
  out.push([start, prev])
  return out.map(([a, b]) => [
    Number((startTime + a / fps).toFixed(3)),
    Number((startTime + b / fps).toFixed(3)),
  ])
}

export interface SlotReport {
  x: number
  y: number
  presence: number
  readRate: number
  reads: number
  range: [number, number] | null
  score: SlotScore
}

/**
 * Parses the pass result and, if the counter is found, returns the own shot moments.
 *
 * `candidates` are the audio candidate moments of the product stage. Without them the moments
 * stay frame-based: ±33 ms precision at 30 fps, and track desync will not be corrected.
 */
export function shotsFromAmmo(
  scan: ScanResult,
  fps: number,
  candidates: number[],
  startTime = 0,
): AmmoResult | AmmoRejection {
  // Every plausible slot is carried through to the END — to shot moments and the audio
  // cross-check — and only then is the best one chosen.
  //
  // Choosing by score alone is wrong, and that cost two mistakes in a row. The score is a
  // heuristic of series shape, and a short noisy series easily takes the maximum: on `bizon` a
  // single-digit reserve remainder with range 0..9 scored 1.00 against 0.95 for the real
  // counter, and on `donk` an entirely unrelated row was taken for ammo.
  //
  // The real criterion is different and free: AN OWN SHOT ALWAYS MAKES A SOUND. On a real
  // counter decrements land on audio candidates; on a timer, the score or the reserve they do not.
  const scored: { slot: SlotResult; score: SlotScore; events: ShotEvents; alignment: Alignment }[] = []
  for (const slot of scan.slots) {
    // A holey series loses shots silently — better to honestly fall back to the old scheme.
    if (slot.series.readRate < MIN_READ_RATE) continue
    const score = scoreSeries(slot.series, fps)
    // A slot with a weapon switch passes the score threshold: its share of small decrements is low
    // not because it is not ammo but because the player switched weapons. The audio check below
    // weeds it out if it is foreign after all.
    if (score.score < MIN_SLOT_SCORE && !score.switchLike) continue
    // SELECTION uses UNFILTERED events, and that is not sloppiness.
    // The winner is decided by the number of audio-confirmed decrements; if weapon switches were
    // removed from a slot before selection, it would lose to one that never had them.
    // That is exactly how `ssg08` started picking the tournament scoreboard again. Cleaning is below, on the winner.
    const events = extractShots(slot.series, fps, startTime)
    if (!events.times.length) continue
    scored.push({ slot, score, events, alignment: align(events.times, candidates) })
  }

  const report = (slot: SlotResult, score: SlotScore): SlotReport => ({
    x: Number((slot.cx / Math.max(1, scan.width)).toFixed(3)),
    y: Number((slot.cy / Math.max(1, scan.height)).toFixed(3)),
    presence: Number(slot.presence.toFixed(3)),
    readRate: Number(slot.series.readRate.toFixed(3)),
    reads: slot.series.values.length,
    range: slot.series.values.length
      ? [Math.min(...slot.series.values), Math.max(...slot.series.values)]
      : null,
    score,
  })

  // Truncation is deliberately generous: the list goes only into the trace for analysis, and a
  // too-short list once led to a false conclusion — the sought location simply was not in it.
  const allSlots = (): SlotReport[] =>
    scan.slots.slice(0, 40).map((slot) => report(slot, scoreSeries(slot.series, fps)))

  if (!scored.length) {
    return { times: null, reason: 'подходящих слотов нет', best: null, slots: allSlots() }
  }

  // Keep as counter candidates only those with a high share of audio-confirmed decrements.
  // The threshold is not cosmetic: without it a row that matched the audio by chance got
  // the role.
  const confirmed = scored.filter(
    (c) =>
      c.events.times.length < MIN_EVENTS_FOR_SNAP_CHECK ||
      !candidates.length ||
      c.alignment.snapped / c.events.times.length >= MIN_SNAP_RATE,
  )

  if (!confirmed.length) {
    const nearest = scored.reduce((a, b) => (b.alignment.snapped > a.alignment.snapped ? b : a))
    const rate = nearest.alignment.snapped / nearest.events.times.length
    return {
      times: null,
      reason: `спуски не совпадают со звуком (${Math.round(rate * 100)}% притянуто)`,
      best: report(nearest.slot, nearest.score),
      slots: allSlots(),
    }
  }

  // Among the confirmed, take the one whose shots audio confirmed THE MOST. That is the counter:
  // the reserve remainder has a handful of decrements, the timer's are not on shots.
  const best = confirmed.reduce((a, b) =>
    b.alignment.snapped !== a.alignment.snapped
      ? b.alignment.snapped > a.alignment.snapped
        ? b
        : a
      : b.score.score > a.score.score
        ? b
        : a,
  )

  // CLEANING THE WINNER. The reserve tells a weapon switch from a burst: on a shot it holds,
  // on a switch it changes along with the magazine (`ssg08`: sniper 9 | 90, pistol 12 | 24).
  //
  // Applied only where there is an INDEPENDENT sign of a weapon switch — a low share of small
  // decrements — and where the reserve reads reliably. Without that caveat read noise ate real
  // shots on clips with no weapon change at all: `ak47` lost 2 of 20, `bizon` 3 of 60.
  const cleaned =
    best.score.switchLike && best.slot.reserve && best.slot.reserve.readRate >= MIN_RESERVE_READ_RATE
      ? extractShots(best.slot.series, fps, startTime, best.slot.reserve)
      : best.events
  const alignment = cleaned === best.events ? best.alignment : align(cleaned.times, candidates)

  return {
    times: alignment.times,
    slot: {
      x: best.slot.cx / Math.max(1, scan.width),
      y: best.slot.cy / Math.max(1, scan.height),
      presence: best.slot.presence,
      readRate: best.slot.series.readRate,
    },
    score: best.score,
    alignment,
    reloads: cleaned.reloads,
    slots: allSlots(),
    series: changePoints(best.slot, fps, startTime),
    readSpans: readSpansOf(best.slot.series.frames, fps, startTime),
    shotsVideo: cleaned.times,
  }
}

/** Change points of the series — between them the value is constant and need not be stored. */
function changePoints(slot: SlotResult, fps: number, startTime: number): [number, number][] {
  const out: [number, number][] = []
  let previous: number | null = null
  for (let i = 0; i < slot.series.values.length; i++) {
    const value = slot.series.values[i]
    if (value !== previous) {
      out.push([Number((startTime + slot.series.frames[i] / fps).toFixed(3)), value])
      previous = value
    }
  }
  return out
}
