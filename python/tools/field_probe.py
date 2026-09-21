"""Motion field in the weapon region: the full per-frame series, no summaries.

Differences from `recoil_probe.py`, which was exploration and has closed its question:

  RESOLUTION. There the box was squeezed to 192x96 and the shift was searched in integers — scale
  and rotation drowned in such an estimate. Here it is 320x160, an 8x4 grid and sub-pixel
  refinement by a parabola over the SAD surface.

  RELATIVE TO THE SCENE. The viewmodel is defined by NOT MOVING WITH THE CAMERA. So the overall
  frame shift is computed too, and the field is stored in two forms — raw and with the scene
  subtracted. Recoil is weapon motion RELATIVE to what happens to the view.

  NO SUMMARIES. The whole field is written frame by frame: (frames, blocks, 4) — u, v, block
  residual, block difference. All features are computed later, without re-decoding, because they
  will have to be swept many times.

    python3 python/tools/field_probe.py [--all]

`--all` takes all clips with a human box; without it, only those with an ammo counter, i.e.
per-frame truth.

`--auto` takes the box not from a person but FROM THE PRODUCT: the bounding rectangle of the twelve
blocks selected by the classifier (`eval/.cache/blockWeights.json`, maps obtained with per-clip
folds). This is a transfer check: the measurement on the human box says whether there is a signal,
and the measurement on this one says whether it will reach the product. Fields are written to
`field-auto/`.
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
OUT = ROOT / 'python/out/field'
TOP_BLOCKS = 12

SCOPED = {'g3sg1-c6efc1c9', 'scar20-beca1553', 'ssg08-f176c0bd'}
CROP_W, CROP_H = 320, 160
GRID_X, GRID_Y = 8, 4
MAX_SHIFT = 8
#: Take the frame the way the product sees it: via downscaling to 256x256.
VIA_BLOCKS = False


def _apply_params() -> str:
    """Field parameters from arguments: `--size 160x80 --shift 5 --grid 8x4`.

    Needed to choose the CHEAPEST set that keeps the gain: search cost is shifts times pixels, and in
    the browser it is paid on every frame inside an already busy pass over the video.
    """
    global CROP_W, CROP_H, GRID_X, GRID_Y, MAX_SHIFT, VIA_BLOCKS
    tag = []
    if '--via-blocks' in sys.argv:
        VIA_BLOCKS = True
        tag.append('blocks')
    if '--size' in sys.argv:
        CROP_W, CROP_H = (int(v) for v in sys.argv[sys.argv.index('--size') + 1].split('x'))
        tag.append(f'{CROP_W}x{CROP_H}')
    if '--grid' in sys.argv:
        GRID_X, GRID_Y = (int(v) for v in sys.argv[sys.argv.index('--grid') + 1].split('x'))
        tag.append(f'g{GRID_X}x{GRID_Y}')
    if '--shift' in sys.argv:
        MAX_SHIFT = int(sys.argv[sys.argv.index('--shift') + 1])
        tag.append(f's{MAX_SHIFT}')
    return ('-' + '-'.join(tag)) if tag else ''
#: Whole frame for estimating scene motion — coarse and cheap, only the overall drift is needed.
SCENE_W, SCENE_H = 160, 90
SCENE_SHIFT = 6


def _subpixel(cost: np.ndarray, i: int) -> float:
    """Refine the minimum with a parabola through three points. Returns zero at the edges."""
    if i <= 0 or i >= len(cost) - 1:
        return 0.0
    a, b, c = cost[i - 1], cost[i], cost[i + 1]
    denom = a - 2 * b + c
    if denom <= 0:
        return 0.0
    return float(np.clip(0.5 * (a - c) / denom, -0.5, 0.5))


def _block_field(prev: np.ndarray, cur: np.ndarray) -> np.ndarray:
    """Field (blocks, 4): u, v, block residual, block difference without compensation."""
    s = MAX_SHIFT
    h, w = prev.shape
    base = prev[s:h - s, s:w - s]
    vh, vw = base.shape
    by, bx = vh // GRID_Y, vw // GRID_X
    span = 2 * s + 1
    costs = np.empty((span, span, GRID_Y * GRID_X), dtype=np.float32)
    for iy, dy in enumerate(range(-s, s + 1)):
        for ix, dx in enumerate(range(-s, s + 1)):
            diff = np.abs(base - cur[s + dy:h - s + dy, s + dx:w - s + dx])
            tile = diff[:by * GRID_Y, :bx * GRID_X]
            costs[iy, ix] = tile.reshape(GRID_Y, by, GRID_X, bx).mean(axis=(1, 3)).ravel()

    n = GRID_Y * GRID_X
    flat = costs.reshape(span * span, n)
    best = np.argmin(flat, axis=0)
    iy, ix = np.divmod(best, span)
    out = np.empty((n, 4), dtype=np.float32)
    for k in range(n):
        out[k, 0] = (ix[k] - s) + _subpixel(costs[iy[k], :, k], ix[k])
        out[k, 1] = (iy[k] - s) + _subpixel(costs[:, ix[k], k], iy[k])
        out[k, 2] = flat[best[k], k]
    zero = costs[s, s]
    out[:, 3] = zero
    return out


def _scene_shift(prev: np.ndarray, cur: np.ndarray) -> tuple[float, float]:
    s = SCENE_SHIFT
    h, w = prev.shape
    base = prev[s:h - s, s:w - s]
    best, bdx, bdy = np.inf, 0.0, 0.0
    for dy in range(-s, s + 1):
        for dx in range(-s, s + 1):
            c = float(np.abs(base - cur[s + dy:h - s + dy, s + dx:w - s + dx]).mean())
            if c < best:
                best, bdx, bdy = c, float(dx), float(dy)
    # The scene is measured on a downscaled frame — return to the weapon box scale.
    return bdx, bdy


def analyze(task: dict) -> dict:
    global CROP_W, CROP_H, GRID_X, GRID_Y, MAX_SHIFT
    global VIA_BLOCKS
    CROP_W, CROP_H, GRID_X, GRID_Y, MAX_SHIFT, VIA_BLOCKS = task['params']
    cap = cv2.VideoCapture(task['video'])
    r = task['region']
    field, scene = [], []
    prev_crop = prev_scene = None
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        h, w = frame.shape[:2]
        x0, x1 = max(0, int(r['x0'] * w)), min(w, int(r['x1'] * w))
        y0, y1 = max(0, int(r['y0'] * h)), min(h, int(r['y1'] * h))
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        if VIA_BLOCKS:
            # This is how the product sees the frame: the video pass stores it downscaled to 256x256
            # by NEAREST NEIGHBOUR and without preserving aspect ratio (the motion model was trained so).
            # By the time the weapon region is known, the native frame is gone.
            small = cv2.resize(gray, (256, 256), interpolation=cv2.INTER_NEAREST)
            sx0, sx1 = int(r['x0'] * 256), max(int(r['x0'] * 256) + 1, int(r['x1'] * 256))
            sy0, sy1 = int(r['y0'] * 256), max(int(r['y0'] * 256) + 1, int(r['y1'] * 256))
            crop = small[sy0:sy1, sx0:sx1]
        else:
            crop = cv2.cvtColor(frame[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
        cur_crop = cv2.resize(crop, (CROP_W, CROP_H),
                              interpolation=cv2.INTER_AREA).astype(np.float32)
        cur_scene = cv2.resize(gray, (SCENE_W, SCENE_H), interpolation=cv2.INTER_AREA).astype(np.float32)
        if prev_crop is None:
            field.append(np.zeros((GRID_X * GRID_Y, 4), dtype=np.float32))
            scene.append((0.0, 0.0))
        else:
            field.append(_block_field(prev_crop, cur_crop))
            scene.append(_scene_shift(prev_scene, cur_scene))
        prev_crop, prev_scene = cur_crop, cur_scene
    cap.release()

    out_dir = Path(task['out'])
    out_dir.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out_dir / f'{task["slug"]}.npz',
                        field=np.stack(field), scene=np.asarray(scene, dtype=np.float32),
                        shots=np.asarray(task['shots'], dtype=np.int32))
    return {'slug': task['slug'], 'frames': len(field)}


def auto_regions() -> dict:
    """Product boxes: the bounding rectangle of the classifier's top-12 blocks."""
    data = json.loads((ROOT / 'eval/.cache/blockWeights.json').read_text())
    grid = data['grid']
    out = {}
    for slug, probs in data['clips'].items():
        idx = np.argsort(-np.asarray(probs))[:TOP_BLOCKS]
        bx, by = idx % grid, idx // grid
        out[slug] = {'x0': float(bx.min()) / grid, 'x1': float(bx.max() + 1) / grid,
                     'y0': float(by.min()) / grid, 'y1': float(by.max() + 1) / grid}
    return out


