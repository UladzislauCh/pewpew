"""Viewmodel recoil oracle: is the shot visible in the DEFORMATION of the weapon region.

The question is narrow and the answer binary. There are 454 shots whose frame is known EXACTLY —
given by the ammo counter, not by hand. Inside the weapon box labelled by a person
(`eval/weaponRegions.json`) a per-sub-block shift field is computed, and from it quantities the
product does not have:

  tx, ty        shift of the whole region: exactly what the product computes now
  div           field divergence — the weapon moves INTO THE PLAYER (scale)
  curl          field curl — barrel rotation along an arc
  resid_shift   residual after the best OVERALL shift: the product computes it and THROWS IT AWAY
  resid_affine  field residual after removing the affine model — what even that does not explain
  diff_raw      frame difference without compensation, as a control

One thing is measured: AUC "shot frame against quiet frame". This is a question of an event
GENERATOR (is the shot visible on its own), not of a filter over audio candidates — the residual
was already measured as a filter, and it drowned in the noise pool.

Scoped weapons are excluded: there is no viewmodel in the scope at all.

    npx tsx eval/frameTimes.ts        # once, if the file is missing
    python3 python/tools/recoil_probe.py
"""

from __future__ import annotations

import json
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]

# There is no viewmodel in the scope — that is a separate class, analysed separately.
SCOPED = {'g3sg1-c6efc1c9', 'scar20-beca1553', 'ssg08-f176c0bd'}

CROP_W, CROP_H = 192, 96
GRID_X, GRID_Y = 6, 3
MAX_SHIFT = 6
#: Frames around a shot that do not count as quiet.
QUIET_GUARD = 10
#: A shot is "isolated" if the nearest neighbour is further than this many frames.
ISOLATED_GAP = 5

FIELDS = ('tx', 'ty', 'shift_mag', 'div', 'curl', 'field_spread',
          'resid_shift', 'resid_affine', 'diff_raw', 'bright_delta', 'diff_flat')


def clip_table() -> list[dict]:
    """Clips with a counter: weapon box, shot frames, path to the video."""
    ammo = json.loads((ROOT / 'eval/.cache/ammoBrowser.json').read_text(encoding='utf-8'))
    regions = json.loads((ROOT / 'eval/weaponRegions.json').read_text(encoding='utf-8'))['regions']
    times = json.loads((ROOT / 'python/out/frameTimes.json').read_text(encoding='utf-8'))
    labels = {}
    for label in sorted((ROOT / 'labels').glob('*.json')):
        payload = json.loads(label.read_text(encoding='utf-8'))
        labels[payload['slug']] = payload['clip']

    out = []
    for entry in ammo:
        slug = entry['slug']
        if not entry.get('covered') or slug in SCOPED:
            continue
        if slug not in regions or slug not in times or slug not in labels:
            continue
        video = ROOT / 'examples' / labels[slug]
        if not video.exists():
            continue
        stamps = np.asarray(times[slug]['times'], dtype=np.float64)
        audio_start = float(times[slug].get('audioStart', 0.0))
        frames = []
        for t in entry['shotsVideo']:
            # `shotsVideo` lives on the video clock shifted by video minus audio; the frame stamps
            # in frameTimes are absolute, so the shift is added back.
            frames.append(int(np.argmin(np.abs(stamps - (float(t) + audio_start)))))
        out.append({'slug': slug, 'video': str(video), 'region': regions[slug],
                    'shots': sorted(set(frames)), 'frames': len(stamps)})
    return out


def _shift_costs(prev: np.ndarray, cur: np.ndarray) -> np.ndarray:
    """SAD for each sub-block for each integer shift.

    Returns (shifts, sub-blocks). The shift is applied to the CURRENT frame: we look for where the
    content came from.
    """
    s = MAX_SHIFT
    h, w = prev.shape
    base = prev[s:h - s, s:w - s]
    vh, vw = base.shape
    by, bx = vh // GRID_Y, vw // GRID_X
    costs = np.empty(((2 * s + 1) ** 2, GRID_Y * GRID_X), dtype=np.float32)
    k = 0
    for dy in range(-s, s + 1):
        for dx in range(-s, s + 1):
            moved = cur[s + dy:h - s + dy, s + dx:w - s + dx]
            diff = np.abs(base - moved)
            # Per-sub-block sums: crop to a multiple and reduce along the axes.
            tile = diff[:by * GRID_Y, :bx * GRID_X]
            costs[k] = tile.reshape(GRID_Y, by, GRID_X, bx).mean(axis=(1, 3)).ravel()
            k += 1
    return costs


