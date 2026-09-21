"""How readable the RESERVE ammo is — the number to the right of the magazine.

A narrow question: the reader finds the reserve slot but reads it on zero frames. Here one can see
exactly what it trips on — the glyph height filter or the classifier.

The reserve is needed not for the digits themselves but for an INVARIANT: it stays put while the
magazine decreases, and drops by exactly as much as the magazine jumps. Neither a scoreboard, a
timer nor health can fake that — and those are exactly what the reader misfires on (`ssg08`: the
scoreboard at the top of the frame was chosen, the real counter rejected).

    python3 python/tools/reserve_probe.py [--frames 8]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ammo.glyphs import find_glyphs, group_glyphs  # noqa: E402
from ammo.glyphs import to_ink  # noqa: E402
from ammo.reader import Prototypes, classify  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


def clip_table() -> list[tuple[str, str, dict]]:
    labels = {json.loads(p.read_text())['slug']: json.loads(p.read_text())['clip']
              for p in sorted((ROOT / 'labels').glob('*.json'))}
    rows = json.loads((ROOT / 'eval/.cache/ammoBrowser.json').read_text())
    out = []
    for r in rows:
        if not r.get('covered') or not r.get('slot'):
            continue
        video = ROOT / 'examples' / labels[r['slug']]
        if video.exists():
            out.append((r['slug'], str(video), r['slot']))
    return out


def main() -> None:
    n_frames = int(sys.argv[sys.argv.index('--frames') + 1]) if '--frames' in sys.argv else 8
    protos = Prototypes.load()
    print(f'{"клип":26s} {"маг h":>6s} {"зап h":>6s} {"кадров с запасом":>17s} '
          f'{"прочитан":>9s} {"худшее d":>9s}')
    total_found = total_read = 0
    for slug, video, slot in clip_table():
        cap = cv2.VideoCapture(video)
        n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        mag_h, res_h, found, read, worst = [], [], 0, 0, []
        for i in range(n_frames):
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(n * (0.2 + 0.6 * i / max(1, n_frames - 1))))
            ok, frame = cap.read()
            if not ok:
                continue
            h, w = frame.shape[:2]
            cx, cy = slot['x'] * w, slot['y'] * h
            groups = group_glyphs(find_glyphs(to_ink(frame)))
            # The magazine is the group at the slot anchor; the reserve is the nearest group to the RIGHT on the same row.
            mag = [g for g in groups if abs(g.cx - cx) < 40 and abs(g.cy - cy) < 20]
            if not mag:
                continue
            m = mag[0]
            mh = m.bottom - m.y
            mag_h.append(mh)
            right = [g for g in groups
                     if g.cx > m.right and g.cx - m.right < 6 * mh and abs(g.cy - m.cy) < 0.6 * mh]
            if not right:
                continue
            r = min(right, key=lambda g: g.cx)
            found += 1
            res_h.append(r.bottom - r.y)
            digits = [classify(protos, gl) for gl in r.glyphs]
            worst.append(max(d for _, d in digits))
            if all(v >= 0 for v, _ in digits):
                read += 1
        cap.release()
        total_found += found
        total_read += read
        print(f'{slug[:26]:26s} {np.median(mag_h) if mag_h else 0:6.0f} '
              f'{np.median(res_h) if res_h else 0:6.0f} {f"{found}/{n_frames}":>17s} '
              f'{f"{read}/{max(1,found)}":>9s} {max(worst) if worst else 0:9.3f}')
    print()
    print(f'группа справа найдена на {total_found} кадрах, прочитана на {total_read} '
          f'({100 * total_read / max(1, total_found):.0f}%)')


if __name__ == '__main__':
    main()
