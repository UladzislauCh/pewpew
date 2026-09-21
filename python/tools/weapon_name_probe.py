"""Does the WEAPON NAME in the frame change on a weapon switch — and does that match the counter's jumps.

Why. A return from a weapon switch cannot be told from a burst by the counter series alone, and
that has been confirmed three times: the "return to the abandoned level" rule was rejected by
measurement, the reserve ammo is not confirmed without a reload, the physical rate breaks real
bursts. The weapon name is the last untried external cue. It sits on the same row, left of the
magazine, and it does NOT NEED to be read: "the pixels in this spot changed stably" is enough.

    python3 python/tools/weapon_name_probe.py [--clips ssg08,ak47]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
#: Name box: from how many magazine heights to the left to how many, and the vertical half-height.
LEFT_FROM, LEFT_TO, ROW_HALF = 6.0, 0.6, 1.4
#: Box signature grid. Coarse on purpose: a change of word matters, not of a letter.
SIG_X, SIG_Y = 16, 6
#: Share of mismatched cells above which the signature counts as CHANGED.
CHANGE = 0.18


def signature(ink: np.ndarray) -> np.ndarray:
    """Ink share per box cell."""
    h, w = ink.shape
    if h < SIG_Y or w < SIG_X:
        return np.zeros(SIG_Y * SIG_X, dtype=np.float32)
    by, bx = h // SIG_Y, w // SIG_X
    tile = ink[: by * SIG_Y, : bx * SIG_X].reshape(SIG_Y, by, SIG_X, bx)
    return tile.mean(axis=(1, 3)).ravel().astype(np.float32)


def main() -> None:
    labels = {json.loads(p.read_text())['slug']: json.loads(p.read_text())['clip']
              for p in sorted((ROOT / 'labels').glob('*.json'))}
    cache = sys.argv[sys.argv.index('--cache') + 1] if '--cache' in sys.argv else 'eval/.cache/ammoBrowser.json'
    rows = json.loads((ROOT / cache).read_text())
    want = set(sys.argv[sys.argv.index('--clips') + 1].split(',')) if '--clips' in sys.argv else None

    for r in rows:
        if not r.get('covered') or not r.get('slot'):
            continue
        if want and not any(r['slug'].startswith(w) for w in want):
            continue
        cap = cv2.VideoCapture(str(ROOT / 'examples' / labels[r['slug']]))
        sigs, frames = [], []
        idx = 0
        hh = None
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            h, w = frame.shape[:2]
            if hh is None:
                # The magazine height in pixels is not known from outside; take the fraction of
                # the frame at which HUD digits sit in this corpus.
                hh = 0.02 * h
            cx, cy = r['slot']['x'] * w, r['slot']['y'] * h
            x0 = int(max(0, cx - LEFT_FROM * hh))
            x1 = int(max(x0 + 1, cx - LEFT_TO * hh))
            y0 = int(max(0, cy - ROW_HALF * hh))
            y1 = int(min(h, cy + ROW_HALF * hh))
            ink = (frame[y0:y1, x0:x1].max(axis=2) >= 190).astype(np.float32)
            sigs.append(signature(ink))
            frames.append(idx)
            idx += 1
        cap.release()
        if len(sigs) < 3:
            print(f'{r["slug"][:26]:28s} кадров мало')
            continue
        s = np.stack(sigs)
        d = np.abs(np.diff(s, axis=0)).mean(axis=1)
        # A change counts only if the signature HELD as new: a single spike is a muzzle flash
        # or smoke passing through the semi-transparent HUD.
        events = []
        i = 1
        while i < len(d):
            if d[i] > CHANGE:
                after = s[min(len(s) - 1, i + 4)]
                before = s[max(0, i - 4)]
                if np.abs(after - before).mean() > CHANGE:
                    events.append(i)
                    i += 5
                    continue
            i += 1
        print(f'{r["slug"][:26]:28s} кадров {len(sigs):4d} | смен названия {len(events):3d} '
              f'| кадры {events[:12]} | медиана расхождения {np.median(d):.4f}')


if __name__ == '__main__':
    main()
