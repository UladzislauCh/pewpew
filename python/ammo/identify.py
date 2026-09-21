"""Identifying the ammo slot among HUD numbers — by BEHAVIOUR, not by position.

Why not by position: there are at least three layouts (native HUD, tournament broadcast,
cropped framing), and coordinates cannot be a constant.

Why not by appearance: health and armour are drawn in the same font at the same size. An earlier
attempt failed exactly here — it COUNTED CHANGES, and a change looks the same for ammo and for
health. Here VALUES are read, and then the difference is obvious:

    ammo       drops by exactly 1 per shot, jumps back to the magazine size
    health     drops by any amount (5..40), does not return to the maximum
    armour     the same
    timer      also drops by 1, but EXACTLY once a second

The timer is the only real competitor, and it is separated by irregularity: in firing the
intervals between decrements are ragged, in a timer they are constant.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .reader import Series

# Magazine sizes in CS2: from 5 (revolver/shotguns) to 150 (Negev). Anything outside this range
# cannot be an ammo reading.
MIN_MAGAZINE = 5
MAX_MAGAZINE = 150

# Share of decrements that must be small (1..3). Not 1.0, because in fast fire several shots fall
# into one frame interval.
MIN_SMALL_STEP_RATIO = 0.65

# Spread of intervals between decrements below which the series counts as regular, i.e. a timer.
# The measure is the ratio of SD to mean.
TIMER_REGULARITY = 0.35


@dataclass(frozen=True)
class SlotScore:
    score: float
    magazine: int | None
    descents: int
    small_step_ratio: float
    interval_spread: float
    reloads: int
    reason: str


def score_series(series: Series, fps: float) -> SlotScore:
    """How much the series looks like ammo. 0 — not at all, 1 — confidently it."""
    if len(series) < 20:
        return SlotScore(0.0, None, 0, 0.0, 0.0, 0, 'слишком короткий ряд')

    values = series.values
    frames = series.frames

    if values.max() < MIN_MAGAZINE or values.max() > MAX_MAGAZINE:
        return SlotScore(0.0, None, 0, 0.0, 0.0, 0, f'диапазон {values.min()}..{values.max()}')

    steps = np.diff(values)
    at = frames[1:]
    descents = at[steps < 0]
    drops = -steps[steps < 0]
    if len(drops) < 3:
        return SlotScore(0.0, None, 0, 0.0, 0.0, 0, 'спусков почти нет')

    small = float(np.count_nonzero(drops <= 3) / len(drops))

    gaps = np.diff(descents)
    spread = float(np.std(gaps) / np.mean(gaps)) if len(gaps) >= 3 and np.mean(gaps) > 0 else 1.0

    # Reload: a jump up, and to the same value each time. Health has no upward jumps at all, a timer
    # does, but to different values and once per round.
    ups = values[1:][steps > 0]
    magazine = None
    reloads = 0
    if len(ups):
        seen, counts = np.unique(ups, return_counts=True)
        top = int(np.argmax(counts))
        if counts[top] >= 2 and MIN_MAGAZINE <= seen[top] <= MAX_MAGAZINE:
            magazine = int(seen[top])
            reloads = int(counts[top])

    # Timer: drops by one, but regularly, and the step is close to a second.
    second = fps
    steady = spread < TIMER_REGULARITY and len(gaps) >= 5
    near_second = steady and 0.7 * second <= np.mean(gaps) <= 1.4 * second
    if near_second and magazine is None:
        return SlotScore(0.0, None, len(drops), small, spread, 0, 'равномерно раз в секунду — таймер')

    if small < MIN_SMALL_STEP_RATIO:
        return SlotScore(0.0, None, len(drops), small, spread, reloads, f'спуски крупные ({small:.0%} мелких)')

    score = 0.45 * small
    score += 0.30 * min(1.0, spread / TIMER_REGULARITY)
    if magazine is not None:
        score += 0.25
    reason = 'похоже на боезапас' if score >= 0.6 else 'слабо'
    return SlotScore(float(score), magazine, len(drops), small, spread, reloads, reason)
