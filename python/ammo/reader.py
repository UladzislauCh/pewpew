"""Reading HUD numbers: glyph -> digit, group -> number, slot -> per-frame series.

The classifier is nearest neighbour over a set of prototypes. Deliberately not a network: the
vocabulary is closed (ten symbols), there is one font, and the size is constant within a clip.
Everything here is rewritten in TypeScript without libraries, and that is a hard requirement —
otherwise we get an oracle that ships nowhere.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .glyphs import Glyph
from .scan import Slot, normalize_glyph

PROTOTYPES_PATH = Path(__file__).with_name('prototypes.json')

# Share of mismatched pixels above which a glyph is considered not a digit. Checked against the
# nearest prototype; cuts out letters of nicknames and banners that fit the digit shape.
MAX_GLYPH_DISTANCE = 0.22


@dataclass(frozen=True)
class Prototypes:
    cell: tuple[int, int]
    bits: np.ndarray  # (n, cell_h * cell_w) uint8
    digits: np.ndarray  # (n,) int

    @staticmethod
    def load(path: Path = PROTOTYPES_PATH) -> 'Prototypes':
        payload = json.loads(path.read_text(encoding='utf-8'))
        cell = tuple(payload['cell'])
        rows = [np.frombuffer(p['bits'].encode(), dtype=np.uint8) - ord('0') for p in payload['prototypes']]
        return Prototypes(
            cell=(int(cell[0]), int(cell[1])),
            bits=np.stack(rows).astype(np.uint8),
            digits=np.array([int(p['digit']) for p in payload['prototypes']], dtype=int),
        )


def classify(prototypes: Prototypes, glyph: Glyph) -> tuple[int, float]:
    """The digit and the distance to the nearest prototype. Digit -1 if none fits."""
    sample = normalize_glyph(glyph, prototypes.cell).flatten()
    distances = np.count_nonzero(prototypes.bits != sample, axis=1) / sample.size
    best = int(np.argmin(distances))
    d = float(distances[best])
    return (int(prototypes.digits[best]), d) if d <= MAX_GLYPH_DISTANCE else (-1, d)


def read_group(prototypes: Prototypes, glyphs: tuple[Glyph, ...]) -> int | None:
    """A number from a group of glyphs. None if any glyph is not recognised."""
    value = 0
    for glyph in glyphs:
        digit, _ = classify(prototypes, glyph)
        if digit < 0:
            return None
        value = value * 10 + digit
    return value


@dataclass
class Series:
    """Readings of one slot over the clip's frames."""

    frames: np.ndarray  # indices of frames where the number was read
    values: np.ndarray  # the numbers themselves
    read_rate: float  # share of the slot's frames where the number was read in full

    def __len__(self) -> int:
        return len(self.frames)


def read_slot(prototypes: Prototypes, slot: Slot, smooth: bool = True) -> Series:
    frames: list[int] = []
    values: list[int] = []
    for frame, glyphs in zip(slot.frames, slot.glyphs):
        value = read_group(prototypes, glyphs)
        if value is not None:
            frames.append(frame)
            values.append(value)
    rate = len(frames) / max(1, len(slot.frames))
    series = Series(np.array(frames, dtype=int), np.array(values, dtype=int), rate)
    return despike(series) if smooth else series


def despike(series: Series) -> Series:
    """Median over three neighbouring reads.

    The scene moves through the semi-transparent HUD, and one frame in a hundred is misread.
    Outliers look like 18-19-17 or 19-16-19: the value bounces and immediately returns.
    Each such outlier is an EXTRA decrement and an EXTRA increment, i.e. two false events.

    A median of three removes a single outlier in either direction and does not distort a
    monotonic decrease: for 19-18-17 the median is 18. It introduces no thresholds and needs no tuning.
    """
    if len(series) < 3:
        return series
    v = series.values
    smoothed = v.copy()
    smoothed[1:-1] = np.median(np.stack([v[:-2], v[1:-1], v[2:]]), axis=0).astype(int)
    return Series(series.frames, smoothed, series.read_rate)
