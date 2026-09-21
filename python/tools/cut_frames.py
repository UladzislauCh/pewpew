"""Cutting frames around labelled shots — material for fine-tuning the flash model.

WHY. Measurement showed the model is almost blind on shotguns (recall 11%) and pistols (34%)
against 78-81% on rifles and machine guns. That is a gap in the training set, not a tuning issue:
a shotgun's flash has a different shape and lasts fewer frames.

WHY THE WINDOW IS WIDE. A flash lives 10-20 ms, a frame lasts 33 ms, and it lands now in one frame,
now in the next. Measured on per-frame curves: the best frame is distributed almost UNIFORMLY
within ±5 frames of the label. A narrow window is exactly what gives "the dataset had almost no
moment with a flash" — the cuts missed.

A ±5-frame window is safe SPECIFICALLY FOR SINGLE FIRE. A rifle's shots come three frames apart,
and such a window pulls in the neighbouring shot; for bursts the window must be narrowed.

TIME ACCOUNTS FOR THE TRACK OFFSET. Labels are on the audio clock, and the first video frame is
not at zero (usually 33 ms). Without the correction the cutting drifts by exactly one frame — the
project has already lost ten points of a measurement to this.

    python3 python/tools/cut_frames.py --clips xm1014,mag7,sawedoff,nova --out dataset/shotguns
    python3 python/tools/cut_frames.py --clips deagle,p2000,five-seven --window 5 --out dataset/pistols
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]


def start_offset(slug: str) -> float:
    """Time of the track's first frame relative to audio."""
    path = ROOT / 'python/out/videoStart.json'
    if not path.exists():
        print('ВНИМАНИЕ: нет python/out/videoStart.json — сначала npx tsx eval/videoStart.ts')
        return 0.0
    e = json.loads(path.read_text(encoding='utf-8')).get(slug, {})
    return float(e.get('videoStart', 0.0)) - float(e.get('audioStart', 0.0))


