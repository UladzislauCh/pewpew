"""Analysis of one clip: which slots were found and why none was accepted as ammo.

A hook for intermediate quantities. Without it a discrepancy is localised by guessing — a rule from
`docs/PYTHON-track.md`, paid for with a separate bug.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ammo.identify import score_series  # noqa: E402
from ammo.reader import Prototypes, read_slot  # noqa: E402
from ammo.scan import scan_video  # noqa: E402


def main() -> None:
    video = sys.argv[1]
    top = int(sys.argv[2]) if len(sys.argv) > 2 else 18

    protos = Prototypes.load()
    scan = scan_video(video)
    print(f'{video}: {scan.width}x{scan.height}, {scan.frame_count} кадров, fps {scan.fps:.2f}, слотов {len(scan.slots)}')
    print()
    print('  доля  кадров  прочит  позиция          выс  диапазон    спусков  мелких  разброс  балл  причина')

    rows = []
    for slot in scan.slots:
        series = read_slot(protos, slot)
        score = score_series(series, scan.fps)
        rows.append((score.score, slot, series, score))

    rows.sort(key=lambda r: (-r[0], -len(r[1].frames)))
    for value, slot, series, score in rows[:top]:
        rel = (slot.cx / scan.width, slot.cy / scan.height)
        rng = f'{series.values.min()}..{series.values.max()}' if len(series) else '-'
        life = len(slot.frames) / max(1, scan.frame_count)
        print(
            f'  {life:4.0%}  {len(slot.frames):6d}  {series.read_rate:6.0%}  '
            f'({rel[0]:.3f},{rel[1]:.3f})  {slot.height:4.0f}  {rng:>10s}  '
            f'{score.descents:7d}  {score.small_step_ratio:6.0%}  {score.interval_spread:7.2f}  '
            f'{value:4.2f}  {score.reason}'
        )

    if rows and len(rows[0][2]):
        best = rows[0][2]
        shown, prev = 0, None
        print('\n  ряд лучшего слота:')
        for f, v in zip(best.frames, best.values):
            if v != prev and shown < 40:
                print(f'    кадр {f:5d}  t={f / scan.fps:6.2f}  = {v}')
                shown += 1
            prev = v


if __name__ == '__main__':
    main()
