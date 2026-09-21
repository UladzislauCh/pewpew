"""Operating curve: a quantity as an event GENERATOR, not as AUC.

AUC flatters at a 1 to 23 class imbalance. Here we compute what is visible in the product: how many
extra EVENTS there are per found shot. An event is a local maximum of the quantity with neighbour
suppression, a hit is within a frame tolerance.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SUPPRESS = 3
TOLERANCE = 1
FIELDS = ('diff_raw', 'resid_shift', 'resid_affine', 'field_spread', 'shift_mag')


def peaks(v: np.ndarray) -> np.ndarray:
    """Indices of local maxima, sorted by descending value."""
    order = np.argsort(-v)
    taken = np.zeros(len(v), dtype=bool)
    out = []
    for i in order:
        lo, hi = max(0, i - SUPPRESS), min(len(v), i + SUPPRESS + 1)
        if taken[lo:hi].any():
            continue
        taken[i] = True
        out.append(i)
    return np.asarray(out, dtype=int)


def main() -> None:
    data = json.loads((ROOT / 'python/out/recoilProbe.json').read_text(encoding='utf-8'))
    print(f'{"величина":14s} {"полнота":>8s} {"точность":>9s} {"лишних на выстрел":>18s}')
    for name in FIELDS:
        # The threshold is set as a fraction within the clip, because quantity scales differ between clips.
        for keep in (0.02, 0.04, 0.08, 0.15):
            hit = miss = extra = 0
            for clip in data:
                v = np.asarray(clip['series'][name], dtype=np.float64)
                shots = np.asarray([s for s in clip['shots'] if 1 <= s < len(v)], dtype=int)
                if len(shots) < 3:
                    continue
                picked = peaks(v)[:max(1, int(round(keep * len(v))))]
                used = np.zeros(len(shots), dtype=bool)
                for p in picked:
                    d = np.abs(shots - p)
                    j = int(np.argmin(d))
                    if d[j] <= TOLERANCE and not used[j]:
                        used[j] = True
                    else:
                        extra += 1
                hit += int(used.sum())
                miss += int((~used).sum())
            recall = 100 * hit / max(1, hit + miss)
            precision = 100 * hit / max(1, hit + extra)
            print(f'{name:14s} {recall:7.1f}% {precision:8.1f}% {extra / max(1, hit):18.2f}')
        print()


if __name__ == '__main__':
    main()