def score_frames(images: list[np.ndarray]) -> list[float]:
    """The current model's score on each frame — a hint for the labeller, not the truth.

    Needed to see where the model ALREADY fires: the frames worth labelling first are the ones it
    misses. If there is no model, the cutting is done anyway.
    """
    model = ROOT / 'public/models/flashNet.onnx'
    if not model.exists():
        return [float('nan')] * len(images)
    try:
        import onnxruntime as ort
    except ImportError:
        return [float('nan')] * len(images)

    sess = ort.InferenceSession(str(model), providers=['CPUExecutionProvider'])
    size = 640
    out = []
    for frame in images:
        h, w = frame.shape[:2]
        s = min(size / w, size / h)
        nw, nh = int(round(w * s)), int(round(h * s))
        canvas = np.full((size, size, 3), 114, np.uint8)
        oy, ox = (size - nh) // 2, (size - nw) // 2
        canvas[oy:oy + nh, ox:ox + nw] = cv2.resize(frame, (nw, nh))
        x = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB).astype(np.float32).transpose(2, 0, 1)[None] / 255
        out.append(float(sess.run(None, {'images': x})[0][0][4].max()))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--clips', required=True, help='подстроки slug через запятую')
    ap.add_argument('--out', required=True, help='куда класть кадры')
    # The window is set in TIME, not frames: the corpus has both 30 and 60 fps clips,
    # and ±5 frames would give them coverage differing by a factor of two. 165 ms is ±5 frames at 30 fps.
    ap.add_argument('--window-ms', type=int, default=165, help='миллисекунд в КАЖДУЮ сторону')
    ap.add_argument('--quality', type=int, default=95, help='качество jpeg')
    ap.add_argument('--no-score', action='store_true', help='не считать оценку нынешней модели')
    args = ap.parse_args()

    want = tuple(args.clips.split(','))
    out_dir = ROOT / args.out
    out_dir.mkdir(parents=True, exist_ok=True)

    index: list[dict] = []
    for label in sorted((ROOT / 'labels').glob('*.json')):
        payload = json.loads(label.read_text(encoding='utf-8'))
        slug = payload['slug']
        if not slug.startswith(want):
            continue
        video = ROOT / 'examples' / payload['clip']
        if not video.exists():
            print(f'{slug}: нет файла {payload["clip"]}')
            continue

        own = sorted(s['time'] for s in payload.get('shots', []) if s.get('source') == 'own')
        if not own:
            continue

        cap = cv2.VideoCapture(str(video))
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        offset = start_offset(slug)

        # The needed frame numbers are collected IN ADVANCE and read in one sequential pass:
        # seeking with `cap.set` for every frame looks for a keyframe anew each time and on a long
        # clip costs more than reading everything in a row.
        window = max(1, int(round((args.window_ms / 1000) * fps)))
        wanted: dict[int, list[tuple[int, float]]] = {}
        for i, t in enumerate(own):
            base = int(round((t - offset) * fps))
            for d in range(-window, window + 1):
                n = base + d
                if 0 <= n < total:
                    wanted.setdefault(n, []).append((i, t))

        frames: dict[int, np.ndarray] = {}
        n = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if n in wanted:
                frames[n] = frame
            n += 1
        cap.release()

        order = sorted(frames)
        scores = [float('nan')] * len(order)
        if not args.no_score:
            scores = score_frames([frames[k] for k in order])
        score_at = dict(zip(order, scores))

        # ONE FILE PER FRAME, even if it fell into the windows of several shots.
        #
        # Otherwise with fast fire the windows overlap and the same frame goes into the set several
        # times under different names: `five-seven` had 128 unique frames out of 209 entries. For
        # training that is a skew — the model would see some episodes more often than others for
        # no reason at all.
        written = 0
        for number in order:
            near = [
                {'shot': i, 'shotTime': round(t, 3), 'offsetFrames': number - int(round((t - offset) * fps))}
                for i, t in wanted[number]
            ]
            closest = min(near, key=lambda n: abs(n['offsetFrames']))
            name = f'{slug}_f{number:05d}_t{number / fps + offset:07.3f}.jpg'
            cv2.imwrite(str(out_dir / name), frames[number], [cv2.IMWRITE_JPEG_QUALITY, args.quality])
            index.append({
                'file': name, 'slug': slug, 'frame': number,
                'frameTime': round(number / fps + offset, 3),
                # The nearest shot and the offset to it — from these the labeller knows where on
                # the frame to expect the flash. Other shots of the window are listed alongside.
                'shot': closest['shot'], 'shotTime': closest['shotTime'],
                'offsetFrames': closest['offsetFrames'],
                'alsoNear': [n for n in near if n['shot'] != closest['shot']],
                'flashScore': round(score_at[number], 3) if score_at[number] == score_at[number] else None,
            })
            written += 1

        hot = sum(1 for k in order if score_at[k] == score_at[k] and score_at[k] >= 0.4)
        print(f'{slug[:34]:36s} выстрелов {len(own):3d}, кадров {written:4d}, '
              f'{fps:.0f} к/с, окно ±{window} кадров, модель уже видит вспышку на {hot} из {len(order)}')

    existing = []
    index_path = out_dir / 'index.json'
    if index_path.exists():
        fresh = {r['file'] for r in index}
        existing = [r for r in json.loads(index_path.read_text(encoding='utf-8')) if r['file'] not in fresh]
    merged = sorted(existing + index, key=lambda r: r['file'])
    index_path.write_text(json.dumps(merged, ensure_ascii=False, indent=1), encoding='utf-8')
    index = merged
    size = sum(f.stat().st_size for f in out_dir.glob('*.jpg')) / 1e6
    print(f'\nкадров {len(index)}, {size:.0f} МБ, в {out_dir}')
    print('index.json: у каждого кадра клип, номер выстрела, смещение в кадрах и оценка нынешней модели')


if __name__ == '__main__':
    main()
