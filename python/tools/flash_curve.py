"""Running YOLO over the WHOLE clip: the flash confidence curve on every frame.

WHY THE WHOLE CLIP. Checking the model on the frames of labelled shots is pointless: that measures
only recall, and a detector that fires on every frame would get 100%. The question is false
positives — on others' shots, tracers, explosions — and that is visible only on a full pass.

Python outputs MOMENTS, the metric is computed by TypeScript (`eval/flashScore.ts`) with the real
`scoreDetections`. There is no scorer of our own here: two implementations of one metric are two
truths.

    python3 python/tools/flash_curve.py                 # the whole corpus
    python3 python/tools/flash_curve.py --clips ak47,m4a4
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
OUT = ROOT / 'python/out/flash'
SIZE = 640
#: Below this a peak is not considered at all. The threshold itself is chosen later, in TypeScript.
FLOOR = 0.15
#: Minimum gap between moments. 50 ms — no weapon in the game fires faster
#: (the fastest-firing is 666 rounds per minute, i.e. 90 ms).
MIN_GAP_S = 0.05


def analyze(task: dict) -> dict:
    import onnxruntime as ort
    sess = ort.InferenceSession(str(ROOT / 'public/models/flashNet.onnx'),
                                providers=['CPUExecutionProvider'])
    cap = cv2.VideoCapture(task['video'])
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    flash: list[float] = []
    tracer: list[float] = []
    canvas = np.full((SIZE, SIZE, 3), 114, np.uint8)
    started = time.time()
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        h, w = frame.shape[:2]
        s = min(SIZE / w, SIZE / h)
        nw, nh = int(round(w * s)), int(round(h * s))
        canvas[:] = 114
        oy, ox = (SIZE - nh) // 2, (SIZE - nw) // 2
        canvas[oy:oy + nh, ox:ox + nw] = cv2.resize(frame, (nw, nh))
        x = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB).astype(np.float32).transpose(2, 0, 1)[None] / 255
        out = sess.run(None, {'images': x})[0][0]
        flash.append(float(out[4].max()))
        tracer.append(float(out[5].max()))
    cap.release()
    np.savez_compressed(OUT / f'{task["slug"]}.npz',
                        flash=np.asarray(flash, np.float32),
                        tracer=np.asarray(tracer, np.float32), fps=fps)
    return {'slug': task['slug'], 'frames': len(flash), 'fps': fps,
            'seconds': time.time() - started}


def start_offset(slug: str) -> float:
    """Time of the track's FIRST frame relative to audio.

    Without this correction the moment drifts by exactly one frame, and the correction is not a
    detail: at 30 fps that is 33 ms against a 50 ms metric tolerance. OpenCV does not report the
    start offset, so it is taken from `eval/videoStart.ts` — the same way as in the ammo counter.

    Measured on this very bug: without the shift F1 63.3, with it 73.6. Ten points looked like
    "labels are systematically late", but were a track offset.
    """
    path = ROOT / 'python/out/videoStart.json'
    if not path.exists():
        print('ВНИМАНИЕ: нет python/out/videoStart.json. Сначала: npx tsx eval/videoStart.ts')
        return 0.0
    entry = json.loads(path.read_text(encoding='utf-8')).get(slug, {})
    return float(entry.get('videoStart', 0.0)) - float(entry.get('audioStart', 0.0))


def peaks(curve: np.ndarray, fps: float, threshold: float, offset: float = 0.0) -> list[float]:
    """Local maxima above the threshold, no closer than MIN_GAP_S to each other.

    The moment is taken exactly at the frame where the flash is visible, plus the track start offset.
    """
    gap = max(1, int(round(MIN_GAP_S * fps)))
    out: list[float] = []
    last = -1e9
    order = np.argsort(-curve)
    taken: list[int] = []
    for i in order:
        if curve[i] < threshold:
            break
        if any(abs(i - j) < gap for j in taken):
            continue
        taken.append(int(i))
    for i in sorted(taken):
        out.append(i / fps + offset)
    return out


def main() -> None:
    want = set(sys.argv[sys.argv.index('--clips') + 1].split(',')) if '--clips' in sys.argv else None
    OUT.mkdir(parents=True, exist_ok=True)
    tasks = []
    for label in sorted((ROOT / 'labels').glob('*.json')):
        payload = json.loads(label.read_text(encoding='utf-8'))
        if not payload.get('complete'):
            continue
        if want and not any(payload['slug'].startswith(x) for x in want):
            continue
        video = ROOT / 'examples' / payload['clip']
        if video.exists():
            tasks.append({'slug': payload['slug'], 'video': str(video)})

    print(f'клипов {len(tasks)}', flush=True)
    started = time.time()
    done = []
    with ProcessPoolExecutor(max_workers=4) as pool:
        for r in pool.map(analyze, tasks):
            done.append(r)
            print(f"  {r['slug'][:42]:44s} кадров {r['frames']:5d}  {r['seconds']:5.0f} с", flush=True)

    # Moments at several thresholds: TypeScript will choose the threshold, on an honest curve.
    dump = {}
    for r in done:
        d = np.load(OUT / f"{r['slug']}.npz")
        curve, fps = d['flash'], float(d['fps'])
        shift = start_offset(r['slug'])
        dump[r['slug']] = {f'{t:.2f}': peaks(curve, fps, t, shift)
                           for t in (0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8)}
    (ROOT / 'python/out/flashShots.json').write_text(json.dumps(dump), encoding='utf-8')
    print(f'моменты записаны, всего {time.time() - started:.0f} с')


if __name__ == '__main__':
    main()
