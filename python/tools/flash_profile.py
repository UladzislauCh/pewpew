"""Flash brightness profile inside a burst: are separate shots visible.

THE QUESTION. Model confidence is BINARY — either ~0.85 or ~0.000, with almost no values in
between. It is a detector, its score saturates, and two shots inside a burst cannot be told apart
by it: over several consecutive frames it is equally high. Hence the ceiling of the whole scheme —
the flash says "the player is firing", but not how many times.

THE ANSWER. Actual pixel brightness does contain such structure, but only AFTER SUBTRACTING THE
SCENE. Box brightness on its own is useless: it clips at 255 on a bright map and drifts with
recoil as the crosshair moves over dark and bright spots. But the box brightness excess OVER THE
REST OF THE FRAME gives a clean periodic series.

Measured on `ak47` (spec 600 rounds per minute, i.e. 100 ms):

    frame   model   excess
    7.367    0.874     94.5
    7.467    0.883     92.3
    7.567    0.902     99.5
    7.667    0.868    110.0
    7.767    0.805    136.1
    7.867    0.883    129.0

The peaks sit exactly 100 ms apart — the weapon period. Model confidence on the same frames is
indistinguishable.

    python3 python/tools/flash_profile.py [--clips ak47,m4a4]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parents[2]
#: Classes that mean an own shot. Matches the product list.
OWN_CLASSES = ('muzzle_flash', 'zoom_flash', 'zoom_tracer')
#: The gap at which shots are split into bursts.
BURST_GAP_S = 0.25


def own_indices(names: list[str]) -> list[int]:
    return [i for i, n in enumerate(names) if n in OWN_CLASSES]


def letterbox(frame: np.ndarray, size: int = 640):
    h, w = frame.shape[:2]
    scale = min(size / w, size / h)
    nw, nh = int(round(w * scale)), int(round(h * scale))
    canvas = np.full((size, size, 3), 114, np.uint8)
    oy, ox = (size - nh) // 2, (size - nw) // 2
    canvas[oy:oy + nh, ox:ox + nw] = cv2.resize(frame, (nw, nh))
    x = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB).astype(np.float32).transpose(2, 0, 1)[None] / 255
    return x, scale, ox, oy


def longest_burst(times: list[float]) -> list[float]:
    groups = [[times[0]]]
    for t in times[1:]:
        if t - groups[-1][-1] <= BURST_GAP_S:
            groups[-1].append(t)
        else:
            groups.append([t])
    return max(groups, key=len)


def main() -> None:
    want = sys.argv[sys.argv.index('--clips') + 1].split(',') if '--clips' in sys.argv else ['ak47', 'm4a4']
    sess = ort.InferenceSession(str(ROOT / 'public/models/flashNet.onnx'),
                                providers=['CPUExecutionProvider'])
    meta = json.loads((ROOT / 'public/models/flashNet.meta.json').read_text(encoding='utf-8'))
    names = [meta['names'][str(i)] for i in range(len(meta['names']))]
    own = own_indices(names)

    for prefix in want:
        path = next((p for p in sorted((ROOT / 'labels').glob('*.json'))
                     if json.loads(p.read_text(encoding='utf-8'))['slug'].startswith(prefix)), None)
        if path is None:
            print(f'{prefix}: клип не найден')
            continue
        payload = json.loads(path.read_text(encoding='utf-8'))
        shots = sorted(s['time'] for s in payload['shots'] if s.get('source') == 'own')
        if not shots:
            continue
        burst = longest_burst(shots)

        cap = cv2.VideoCapture(str(ROOT / 'examples' / payload['clip']))
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        rows, boxes = [], []
        for n in range(int((burst[0] - 0.1) * fps), int((burst[0] + 0.8) * fps) + 1):
            cap.set(cv2.CAP_PROP_POS_FRAMES, n)
            ok, frame = cap.read()
            if not ok:
                break
            x, scale, ox, oy = letterbox(frame)
            out = sess.run(None, {'images': x})[0][0]
            h, w = frame.shape[:2]
            conf, box = 0.0, None
            for i in own:
                a = int(np.argmax(out[4 + i]))
                v = float(out[4 + i][a])
                if v > conf:
                    conf = v
                    box = ((out[0][a] - ox) / scale / w, (out[1][a] - oy) / scale / h,
                           out[2][a] / scale / w, out[3][a] / scale / h)
            if box and conf > 0.4:
                boxes.append(box)
            rows.append((n / fps, conf, frame))
        cap.release()
        if not boxes:
            print(f'{payload["slug"]}: модель не увидела вспышки')
            continue

        # The box is the MEDIAN over frames where the model is confident: it stays put (the weapon
        # model is bottom-centre), while the per-frame one jitters and spoils the series.
        b = np.median(np.asarray(boxes), axis=0)
        profile = []
        for t, conf, frame in rows:
            h, w = frame.shape[:2]
            x0, x1 = int(max(0, (b[0] - b[2] / 2) * w)), int(min(w, (b[0] + b[2] / 2) * w))
            y0, y1 = int(max(0, (b[1] - b[3] / 2) * h)), int(min(h, (b[1] + b[3] / 2) * h))
            gray = frame.max(axis=2).astype(np.float32)
            mask = np.ones_like(gray, dtype=bool)
            mask[y0:y1, x0:x1] = False
            profile.append((t, conf, float(gray[y0:y1, x0:x1].mean() - gray[mask].mean())))

        values = [v for _, _, v in profile]
        lo, hi = min(values), max(values)
        print(f'\n=== {payload["slug"]}  очередь {len(burst)} выстрелов, {fps:.0f} к/с')
        print(f'   {"кадр":>7} {"модель":>7} {"избыток":>8}  профиль')
        for t, conf, v in profile:
            near = min((abs(t - s) for s in burst), default=9)
            bar = '#' * int(38 * (v - lo) / max(1e-6, hi - lo))
            print(f'   {t:7.3f} {conf:7.3f} {v:8.1f}  {bar}'
                  + (' <- выстрел' if near <= 0.5 / fps else ''))


if __name__ == '__main__':
    main()