def _shift_grid() -> tuple[np.ndarray, np.ndarray]:
    s = MAX_SHIFT
    ys, xs = np.mgrid[-s:s + 1, -s:s + 1]
    return xs.ravel().astype(np.float64), ys.ravel().astype(np.float64)


def _design() -> np.ndarray:
    """Design matrix for the affine field fit: one, cx, cy over sub-block centres."""
    cy, cx = np.mgrid[0:GRID_Y, 0:GRID_X]
    cx = (cx.ravel() + 0.5) / GRID_X * 2 - 1
    cy = (cy.ravel() + 0.5) / GRID_Y * 2 - 1
    return np.stack([np.ones_like(cx), cx, cy], axis=1)


def analyze(task: dict) -> dict:
    cap = cv2.VideoCapture(task['video'])
    r = task['region']
    shift_x, shift_y = _shift_grid()
    design = _design()
    pinv = np.linalg.pinv(design)

    series = {name: [] for name in FIELDS}
    prev = None
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        h, w = frame.shape[:2]
        x0, x1 = int(r['x0'] * w), int(r['x1'] * w)
        y0, y1 = int(r['y0'] * h), int(r['y1'] * h)
        crop = frame[max(0, y0):min(h, y1), max(0, x0):min(w, x1)]
        if crop.size == 0:
            break
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        cur = cv2.resize(gray, (CROP_W, CROP_H), interpolation=cv2.INTER_AREA).astype(np.float32)

        if prev is None:
            prev = cur
            for name in FIELDS:
                series[name].append(0.0)
            continue

        costs = _shift_costs(prev, cur)
        # Overall region shift — what the product computes, and the residual at it.
        total = costs.mean(axis=1)
        g = int(np.argmin(total))
        # Per-block shift: the same computation, only the minimum is taken for each block.
        per = np.argmin(costs, axis=0)
        u, v = shift_x[per], shift_y[per]

        coef_u, coef_v = pinv @ u, pinv @ v
        fit_u, fit_v = design @ coef_u, design @ coef_v

        series['tx'].append(float(shift_x[g]))
        series['ty'].append(float(shift_y[g]))
        series['shift_mag'].append(float(np.hypot(shift_x[g], shift_y[g])))
        series['div'].append(float(coef_u[1] + coef_v[2]))
        series['curl'].append(float(coef_v[1] - coef_u[2]))
        series['field_spread'].append(float(np.hypot(u - u.mean(), v - v.mean()).mean()))
        series['resid_shift'].append(float(total[g]))
        series['resid_affine'].append(float(np.hypot(u - fit_u, v - fit_v).mean()))
        series['diff_raw'].append(float(np.abs(prev - cur).mean()))
        # Flash or motion: subtracting the mean level from each frame removes the overall
        # brightness rise and leaves only the rearrangement of the picture.
        series['bright_delta'].append(float(cur.mean() - prev.mean()))
        series['diff_flat'].append(
            float(np.abs((prev - prev.mean()) - (cur - cur.mean())).mean()))
        prev = cur

    cap.release()
    return {'slug': task['slug'], 'shots': task['shots'],
            'series': {k: [round(x, 4) for x in v] for k, v in series.items()}}


def main() -> None:
    tasks = clip_table()
    print(f'клипов {len(tasks)}, выстрелов {sum(len(t["shots"]) for t in tasks)}', flush=True)
    started = time.time()
    results = []
    with ProcessPoolExecutor() as pool:
        for res in pool.map(analyze, tasks):
            results.append(res)
            print(f'  {res["slug"]:46s} кадров {len(res["series"]["div"])}', flush=True)
    out = ROOT / 'python/out/recoilProbe.json'
    out.write_text(json.dumps(results), encoding='utf-8')
    print(f'записано {out} за {time.time() - started:.0f} с')


if __name__ == '__main__':
    main()
