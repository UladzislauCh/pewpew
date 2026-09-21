/**
 * Own-flash anchor: two manually dissected clips are pinned down here.
 *
 * The numbers aren't made up — they're boxes from the `/eval/flashWhy.html` dump,
 * taken from real clips. Both cases the user found by eye during manual review
 * of the corpus.
 */
import { describe, expect, it } from 'vitest'
import { findOwnFlashes, isOwnFlash, type Spot } from '../src/domain/detection/flash/ownWeapon'

const spot = (cx: number, cy: number, areaPercent: number): Spot => {
  const side = Math.sqrt(areaPercent / 100)
  return { cx, cy, w: side, h: side }
}

/**
 * `cs2-m0nesy-donk-highlights`: own flash of 2.5-3.1% of the frame at 0.63,0.54 fired
 * FOUR times, while a ghost of 0.2-0.4% nearby, at 0.72,0.58, fired eleven times.
 *
 * The old rule picked the anchor by number of firings and took the ghost; on top of
 * that a radius of 0.12 covered both groups at once, so the area threshold filtered
 * out nothing. The user saw nine labels instead of four.
 */
const DONK: Spot[] = [
  spot(0.643, 0.54, 2.95),
  spot(0.627, 0.541, 3.14),
  spot(0.645, 0.54, 3.07),
  spot(0.619, 0.54, 2.47),
  ...[0.28, 0.31, 0.32, 0.31, 0.19, 0.31, 0.35, 0.41, 0.33, 0.29, 0.23].map((a, i) =>
    spot(0.715 + (i % 2) * 0.005, 0.585, a),
  ),
]

/** `neymar-perfect-clutch`: three firings, spread wider than any cluster. */
const NEYMAR: Spot[] = [spot(0.6, 0.45, 1.71), spot(0.65, 0.58, 3.14), spot(0.62, 0.96, 0.41)]

describe('own-flash anchor', () => {
  it('picks the large group, not the numerous one', () => {
    const own = findOwnFlashes(DONK)
    expect(own).toHaveLength(1)
    expect(own[0].cx).toBeCloseTo(0.64, 1)
    expect(100 * own[0].area).toBeGreaterThan(2)
  })

  it('filters out the ghost and keeps all four own flashes', () => {
    const own = findOwnFlashes(DONK)
    const kept = DONK.filter((s) => isOwnFlash(s, own))
    expect(kept).toHaveLength(4)
  })

  it('the size comparability requirement does the work, not a narrow radius', () => {
    // Checked separately: at radius 0.12, but with a comparable-size requirement,
    // the ghost doesn't join the group and still gets filtered out.
    const wide = findOwnFlashes(DONK, { radius: 0.12 })
    expect(DONK.filter((s) => isOwnFlash(s, wide, { radius: 0.12 }))).toHaveLength(4)

    // Without that requirement the groups merge, the median becomes ghost-sized (0.3%
    // instead of 2.9%), and the area threshold stops filtering anything out. This is
    // exactly the old behavior that put nine labels on the clip instead of four.
    const merged = findOwnFlashes(DONK, { radius: 0.12, spread: 100 })
    expect(100 * merged[0].area).toBeLessThan(1)
    expect(DONK.filter((s) => isOwnFlash(s, merged, { radius: 0.12 }))).toHaveLength(DONK.length)
  })

  it('tolerates a weapon switch: a second anchor of the same scale is accepted', () => {
    // Same clip plus a second gun elsewhere in the frame, of comparable size.
    const second = [spot(0.4, 0.62, 1.9), spot(0.405, 0.618, 2.1)]
    const own = findOwnFlashes([...DONK, ...second])
    expect(own.length).toBeGreaterThanOrEqual(2)
    expect(second.every((s) => isOwnFlash(s, own))).toBe(true)
  })

  it('builds no anchor when firings are scattered', () => {
    // The two-member requirement protects against a single large false box setting
    // the scale and wiping out the clip. The cost is that a foreign flash stays on `neymar`.
    expect(findOwnFlashes(NEYMAR)).toHaveLength(0)
    expect(NEYMAR.every((s) => isOwnFlash(s, []))).toBe(true)
  })

  it('with single-anchor tolerance, the foreign flash on neymar is filtered out', () => {
    const own = findOwnFlashes(NEYMAR, { minMembers: 1 })
    const kept = NEYMAR.filter((s) => isOwnFlash(s, own, { minMembers: 1 }))
    expect(kept).toHaveLength(2)
  })
})

describe('two distances: narrow clustering, wide acceptance', () => {
  /**
   * `this-isn-t-legal`: two shots from the SAME AWP ended up 0.149 apart in the frame —
   * scoping in, or a crop change between edit cuts. User: "a critical label got
   * wiped out, the first one was erased".
   */
  const AWP_TWICE: Spot[] = [spot(0.78, 0.59, 6.03), spot(0.64, 0.54, 0.94), spot(0.64, 0.54, 1.14)]

  /** `dual-berettas`: two pistols in different hands, 0.26 frame fraction between guns. */
  const DUALS: Spot[] = [
    ...Array.from({ length: 6 }, (_, i) => spot(0.47 + i * 0.002, 0.57, 13 + i)),
    ...Array.from({ length: 5 }, (_, i) => spot(0.73 + i * 0.002, 0.56, 7 + i)),
  ]

  it('wide acceptance reclaims a shot that drifted from the anchor', () => {
    const own = findOwnFlashes(AWP_TWICE)
    expect(AWP_TWICE.every((s) => isOwnFlash(s, own))).toBe(true)
  })

  it('narrow clustering does not merge two guns into one', () => {
    expect(findOwnFlashes(DUALS)).toHaveLength(2)
    // A wide cluster gives a single anchor — and the second pistol's flashes disappear.
    expect(findOwnFlashes(DUALS, { radius: 0.3 })).toHaveLength(1)
  })

  it('wide acceptance does not reclaim the ghost: scale filters it out', () => {
    const own = findOwnFlashes(DONK)
    expect(DONK.filter((s) => isOwnFlash(s, own))).toHaveLength(4)
  })
})
