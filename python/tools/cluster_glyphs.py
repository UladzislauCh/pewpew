"""Exploration: clustering a clip's glyphs and a contact sheet for labelling by eye.

Digit prototypes are gathered from REAL frames, not drawn from a font. The CS2 HUD is
semi-transparent, the scene moves through it, and a synthetic glyph will not reproduce that —
the project has already caught such a signature of synthetic data.
"""

from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ammo.scan import normalize_glyph, scan_video  # noqa: E402

CELL = (16, 24)
# Share of mismatched pixels at which glyphs count as the same digit. Chosen so that "8" and "0"
# do not stick together, while the same glyph from different frames does not split.
MERGE_DISTANCE = 0.13


def cluster(samples: list[np.ndarray], max_clusters: int = 40) -> list[tuple[np.ndarray, int]]:
    """Greedy clustering by share of mismatched pixels. Returns (prototype, size)."""
    centers: list[np.ndarray] = []
    counts: list[int] = []
    sums: list[np.ndarray] = []

    for sample in samples:
        best, best_d = -1, float('inf')
        for i, center in enumerate(centers):
            d = float(np.count_nonzero(center != sample)) / sample.size
            if d < best_d:
                best, best_d = i, d
        if best >= 0 and best_d <= MERGE_DISTANCE:
            counts[best] += 1
            sums[best] += sample
            centers[best] = (sums[best] * 2 >= counts[best]).astype(np.uint8)
        elif len(centers) < max_clusters:
            centers.append(sample.copy())
            counts.append(1)
            sums.append(sample.astype(np.int32))

    order = np.argsort(counts)[::-1]
    return [(centers[i], counts[i]) for i in order]


def contact_sheet(clusters: list[tuple[np.ndarray, int]], scale: int = 8, cols: int = 8) -> np.ndarray:
    """Prototypes in a grid, labelled with an ordinal number and cluster size."""
    cw, ch = CELL[0] * scale, CELL[1] * scale
    pad, label_h = 10, 22
    rows = (len(clusters) + cols - 1) // cols
    sheet = np.zeros((rows * (ch + label_h + pad) + pad, cols * (cw + pad) + pad), np.uint8)
    for i, (center, count) in enumerate(clusters):
        r, c = divmod(i, cols)
        x = pad + c * (cw + pad)
        y = pad + r * (ch + label_h + pad)
        big = cv2.resize(center * 255, (cw, ch), interpolation=cv2.INTER_NEAREST)
        sheet[y + label_h : y + label_h + ch, x : x + cw] = big
        cv2.putText(sheet, f'#{i} n={count}', (x, y + 15), cv2.FONT_HERSHEY_SIMPLEX, 0.45, 255, 1)
    return sheet


def main() -> None:
    video = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else 'python/out/clusters.png'
    # Optional slot filter: relative x,y. Needed for exploration when the ammo has already been
    # found by eye — otherwise letters from banners and nicknames get into the clusters.
    want = None
    if len(sys.argv) > 4:
        want = (float(sys.argv[3]), float(sys.argv[4]))

    result = scan_video(video)
    samples: list[np.ndarray] = []
    used = 0
    for slot in result.slots:
        if want is not None:
            rel = (slot.cx / result.width, slot.cy / result.height)
            if abs(rel[0] - want[0]) > 0.03 or abs(rel[1] - want[1]) > 0.02:
                continue
        used += 1
        for group in slot.glyphs:
            for glyph in group:
                samples.append(normalize_glyph(glyph, CELL))

    clusters = cluster(samples)
    print(f'слотов взято {used}, глифов {len(samples)}, кластеров {len(clusters)}')
    for i, (_, count) in enumerate(clusters):
        print(f'  #{i}: {count}')

    cv2.imwrite(out, contact_sheet(clusters))
    print(f'контактный лист -> {out}')


if __name__ == '__main__':
    main()
