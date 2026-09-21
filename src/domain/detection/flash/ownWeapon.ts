/**
 * Reference of the OWN flash, derived from the clip itself.
 *
 * WHY. The model finds flashes of others' shots too. Confidence barely separates them (0.87 own
 * against 0.73 foreign; on another clip 0.91 against 0.89), nor does the class: a foreign flash
 * is the same `muzzle_flash`. A cue the model does not have is needed.
 *
 * TWO CUES, AND THEY ANSWER DIFFERENT QUESTIONS.
 *
 * SCALE answers "whose flash". The own weapon is closer to the camera than anything foreign —
 * that is geometry, not statistics, and the gap matches: 10x on `donk`, 8x on `neymar`, 35x on
 * the `awp` analysed earlier. There is ONE scale per clip.
 *
 * POSITION answers "is this the same weapon". There can be SEVERAL positions per clip: a weapon
 * switch moves the muzzle along the barrel length, scoping moves the flash elsewhere with the
 * same weapon, and the corpus is someone else's edit, where crop and zoom change between cuts.
 *
 * And here there are TWO DIFFERENT DISTANCES, which took a separate manual check. Clusters are
 * searched narrowly (0.05): otherwise two barrels in the frame merge into one. Hits are accepted
 * widely (0.15): the flash of one barrel wanders more than it seems — on `this-isn-t-legal` two
 * shots from the same AWP were 0.149 of the frame apart.
 *
 * WHY NOT COUNT HITS. The old version picked the anchor by hit count, and on `donk` that gave
 * exactly the wrong answer: a ghost of 0.3% of the area blinked 15 times, the own barrel at 2.9%
 * blinked 4 times. The shooter pulls the trigger a few times, a firefight in the background
 * blinks as much as it likes. Frequency is backed by nothing.
 *
 * WHY NOT A FIXED AREA THRESHOLD. The box is measured as a fraction of the WHOLE frame, and the
 * game occupies a different part of it: in some clips gameplay is a narrow band in the middle,
 * with a cut-out figure of the player below and a banner above. There the own flash takes two to
 * three times less of the frame and falls under the same threshold that cuts the foreign one.
 *
 * The project has used the same trick before: the ammo counter identifies its slot by the
 * BEHAVIOUR of the series, not by a fixed position on screen.
 */

export interface Spot {
  cx: number
  cy: number
  w: number
  h: number
}

export interface OwnFlash {
  /** Median centre of the cluster. */
  cx: number
  cy: number
  /** Median box area, fraction of the frame. */
  area: number
  /** How many hits went into the cluster. */
  members: number
}

export interface OwnFlashOptions {
  /**
   * Cluster radius as a fraction of the frame.
   *
   * Measured: the own flash stays within 0.02-0.03 over the whole clip. The old 0.12 was four
   * times too wide and on `donk` also covered a ghost 0.098 from the barrel — two tight clusters
   * stuck together, and the median area of the merged one (0.35%) cut nothing.
   */
  radius?: number
  /**
   * How far from an anchor a hit is accepted, as a fraction of the frame.
   *
   * SEPARATE FROM THE CLUSTER RADIUS, and that is not a detail: the two numbers answer different
   * questions. A cluster must be NARROW, otherwise two barrels in the frame merge into one
   * (`dual-berettas`: pistols at 0.47,0.57 and 0.73,0.56 give one anchor with a wide radius, and
   * the right one's flashes are thrown out). Acceptance must be WIDE, because the flash of the
   * same barrel wanders: recoil, scoping, and in someone else's edit also crop changes between cuts.
   *
   * Measured by manual check: on `galil` two single shots at the end landed 0.06 from the anchor,
   * on `this-isn-t-legal` the first AWP shot at 0.149. Both correct, and narrow acceptance lost them.
   */
  acceptRadius?: number
  /**
   * By how many times boxes within one cluster may differ in area.
   *
   * Without this one cluster gathers hits of different scales, and its median describes none
   * of them.
   */
  spread?: number
  /** How many hits a cluster needs to count as an anchor. */
  minMembers?: number
  /** Maximum number of anchors: as many as there are weapons and camera angles in the clip. */
  maxReferences?: number
  /** By how many times an anchor may be smaller than the main one and still be the own weapon. */
  secondaryRatio?: number
}

