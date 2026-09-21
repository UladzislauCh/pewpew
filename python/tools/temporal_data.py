"""Assembling data for the temporal model: the clip as a continuous series.

Everything is brought onto the AUDIO grid (86.13 samples per second, 11.6 ms), not onto video
frames. The reason is the metric: the tolerance is 50 ms, and a video frame is 33 ms, so a hit has
a frame and a half of room. On the audio grid an event can be placed three times more precisely —
and placement is exactly where the ten points visible between the 50 and 100 ms tolerances lie.

Video features are stretched onto the audio grid by holding: nothing new happens between two video
frames, and there is no point pretending it does.

Channels (10):
    audio                      dense ShotNet series, from `eval/audioCurve.ts`
    diff resid spread resid_aff u v    weapon region, from `video_features.py`
    cam_dx cam_dy cam_mag      camera motion

    python3 python/tools/temporal_data.py
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'python/out/temporal'

#: Half-width of the target around a shot, in audio grid samples. Two samples is ±23 ms — well
#: narrower than the metric tolerance (50 ms), so the model learns to place the moment precisely,
#: but not one: with a single sample positive examples become vanishingly few.
TARGET_HALF = 2

def _video_features() -> tuple[str, ...]:
    """Names are taken from the export rather than duplicated: the feature set grows, and a second
    copy of the list would silently diverge from the first."""
    meta = json.loads((ROOT / 'python/out/videofeat/features.json').read_text(encoding='utf-8'))
    return tuple(meta['features'])


VIDEO_FEATURES = _video_features()
CHANNELS = ('audio',) + VIDEO_FEATURES


def build() -> dict:
    curve_dir = ROOT / 'python/out/audioCurve'
    index = json.loads((curve_dir / 'index.json').read_text(encoding='utf-8'))
    times = json.loads((ROOT / 'python/out/frameTimes.json').read_text(encoding='utf-8'))
    feat_dir = ROOT / 'python/out/videofeat'

    OUT.mkdir(parents=True, exist_ok=True)
    made = {}
    for label_path in sorted((ROOT / 'labels').glob('*.json')):
        payload = json.loads(label_path.read_text(encoding='utf-8'))
        slug = payload['slug']
        if not payload.get('complete') or slug not in index or slug not in times:
            continue
        feat_path = feat_dir / f'{slug}.npy'
        if not feat_path.exists():
            continue

        prob = np.fromfile(curve_dir / f'{slug}.f32', dtype=np.float32)
        rate = float(index[slug]['frameRate'])
        video = np.load(feat_path)
        stamps = np.asarray(times[slug]['times'], dtype=np.float64)
        audio_start = float(times[slug].get('audioStart', 0.0))

        # For each audio sample — the nearest video frame. Labels were placed on the audio
        # waveform, so the audio clock is the main one here, and video is pulled onto it.
        t = np.arange(len(prob), dtype=np.float64) / rate
        idx = np.clip(np.searchsorted(stamps - audio_start, t), 0, len(stamps) - 1)
        # searchsorted gives the right boundary; pick the truly nearest of the two neighbours.
        left = np.clip(idx - 1, 0, len(stamps) - 1)
        pick = np.where(
            np.abs(stamps[left] - audio_start - t) <= np.abs(stamps[idx] - audio_start - t), left, idx
        )
        pick = np.clip(pick, 0, len(video) - 1)

        x = np.empty((len(prob), len(CHANNELS)), dtype=np.float32)
        x[:, 0] = prob
        x[:, 1:] = video[pick]

        own = sorted(s['time'] for s in payload.get('shots', []) if s.get('source') == 'own')
        y = np.zeros(len(prob), dtype=np.float32)
        for shot in own:
            c = int(round(shot * rate))
            y[max(0, c - TARGET_HALF):min(len(y), c + TARGET_HALF + 1)] = 1.0

        np.savez_compressed(OUT / f'{slug}.npz', x=x, y=y, rate=rate,
                            shots=np.asarray(own, dtype=np.float64))
        made[slug] = {'frames': int(len(prob)), 'own': len(own), 'rate': rate}
    (OUT / 'index.json').write_text(json.dumps(made, indent=1), encoding='utf-8')
    return made


def load(slug: str) -> dict:
    d = np.load(OUT / f'{slug}.npz')
    return {'x': d['x'], 'y': d['y'], 'rate': float(d['rate']), 'shots': d['shots']}


def clips() -> list[str]:
    return sorted(json.loads((OUT / 'index.json').read_text(encoding='utf-8')))


if __name__ == '__main__':
    made = build()
    total = sum(v['frames'] for v in made.values())
    own = sum(v['own'] for v in made.values())
    print(f'клипов {len(made)}, отсчётов {total}, своих выстрелов {own}')
    print(f'доля положительных отсчётов {100 * own * (2 * TARGET_HALF + 1) / total:.2f}%')
    print(f'каналов {len(CHANNELS)}: {", ".join(CHANNELS)}')
