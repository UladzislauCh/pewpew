"""Extracting HUD glyphs from a frame.

The only thing that happens here is finding bright connected blobs that look like a digit and
joining them into horizontal groups ("16", "90", "100").

On the threshold. The CS2 HUD is semi-transparent, the moving scene shows through it, so
comparing brightness works poorly while comparing binary masks works well. The threshold is
high: digits are clearly brighter than the scene, and it cuts the scene out entirely.

On the CHANNEL. The threshold is applied to the max of R, G, B, not to Rec.601 luma. The reason
was measured: at low ammo CS2 paints the counter orange, and near the end red, and red ink has a
Rec.601 luma of 155 against a threshold of 190 — i.e. the digits vanish ENTIRELY. Measured on
`kyousuke`, frame 500: 0 pixels above threshold by luma, 147 by channel max. For white digits
there is no difference (276 against 280), so this is a pure gain.

It is important not to get WHEN this happens wrong. The colour depends on the magazine
remainder, NOT on whether a burst is in progress: a three-round burst from a full magazine is
drawn white from start to finish. Red digits are the last part of the magazine, wherever it
happens to fall, and that can be a burst or single shots alike.

How large this share is in real clips has not been measured. All that is known is that after
the fix readability jumped: scar20 48% -> 100%, g3sg1 77% -> 99%, kyousuke 91% -> 99%.

On porting. Everything here is a threshold, connected components and sorting by coordinate.
It can be rewritten in TypeScript in an evening, no library peculiarities.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

# Binarisation threshold. 190 comes from the project journal: there comparing binary masks at this
# threshold gave a separation of 0.982 against 0.830 for comparing brightness.
BINARY_THRESHOLD = 190

# Bounds of "looks like a digit", as fractions of the frame height. HUD digits are large but not
# huge; the bounds cut out both scene dust and large overlay captions.
MIN_GLYPH_HEIGHT = 0.010
MAX_GLYPH_HEIGHT = 0.060

# A digit is taller than wide, but not infinitely: "1" is narrow, "0" is wide.
MIN_ASPECT = 0.15
MAX_ASPECT = 1.30

# Share of filled pixels inside the box. A solid rectangle is not a digit.
MIN_FILL = 0.15
MAX_FILL = 0.92


@dataclass(frozen=True)
class Glyph:
    """One bright blob that passed the "looks like a digit" check."""

    x: int
    y: int
    w: int
    h: int
    mask: np.ndarray  # binary mask inside the box, uint8 0/1

    @property
    def cx(self) -> float:
        return self.x + self.w / 2

    @property
    def cy(self) -> float:
        return self.y + self.h / 2


@dataclass(frozen=True)
class Group:
    """A horizontal group of glyphs — one number on screen."""

    glyphs: tuple[Glyph, ...]

    @property
    def x(self) -> int:
        return min(g.x for g in self.glyphs)

    @property
    def y(self) -> int:
        return min(g.y for g in self.glyphs)

    @property
    def right(self) -> int:
        return max(g.x + g.w for g in self.glyphs)

    @property
    def bottom(self) -> int:
        return max(g.y + g.h for g in self.glyphs)

    @property
    def cx(self) -> float:
        return (self.x + self.right) / 2

    @property
    def cy(self) -> float:
        return (self.y + self.bottom) / 2

    def __len__(self) -> int:
        return len(self.glyphs)


def to_ink(frame: np.ndarray) -> np.ndarray:
    """Frame -> single-channel image in which HUD ink is searched.

    Channel max, not luma: coloured low-ammo digits fall entirely below the threshold by luma.
    Details in the module header.
    """
    return frame.max(axis=2) if frame.ndim == 3 else frame


def binarize(gray: np.ndarray, threshold: int = BINARY_THRESHOLD) -> np.ndarray:
    """Binary mask of bright pixels, 0/1 uint8."""
    return (gray >= threshold).astype(np.uint8)


def find_glyphs(gray: np.ndarray, threshold: int = BINARY_THRESHOLD) -> list[Glyph]:
    """Connected components of a binary mask, filtered by digit shape."""
    frame_h = gray.shape[0]
    binary = binarize(gray, threshold)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)

    min_h = MIN_GLYPH_HEIGHT * frame_h
    max_h = MAX_GLYPH_HEIGHT * frame_h

    out: list[Glyph] = []
    for i in range(1, count):
        x, y, w, h, area = (
            stats[i, cv2.CC_STAT_LEFT],
            stats[i, cv2.CC_STAT_TOP],
            stats[i, cv2.CC_STAT_WIDTH],
            stats[i, cv2.CC_STAT_HEIGHT],
            stats[i, cv2.CC_STAT_AREA],
        )
        if not (min_h <= h <= max_h):
            continue
        aspect = w / h
        if not (MIN_ASPECT <= aspect <= MAX_ASPECT):
            continue
        fill = area / (w * h)
        if not (MIN_FILL <= fill <= MAX_FILL):
            continue
        mask = (labels[y : y + h, x : x + w] == i).astype(np.uint8)
        out.append(Glyph(int(x), int(y), int(w), int(h), mask))

    return out


def group_glyphs(glyphs: list[Glyph], max_digits: int = 3) -> list[Group]:
    """Joining glyphs into numbers.

    Two glyphs belong to one number if they stand on the same row (matching in height and
    vertical centre) and are separated by a gap smaller than a digit's width. More than
    `max_digits` in a row is no longer a HUD reading but a caption, and such a group is dropped.
    """
    if not glyphs:
        return []

    # Rows first, then adjacency within a row. Sorting straight by (cy, x) is wrong: centres of
    # neighbouring digits of one number differ by fractions of a pixel, and anything at the same
    # height at the other end of the frame wedges between them in traversal order. That is
    # exactly how "16" fell apart into "1" and "6".
    rows: list[list[Glyph]] = []
    for glyph in sorted(glyphs, key=lambda g: g.cy):
        for row in rows:
            ref = row[-1]
            if abs(glyph.cy - ref.cy) <= 0.4 * max(glyph.h, ref.h):
                row.append(glyph)
                break
        else:
            rows.append([glyph])

    groups: list[list[Glyph]] = []
    for row in rows:
        ordered = sorted(row, key=lambda g: g.x)
        current: list[Glyph] = [ordered[0]]
        for glyph in ordered[1:]:
            prev = current[-1]
            same_size = abs(glyph.h - prev.h) <= 0.30 * max(glyph.h, prev.h)
            gap = glyph.x - (prev.x + prev.w)
            close = -0.2 * prev.h <= gap <= 0.85 * max(glyph.h, prev.h)
            if same_size and close:
                current.append(glyph)
            else:
                groups.append(current)
                current = [glyph]
        groups.append(current)

    return [Group(tuple(g)) for g in groups if 1 <= len(g) <= max_digits]