export const OWN_FLASH_DEFAULTS: Required<OwnFlashOptions> = {
  radius: 0.05,
  acceptRadius: 0.15,
  spread: 3,
  minMembers: 2,
  maxReferences: 4,
  secondaryRatio: 1 / 3,
}

/**
 * By how many times a box may be smaller than the reference and still count as own.
 *
 * Three times — with margin for the flash fading towards its end: the last frame of a flash is
 * noticeably paler and smaller than the first. Measured on `awp-flicks`: the same flash gave
 * 5.49% and 2.45% on neighbouring frames, i.e. 2.2x, and a third just barely passes.
 */
const MIN_AREA_RATIO = 1 / 3

const areaOf = (s: Spot) => s.w * s.h
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}

/**
 * Find anchors of the own flash: one per barrel position in the clip.
 *
 * Clusters are tried with each hit as the centre; a member is whatever is nearby AND comparable
 * in area. The main anchor is the one with the largest TOTAL area: the own weapon gives either
 * many flashes or large ones, and total area catches both cases, whereas member count catches
 * only the first and is fooled by a ghost.
 *
 * Further anchors are gathered from the remaining hits while their scale is comparable to the
 * main one. That is the tolerance to weapon switches: another barrel gives another place, but
 * cannot give a flash five times smaller — it is still in the camera's hands.
 *
 * An empty list means "nothing to filter with"; the caller does not filter at all, because
 * cutting blindly is worse than letting extras through.
 */
export function findOwnFlashes(spots: Spot[], options: OwnFlashOptions = {}): OwnFlash[] {
  const opts = { ...OWN_FLASH_DEFAULTS, ...options }
  let rest = spots.filter((s) => s.w > 0 && s.h > 0)
  const found: OwnFlash[] = []

  while (rest.length && found.length < opts.maxReferences) {
    let best: { members: Spot[]; weight: number } | null = null
    for (const seed of rest) {
      const seedArea = areaOf(seed)
      const members = rest.filter((s) => {
        if (Math.hypot(s.cx - seed.cx, s.cy - seed.cy) > opts.radius) return false
        const a = areaOf(s)
        return a <= seedArea * opts.spread && a * opts.spread >= seedArea
      })
      if (members.length < opts.minMembers) continue
      const weight = members.reduce((sum, s) => sum + areaOf(s), 0)
      if (!best || weight > best.weight) best = { members, weight }
    }
    if (!best) break

    const reference: OwnFlash = {
      cx: median(best.members.map((s) => s.cx)),
      cy: median(best.members.map((s) => s.cy)),
      area: median(best.members.map(areaOf)),
      members: best.members.length,
    }
    // Scale is set by the MAIN anchor: it is about how far the camera is from its own weapon,
    // and that is one per clip. An anchor smaller than a third of the main one is not the own weapon.
    if (found.length && reference.area < opts.secondaryRatio * found[0].area) break
    found.push(reference)
    const taken = new Set(best.members)
    rest = rest.filter((s) => !taken.has(s))
  }
  return found
}

/**
 * Whether a hit looks like the own flash.
 *
 * Position is checked against ANY anchor — the barrel may have changed in the clip. Scale is
 * checked only against the main one: it alone accounts for the own weapon being closer to the camera.
 */
export function isOwnFlash(
  spot: Spot | null,
  own: OwnFlash[],
  options: OwnFlashOptions = {},
): boolean {
  // No anchors — do not filter. Cutting blindly is worse than letting extras through.
  if (!own.length || !spot || spot.w <= 0) return true
  if (areaOf(spot) < MIN_AREA_RATIO * own[0].area) return false
  const radius = options.acceptRadius ?? OWN_FLASH_DEFAULTS.acceptRadius
  return own.some((o) => Math.hypot(spot.cx - o.cx, spot.cy - o.cy) <= radius)
}
