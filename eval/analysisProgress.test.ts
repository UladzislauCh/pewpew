import { describe, expect, it } from 'vitest'
import {
  CREEP_CEILING,
  estimateAnalysisSeconds,
  FINISH_MS,
  progressAt,
  remainingSeconds,
} from '../src/features/wizard/model/analysisProgress'

describe('parsing time estimate', () => {
  it('a 30fps clip costs 0.6 of its length', () => {
    expect(estimateAnalysisSeconds(20, 30)).toBeCloseTo(12)
  })

  it('a 60fps clip costs 1.1: twice the frames', () => {
    expect(estimateAnalysisSeconds(20, 60)).toBeCloseTo(22)
  })

  it('assumes 30fps when the frame rate is unknown', () => {
    expect(estimateAnalysisSeconds(20, null)).toBeCloseTo(12)
  })

  it('never promises less than a second', () => {
    expect(estimateAnalysisSeconds(0.2, 30)).toBe(1)
  })
})

describe('progress bar', () => {
  const running = { estimateMs: 10_000, doneAtMs: null, doneAtValue: 0 }

  it('tracks the estimate exactly', () => {
    expect(progressAt({ ...running, elapsedMs: 5_000 })).toBeCloseTo(0.5)
    expect(progressAt({ ...running, elapsedMs: 9_000 })).toBeCloseTo(0.9)
  })

  it('stops at 97% and waits for work to finish', () => {
    // A 10x estimate miss won't budge the bar: it stays put and waits.
    expect(progressAt({ ...running, elapsedMs: 9_700 })).toBeCloseTo(CREEP_CEILING)
    expect(progressAt({ ...running, elapsedMs: 30_000 })).toBeCloseTo(CREEP_CEILING)
    expect(progressAt({ ...running, elapsedMs: 100_000 })).toBeCloseTo(CREEP_CEILING)
  })

  it('finishes the remainder in half a second from ANY fraction', () => {
    // Parsing finished before the estimate, at forty percent: the remainder still
    // takes the same half second to fill in, not a single-frame jump.
    const early = { estimateMs: 10_000, doneAtMs: 4_000, doneAtValue: 0.4 }
    expect(progressAt({ ...early, elapsedMs: 4_000 })).toBeCloseTo(0.4)
    expect(progressAt({ ...early, elapsedMs: 4_000 + FINISH_MS / 2 })).toBeCloseTo(0.7)
    expect(progressAt({ ...early, elapsedMs: 4_000 + FINISH_MS })).toBe(1)

    // Parsing finished after the estimate, the bar was already at the ceiling.
    const late = { estimateMs: 10_000, doneAtMs: 20_000, doneAtValue: CREEP_CEILING }
    expect(progressAt({ ...late, elapsedMs: 20_000 + FINISH_MS / 2 })).toBeCloseTo(0.985)
    expect(progressAt({ ...late, elapsedMs: 20_000 + FINISH_MS })).toBe(1)
  })

  it('stays at zero without an estimate, instead of creeping toward an asymptote', () => {
    // While the clip is being read, its duration is unknown. This used to default
    // to one, so the bar started at 90% and jumped back once an estimate appeared.
    expect(progressAt({ elapsedMs: 3_000, estimateMs: 0, doneAtMs: null, doneAtValue: 0 })).toBe(0)
  })

  it('does not exceed a hundred after a second', () => {
    const done = { estimateMs: 10_000, doneAtMs: 1_000, doneAtValue: 0.1 }
    expect(progressAt({ ...done, elapsedMs: 60_000 })).toBe(1)
  })
})

describe('remaining time estimate', () => {
  it('is computed from the progress fraction', () => {
    expect(remainingSeconds(0.3, 10_000)).toBe(7)
  })

  it('stays put together with the bar at the ceiling', () => {
    expect(remainingSeconds(CREEP_CEILING, 10_000)).toBe(1)
  })

  it('is zero only at a hundred percent', () => {
    expect(remainingSeconds(0.999, 10_000)).toBe(1)
    expect(remainingSeconds(1, 10_000)).toBe(0)
  })

  it('reaches zero together with the bar, no matter what the estimate leaves', () => {
    // Work finished at forty percent: the estimate said 18 seconds remained,
    // but the bar will fill in half a second — and the ETA follows it down.
    const done = { estimateMs: 30_000, doneAtMs: 12_000, doneAtValue: 0.4 }
    const half = progressAt({ ...done, elapsedMs: 12_000 + FINISH_MS / 2 })
    expect(remainingSeconds(0.4, 30_000)).toBe(18)
    expect(remainingSeconds(half, 30_000)).toBe(9)
    expect(remainingSeconds(progressAt({ ...done, elapsedMs: 12_000 + FINISH_MS }), 30_000)).toBe(0)
  })
})
