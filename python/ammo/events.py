"""Ammo reading series -> own shot moments."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .reader import Series

# A decrement larger than this is not a burst but a read error or an editing cut.
MAX_BURST_PER_STEP = 3


@dataclass(frozen=True)
class ShotEvents:
    times: list[float]
    reloads: list[float]
    skipped: int  # decrements discarded as implausible


def extract_shots(series: Series, fps: float, start_time: float = 0.0) -> ShotEvents:
    """Shots from counter decrements.

    The moment is placed on the FRAME where the new value is first visible, not midway between
    frames. The reason is how the game draws a shot: the flash and the counter change land on the
    SAME frame — checked by pixels on m4a4 (frames 101, 104, 107) and on xm1014 (frame 50). So the
    shot happened at the moment that frame shows.

    The old midpoint pulled events half a frame back. Measured on 323 pairs with confident matching:
    the median "label minus event" was +15 ms with half a frame being 16.7 ms — a match to the tenth.

    Video cannot be more precise than a frame in principle; audio refines the moment, see align.py.
    """
    times: list[float] = []
    reloads: list[float] = []
    skipped = 0

    def at(frame: float) -> float:
        return start_time + frame / fps

    values, frames = series.values, series.frames
    for i in range(1, len(values)):
        step = int(values[i]) - int(values[i - 1])
        if step == 0:
            continue

        moment = at(frames[i])

        if step > 0:
            reloads.append(moment)
            continue

        drop = -step
        if drop > MAX_BURST_PER_STEP:
            skipped += 1
            continue

        if drop == 1:
            times.append(moment)
            continue

        # Several shots in one frame interval: spread them evenly over it, ending at the frame where
        # the new value is visible. Video here cannot know the exact moments in principle.
        start, end = at(frames[i - 1]), at(frames[i])
        for k in range(drop):
            times.append(start + (end - start) * (k + 1) / drop)

    return ShotEvents(times=sorted(times), reloads=sorted(reloads), skipped=skipped)
