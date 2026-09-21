"""A hint for the labeller: where the flash STARTED and where it continues.

WHY. Right now the model was taught to answer "there is a flash in this frame", and it honestly
lights up on three to five consecutive frames — the flash really is there on each of them. So one
hit is not one shot, and the product is forced to count shots with heuristics: collapsing close
labels, fitting a fire-rate grid, guessing the period.

If ONLY the frame where the flash appeared is labelled with a box, the model will start answering
a different question — "a shot started here". Then one hit is one shot, and all the heuristics
become unnecessary.

WHAT THIS TOOL DOES. It assigns each cut frame a phase:

    start   the flash appeared — THIS is the frame to label with a box
    hold    the same flash as on the previous frame — do NOT put a box
    none    no flash

TWO SIGNALS, AND THE SECOND MATTERS MORE THAN THE FIRST. The model (`flashNet.onnx`) is useful
where it already sees: rifles, machine guns, scopes. But the frames were cut precisely for shotguns
and pistols, where it is almost blind — there the hint comes from BRIGHTNESS: a shot lights up the
scene, and the flash frame is noticeably brighter than its neighbours. Brightness needs no model
at all.

A hint stays a hint: a person decides. The numbers go into index.json next to the phase, so there
is something to sort by.

    python3 python/tools/mark_flash_phase.py dataset/shotguns
    python3 python/tools/mark_flash_phase.py dataset/shotguns dataset/pistols dataset/awp
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
OWN_CLASSES = ('muzzle_flash', 'zoom_flash', 'zoom_tracer')
#: Model threshold. The same as in the product.
MODEL_THRESHOLD = 0.4
#: How much brighter than its NEIGHBOURS a frame must be to count as a flash, in brightness units
#: 0..255. Chosen by analysis: a real flash gives a jump of tens of units, while scene sway from
#: recoil gives a few.
LUM_JUMP = 6.0
#: How many neighbouring frames are taken as background. Five frames is 165 ms at 30 fps — well
#: above a flash and well below a scene change.
LUM_WINDOW = 5


def load_model():
    path = ROOT / 'public/models/flashNet.onnx'
    meta_path = ROOT / 'public/models/flashNet.meta.json'
    if not path.exists() or not meta_path.exists():
        return None, []
    try:
        import onnxruntime as ort
    except ImportError:
        return None, []
    meta = json.loads(meta_path.read_text(encoding='utf-8'))
    names = [meta['names'][str(i)] for i in range(len(meta['names']))]
    own = [i for i, n in enumerate(names) if n in OWN_CLASSES]
    return ort.InferenceSession(str(path), providers=['CPUExecutionProvider']), own


def model_score(sess, own, image) -> float:
    h, w = image.shape[:2]
    s = min(640 / w, 640 / h)
    nw, nh = int(round(w * s)), int(round(h * s))
    canvas = np.full((640, 640, 3), 114, np.uint8)
    oy, ox = (640 - nh) // 2, (640 - nw) // 2
    canvas[oy:oy + nh, ox:ox + nw] = cv2.resize(image, (nw, nh))
    x = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB).astype(np.float32).transpose(2, 0, 1)[None] / 255
    out = sess.run(None, {'images': x})[0][0]
    return max(float(out[4 + i].max()) for i in own) if own else 0.0


def main() -> None:
    folders = [Path(a) for a in sys.argv[1:]] or [Path('dataset/shotguns')]
    sess, own = load_model()
    if sess is None:
        print('модели нет — подсказка будет только по яркости')

    for folder in folders:
        index_path = ROOT / folder / 'index.json'
        if not index_path.exists():
            print(f'{folder}: нет index.json')
            continue
        rows = json.loads(index_path.read_text(encoding='utf-8'))

        # Brightness and model score for each frame.
        for row in rows:
            image = cv2.imread(str(ROOT / folder / row['file']))
            if image is None:
                row['lum'] = None
                continue
            row['lum'] = float(image.max(axis=2).mean())
            row['flashScore'] = round(model_score(sess, own, image), 3) if sess else None

        # The phase is computed WITHIN a clip by frame numbers: a neighbour must be a real
        # neighbour, not just the next line of the file.
        by_clip = defaultdict(list)
        for row in rows:
            by_clip[row['slug']].append(row)

        counts = defaultdict(int)
        for group in by_clip.values():
            group.sort(key=lambda r: r['frame'])
            lums = [r['lum'] for r in group if r['lum'] is not None]
            for i, row in enumerate(group):
                if row['lum'] is None:
                    row['phase'] = 'none'
                    continue
                lo, hi = max(0, i - LUM_WINDOW), min(len(group), i + LUM_WINDOW + 1)
                near = [g['lum'] for g in group[lo:hi] if g['lum'] is not None and g is not row]
                base = float(np.median(near)) if near else float(np.median(lums))
                row['lumJump'] = round(row['lum'] - base, 1)

                hot_model = (row.get('flashScore') or 0) >= MODEL_THRESHOLD
                hot_lum = row['lumJump'] >= LUM_JUMP
                row['hot'] = bool(hot_model or hot_lum)

            for i, row in enumerate(group):
                if not row.get('hot'):
                    row['phase'] = 'none'
                    continue
                prev = group[i - 1] if i > 0 else None
                adjacent = prev is not None and row['frame'] - prev['frame'] == 1
                row['phase'] = 'hold' if adjacent and prev.get('hot') else 'start'
                counts[row['phase']] += 1
            counts['none'] += sum(1 for r in group if r['phase'] == 'none')

        index_path.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding='utf-8')
        starts = [r for r in rows if r['phase'] == 'start']
        print(f'\n{folder}: кадров {len(rows)}  '
              f'start {counts["start"]}, hold {counts["hold"]}, none {counts["none"]}')
        print('   размечать рамкой надо только start; hold и none оставить пустыми')
        by_slug = defaultdict(lambda: [0, 0])
        for r in rows:
            by_slug[r['slug']][0] += r['phase'] == 'start'
            by_slug[r['slug']][1] += 1
        for slug, (n, total) in sorted(by_slug.items()):
            shots = len({r['shot'] for r in rows if r['slug'] == slug})
            print(f'   {slug[:40]:42s} start {n:3d} из {total:4d} кадров, выстрелов {shots}')
        _ = starts


if __name__ == '__main__':
    main()
