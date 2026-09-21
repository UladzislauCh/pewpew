"""Per-frame features of the WHOLE clip — input of the temporal model.

The difference from everything done before is in the framing. Earlier measurements took a window
around an AUDIO CANDIDATE and decided "is this an own shot or not". That approach hits a recall
ceiling of 85.5%: in a dense burst several shots get one candidate, and a per-candidate filter
cannot separate them in principle. Here the clip is described as a continuous series, and a model
over time is free to place an event where there was no candidate.

What is computed on each video frame:

    WEAPON REGION (box from the block classifier, the same one available to the product)
      diff       frame difference without shift compensation
      resid      residual after the best OVERALL shift of the region
      spread     spread of the field across sub-blocks: parts of the region move apart
      resid_aff  field residual after removing the affine model
      u, v       the region shift itself

    CAMERA MOTION (whole frame, one overall shift)
      cam_dx, cam_dy, cam_mag

Splitting the camera into 3x3 zones was tested and rejected: 28 channels instead of 10 overfit on
42 clips, F1 62.9 -> 60.5. Details at ZONE_GRID.

Affine components (divergence, curl) are NOT computed: tested twice, at two resolutions, with
and without sub-pixel — AUC 0.556 and 0.511, i.e. a coin toss.

    python3 python/tools/video_features.py [--clips ak47,m4a4]
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
OUT = ROOT / 'python/out/videofeat'

#: Weapon region sample. The coarsening was tested by measurement and is BENEFICIAL: on a fine grid
#: the per-block estimate is noisy, and the noise eats the signal (median 0.885 against 0.871 at 320x160).
CROP_W, CROP_H = 160, 80
GRID_X, GRID_Y = 6, 3
MAX_SHIFT = 5
#: Whole frame for camera motion. Size and search limit were chosen by measurement: 160x90
#: with limit 6 gave F1 62.9, and a 192x192 square with limit 5 gave 62.1.
CAM_W, CAM_H = 160, 90
CAM_SHIFT = 6
#: Camera zone grid. One — i.e. ONE overall shift, no splitting.
#:
#: A 3x3 grid was TESTED AND REJECTED by measurement. The idea was sound: in the journal per-zone
#: camera motion is the strongest single video feature (AUC 0.887), and a shot gives a different
#: shift in different parts of the frame rather than an overall drift. But the channels become 28
#: instead of 10, and on 42 clips that overfits: F1 62.9 -> 60.5, and on clips without a counter
#: 56.6 -> 53.4.
#:
#: The journal already has the same outcome three times: a non-linear model is worse than a linear
#: one monotonically in capacity, flash features over all zones dilute, rich field feature sets lose
#: to poor ones. The limit is the DATA, not the model class.
ZONE_GRID = 1

FEATURES = ('diff', 'resid', 'spread', 'resid_aff', 'u', 'v', 'cam_dx', 'cam_dy', 'cam_mag')
BLOCKS = GRID_X * GRID_Y


def _design() -> np.ndarray:
    cy, cx = np.mgrid[0:GRID_Y, 0:GRID_X]
    cx = (cx.ravel() + 0.5) / GRID_X * 2 - 1
    cy = (cy.ravel() + 0.5) / GRID_Y * 2 - 1
    return np.stack([np.ones_like(cx), cx, cy], axis=1)


_DESIGN = _design()
_PINV = np.linalg.pinv(_DESIGN)


def _block_field(prev: np.ndarray, cur: np.ndarray) -> tuple[np.ndarray, np.ndarray, float, float]:
    """Per-sub-block shift field, residual at the best overall shift and difference without shift."""
    s = MAX_SHIFT
    h, w = prev.shape
    base = prev[s:h - s, s:w - s]
    vh, vw = base.shape
    by, bx = vh // GRID_Y, vw // GRID_X
    span = 2 * s + 1
    costs = np.empty((span * span, BLOCKS), dtype=np.float32)
    k = 0
    for dy in range(-s, s + 1):
        for dx in range(-s, s + 1):
            diff = np.abs(base - cur[s + dy:h - s + dy, s + dx:w - s + dx])
            tile = diff[:by * GRID_Y, :bx * GRID_X]
            costs[k] = tile.reshape(GRID_Y, by, GRID_X, bx).mean(axis=(1, 3)).ravel()
            k += 1
    per_block = np.argmin(costs, axis=0)
    ys, xs = np.divmod(per_block, span)
    total = costs.mean(axis=1)
    best = int(np.argmin(total))
    zero = s * span + s
    return (xs - s).astype(np.float64), (ys - s).astype(np.float64), float(total[best]), float(costs[zero].mean())


def _zone_shifts(prev: np.ndarray, cur: np.ndarray) -> tuple[float, float, list[float]]:
    """Shift of the whole frame and shift of each zone of a 3x3 grid.

    Computed in one sweep over offsets: per-zone costs sum into the overall one, so nine zones cost
    almost as much as one.
    """
    s = CAM_SHIFT
    h, w = prev.shape
    base = prev[s:h - s, s:w - s]
    vh, vw = base.shape
    by, bx = vh // ZONE_GRID, vw // ZONE_GRID
    span = 2 * s + 1
    zones = ZONE_GRID * ZONE_GRID
    costs = np.empty((span * span, zones), dtype=np.float32)
    k = 0
    for dy in range(-s, s + 1):
        for dx in range(-s, s + 1):
            diff = np.abs(base - cur[s + dy:h - s + dy, s + dx:w - s + dx])
            tile = diff[:by * ZONE_GRID, :bx * ZONE_GRID]
            costs[k] = tile.reshape(ZONE_GRID, by, ZONE_GRID, bx).mean(axis=(1, 3)).ravel()
            k += 1
    best = int(np.argmin(costs.mean(axis=1)))
    if ZONE_GRID == 1:
        return float(best % span - s), float(best // span - s), []
    per_zone = np.argmin(costs, axis=0)
    zy, zx = np.divmod(per_zone, span)
    out: list[float] = []
    for i in range(zones):
        out.extend((float(zx[i] - s), float(zy[i] - s)))
    return float(best % span - s), float(best // span - s), out


def analyze(task: dict) -> dict:
    cap = cv2.VideoCapture(task['video'])
    r = task['box']
    rows: list[list[float]] = []
    prev_crop = prev_cam = None
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        h, w = frame.shape[:2]
        x0, x1 = max(0, int(r['x0'] * w)), min(w, int(r['x1'] * w))
        y0, y1 = max(0, int(r['y0'] * h)), min(h, int(r['y1'] * h))
        crop = frame[y0:y1, x0:x1]
        if crop.size == 0:
            break
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        cur_crop = cv2.resize(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), (CROP_W, CROP_H),
                              interpolation=cv2.INTER_AREA).astype(np.float32)
        cur_cam = cv2.resize(gray, (CAM_W, CAM_H), interpolation=cv2.INTER_AREA).astype(np.float32)

        if prev_crop is None:
            rows.append([0.0] * len(FEATURES))
        else:
            u, v, resid, diff = _block_field(prev_crop, cur_crop)
            mu, mv = float(u.mean()), float(v.mean())
            spread = float(np.hypot(u - mu, v - mv).mean())
            cu, cv_ = _PINV @ u, _PINV @ v
            resid_aff = float(np.hypot(u - _DESIGN @ cu, v - _DESIGN @ cv_).mean())
            cdx, cdy, zones = _zone_shifts(prev_cam, cur_cam)
            rows.append([diff, resid, spread, resid_aff, mu, mv,
                         cdx, cdy, float(np.hypot(cdx, cdy))] + zones)
        prev_crop, prev_cam = cur_crop, cur_cam
    cap.release()

    OUT.mkdir(parents=True, exist_ok=True)
    arr = np.asarray(rows, dtype=np.float32)
    np.save(OUT / f'{task["slug"]}.npy', arr)
    return {'slug': task['slug'], 'frames': len(rows)}


def boxes() -> dict:
    """Weapon boxes from the block classifier — what the product has available."""
    data = json.loads((ROOT / 'eval/.cache/blockWeights.json').read_text(encoding='utf-8'))
    grid = data['grid']
    out = {}
    for slug, probs in data['clips'].items():
        idx = np.argsort(-np.asarray(probs))[:12]
        bx, by = idx % grid, idx // grid
        out[slug] = {'x0': float(bx.min()) / grid, 'x1': float(bx.max() + 1) / grid,
                     'y0': float(by.min()) / grid, 'y1': float(by.max() + 1) / grid}
    return out


def main() -> None:
    want = set(sys.argv[sys.argv.index('--clips') + 1].split(',')) if '--clips' in sys.argv else None
    box = boxes()
    labels = {json.loads(p.read_text())['slug']: json.loads(p.read_text())['clip']
              for p in sorted((ROOT / 'labels').glob('*.json'))}
    tasks = []
    for slug, clip in labels.items():
        if slug not in box:
            continue
        if want and not any(slug.startswith(x) for x in want):
            continue
        video = ROOT / 'examples' / clip
        if video.exists():
            tasks.append({'slug': slug, 'video': str(video), 'box': box[slug]})

    print(f'клипов {len(tasks)}, признаков на кадр {len(FEATURES)}', flush=True)
    started = time.time()
    with ProcessPoolExecutor() as pool:
        for res in pool.map(analyze, tasks):
            print(f'  {res["slug"][:44]:46s} кадров {res["frames"]}', flush=True)
    (OUT / 'features.json').write_text(json.dumps({'features': list(FEATURES)}), encoding='utf-8')
    print(f'записано в {OUT} за {time.time() - started:.0f} с')


if __name__ == '__main__':
    main()