def clip_table(everything: bool, auto: bool) -> list[dict]:
    ammo = {c['slug']: c for c in json.loads((ROOT / 'eval/.cache/ammoBrowser.json').read_text())}
    regions = (auto_regions() if '--auto' in sys.argv
               else json.loads((ROOT / 'eval/weaponRegions.json').read_text())['regions'])
    times = json.loads((ROOT / 'python/out/frameTimes.json').read_text())
    labels = {json.loads(p.read_text())['slug']: json.loads(p.read_text())['clip']
              for p in sorted((ROOT / 'labels').glob('*.json'))}
    out = []
    for slug, region in regions.items():
        if slug in SCOPED or slug not in times or slug not in labels:
            continue
        entry = ammo.get(slug)
        covered = bool(entry and entry.get('covered'))
        if not covered and not everything:
            continue
        video = ROOT / 'examples' / labels[slug]
        if not video.exists():
            continue
        stamps = np.asarray(times[slug]['times'])
        audio_start = float(times[slug].get('audioStart', 0.0))
        shots = sorted({int(np.argmin(np.abs(stamps - (float(t) + audio_start))))
                        for t in (entry['shotsVideo'] if covered else [])})
        out.append({'slug': slug, 'video': str(video), 'region': region, 'shots': shots,
                    'out': str(ROOT / ('python/out/field-auto' if auto else 'python/out/field'))})
    return out


def main() -> None:
    suffix = _apply_params()
    auto = '--auto' in sys.argv
    tasks = clip_table('--all' in sys.argv, auto)
    for t in tasks:
        t['out'] += suffix
        t['params'] = (CROP_W, CROP_H, GRID_X, GRID_Y, MAX_SHIFT, VIA_BLOCKS)
    print(f'клипов {len(tasks)}', flush=True)
    started = time.time()
    with ProcessPoolExecutor() as pool:
        for res in pool.map(analyze, tasks):
            print(f'  {res["slug"][:46]:46s} кадров {res["frames"]}', flush=True)
    print(f'поля записаны в {tasks[0]["out"]} за {time.time() - started:.0f} с')


if __name__ == '__main__':
    main()
