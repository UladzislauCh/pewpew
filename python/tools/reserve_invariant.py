"""Does the "magazine + reserve" PAIR tell the real counter from impostors.

Why. Slot selection currently looks at one series and gets it wrong: on `ssg08` it chose the
scoreboard at the top of the frame (score 0.91), and rejected the real counter — bottom right,
read on 100% of frames — for "large decrements", because the player jumps between a sniper rifle
and a pistol.

An invariant that neither a scoreboard, a timer nor health can fake:

    shot          magazine −1..−3, reserve does NOT CHANGE
    reload        magazine up, reserve down by EXACTLY THE SAME amount
    weapon switch both change, nothing is conserved

Here it is computed for every place in the frame and compared with the choice of the current
selection. The reserve need not be read on every frame: a fraction of frames is enough.

    python3 python/tools/reserve_invariant.py [--clips ssg08,ak47]
"""

from __future__ import annotations

import json
import sys
import time
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ammo.glyphs as glyphs_mod  # noqa: E402
from ammo.glyphs import find_glyphs, group_glyphs, to_ink  # noqa: E402
from ammo.reader import Prototypes, read_group  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
#: How far to the right of the magazine the reserve is searched, in magazine heights.
RIGHT_SPAN = 6.0
#: A place counts as the same if the centre has moved no more than this fraction of the height.
SAME_SLOT = 0.6


def scan(task: tuple[str, str, float]) -> dict:
    """All numbers on all frames: position, height, value."""
    slug, video, min_height = task
    # The reserve is drawn half as large as the magazine, and the current 0.010 threshold cuts it
    # right at the edge. The threshold travels in the task: pool processes on macOS start fresh and re-read the module.
    glyphs_mod.MIN_GLYPH_HEIGHT = min_height
    protos = Prototypes.load()
    cap = cv2.VideoCapture(video)
    frames = []
    idx = 0
    h = w = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        h, w = frame.shape[:2]
        groups = group_glyphs(find_glyphs(to_ink(frame)))
        rows = []
        for g in groups:
            value = read_group(protos, g.glyphs)
            rows.append((float(g.cx), float(g.cy), float(g.bottom - g.y), float(g.right),
                         float(g.x), -1 if value is None else int(value)))
        frames.append(rows)
        idx += 1
    cap.release()
    return {'slug': slug, 'frames': frames, 'w': w, 'h': h}


def cluster(frames: list) -> list[dict]:
    """Stable places: the same coordinates from frame to frame."""
    slots: list[dict] = []
    for fi, rows in enumerate(frames):
        taken = set()
        for cx, cy, hh, right, x, value in rows:
            best, bd = -1, 1e9
            for i, s in enumerate(slots):
                if i in taken:
                    continue
                if abs(cy - s['cy']) > max(SAME_SLOT * s['h'], 6):
                    continue
                if abs(cx - s['cx']) > max(1.5 * s['h'], 12):
                    continue
                d = abs(cx - s['cx']) + abs(cy - s['cy'])
                if d < bd:
                    bd, best = d, i
            if best < 0:
                slots.append({'cx': cx, 'cy': cy, 'h': hh, 'n': 0,
                              'frames': [], 'values': [], 'right': right, 'x': x})
                best = len(slots) - 1
            s = slots[best]
            k = s['n']
            s['cx'] = (s['cx'] * k + cx) / (k + 1)
            s['cy'] = (s['cy'] * k + cy) / (k + 1)
            s['h'] = (s['h'] * k + hh) / (k + 1)
            s['right'] = (s['right'] * k + right) / (k + 1)
            s['n'] = k + 1
            s['frames'].append(fi)
            s['values'].append(value)
            taken.add(best)
    return slots


def neighbour_series(frames: list, slot: dict) -> tuple[list[int], list[int]]:
    """Value of the nearest group to the RIGHT on the same row, over the slot's frames."""
    out_f, out_v = [], []
    want = set(slot['frames'])
    for fi, rows in enumerate(frames):
        if fi not in want:
            continue
        best, bx = None, 1e9
        for cx, cy, hh, right, x, value in rows:
            if x <= slot['right'] or x - slot['right'] > RIGHT_SPAN * slot['h']:
                continue
            if abs(cy - slot['cy']) > SAME_SLOT * slot['h']:
                continue
            if x < bx:
                bx, best = x, value
        if best is not None and best >= 0:
            out_f.append(fi)
            out_v.append(best)
    return out_f, out_v


def invariant(slot: dict, nf: list[int], nv: list[int]) -> dict:
    """Share of magazine transitions explained by the reserve's behaviour."""
    res = dict(zip(nf, nv))
    shots = held = reloads = conserved = switches = 0
    for i in range(1, len(slot['frames'])):
        a, b = slot['values'][i - 1], slot['values'][i]
        fa, fb = slot['frames'][i - 1], slot['frames'][i]
        if a < 0 or b < 0 or a == b:
            continue
        ra, rb = res.get(fa), res.get(fb)
        if ra is None or rb is None:
            continue
        if -3 <= b - a < 0:
            shots += 1
            if ra == rb:
                held += 1
        elif b > a:
            reloads += 1
            if ra - rb == b - a:
                conserved += 1
            else:
                switches += 1
    return {'shots': shots, 'held': held, 'reloads': reloads, 'conserved': conserved,
            'switches': switches, 'cover': len(nv)}


def analyze(task: tuple[str, str, float]) -> dict:
    data = scan(task)
    frames = data['frames']
    slots = cluster(frames)
    n = len(frames)
    out = []
    for s in slots:
        # A place that flickered in a couple of frames is scenery or a caption, not a HUD reading.
        if s['n'] < max(8, 0.1 * n):
            continue
        nf, nv = neighbour_series(frames, s)
        inv = invariant(s, nf, nv)
        vals = [v for v in s['values'] if v >= 0]
        out.append({
            'x': s['cx'] / max(1, data['w']), 'y': s['cy'] / max(1, data['h']),
            'h': s['h'], 'reads': len(vals), 'presence': s['n'] / max(1, n),
            'range': [min(vals), max(vals)] if vals else None,
            **inv,
        })
    return {'slug': data['slug'], 'frames': n, 'slots': out}


def main() -> None:
    labels = {json.loads(p.read_text())['slug']: json.loads(p.read_text())['clip']
              for p in sorted((ROOT / 'labels').glob('*.json'))}
    rows = json.loads((ROOT / 'eval/.cache/ammoBrowser.json').read_text())
    min_height = (float(sys.argv[sys.argv.index('--min-height') + 1])
                  if '--min-height' in sys.argv else glyphs_mod.MIN_GLYPH_HEIGHT)
    want = None
    if '--clips' in sys.argv:
        want = set(sys.argv[sys.argv.index('--clips') + 1].split(','))
    tasks = []
    for r in rows:
        if not r.get('covered'):
            continue
        if want and not any(r['slug'].startswith(w) for w in want):
            continue
        video = ROOT / 'examples' / labels[r['slug']]
        if video.exists():
            tasks.append((r['slug'], str(video), min_height))

    started = time.time()
    results = []
    with ProcessPoolExecutor() as pool:
        for res in pool.map(analyze, tasks):
            results.append(res)
            print(f'  {res["slug"][:40]:42s} кадров {res["frames"]:4d} мест {len(res["slots"]):3d}', flush=True)
    out = ROOT / 'python/out/reserveInvariant.json'
    out.write_text(json.dumps(results))
    print(f'записано {out} за {time.time() - started:.0f} с')


if __name__ == '__main__':
    main()
