"""Stereo centring as a cue for an own shot: a check on the corpus.

THE IDEA BEING TESTED. In CS2 the player's own shot is mixed to the centre — left and right
channels are identical — while others' shots are positioned in space and pan to the side. So the
side channel S = L - R should be silent on own shots and audible on others'.

The project code ALREADY HAD such a gate, and it was removed (see the header of
`src/lib/shotDetection.ts`): it threw out 32% of own shots to remove 22% of others' fire. Here we
check whether it was simply computed badly, and measure three different formulations.

CONCLUSION: the trick is right in theory and does not work on this corpus. Own shots should sit
around -40 dB and below, but they sit at -5.5 dB by clip median; only three clips of forty-five
have them even below -15 dB, and on eight the side channel is LOUDER than the centre on a shot.
The corpus is other people's YouTube highlights: re-encoding in joint stereo, added music,
processing and broadcast mixes fill the side channel regardless of the game.

    python3 python/tools/stereo_probe.py
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[2]
#: Suppressed weapons are excluded for the same reason as everywhere: they have no flash, and the
#: clip belongs to a different conversation.
EXCLUDED = re.compile(r'^(m4a1s|usp-0|mp5sd)-')
#: Transient window: a shot is short, a long window would pull in the background.
ON = (-0.005, 0.030)
#: Background before the shot — for the "increase" formulation, where music is subtracted from energy.
PRE = (-0.120, -0.020)


def band(a: np.ndarray, sr: int, t: float, span: tuple[float, float]):
    i0, i1 = int((t + span[0]) * sr), int((t + span[1]) * sr)
    if i0 < 0 or i1 > len(a) or i1 - i0 < 64:
        return None
    left, right = a[i0:i1, 0], a[i0:i1, 1]
    return float(np.mean(((left + right) / 2) ** 2)), float(np.mean((left - right) ** 2))


def ratio_plain(a, sr, t):
    """Side/mid ratio directly in the shot window."""
    got = band(a, sr, t, ON)
    if got is None:
        return None
    mid, side = got
    return 10 * np.log10(max(side, 1e-12) / max(mid, 1e-12))


def ratio_delta(a, sr, t):
    """The same, but by INCREASE over the background: music and commentary are subtracted."""
    on, pre = band(a, sr, t, ON), band(a, sr, t, PRE)
    if on is None or pre is None:
        return None
    return 10 * np.log10(max(on[1] - pre[1], 1e-12) / max(on[0] - pre[0], 1e-12))


def main() -> None:
    cands = json.loads((ROOT / 'python/out/audioCandidates.json').read_text(encoding='utf-8'))
    buckets = {name: {'own': [], 'other': [], 'extra': []} for name in ('в окне', 'по приросту')}
    per_clip = []

    for path in sorted((ROOT / 'labels').glob('*.json')):
        payload = json.loads(path.read_text(encoding='utf-8'))
        slug = payload['slug']
        if not payload.get('complete'):
            continue
        wav = ROOT / 'examples/.cache' / f'{slug}.wav'
        if not wav.exists():
            continue
        audio, sr = sf.read(str(wav), dtype='float32', always_2d=True)
        if audio.shape[1] < 2:
            continue

        own = [s['time'] for s in payload['shots'] if s.get('source') == 'own']
        other = [s['time'] for s in payload['shots'] if s.get('source') != 'own']
        mine = [v for v in (ratio_plain(audio, sr, t) for t in own) if v is not None]
        if len(mine) >= 3:
            per_clip.append((slug, len(mine), float(np.median(mine))))

        if EXCLUDED.match(slug):
            continue
        for name, fn in (('в окне', ratio_plain), ('по приросту', ratio_delta)):
            for t in own:
                v = fn(audio, sr, t)
                if v is not None:
                    buckets[name]['own'].append(v)
            for t in other:
                v = fn(audio, sr, t)
                if v is not None:
                    buckets[name]['other'].append(v)
            for t in cands.get(slug, {}).get('times', []):
                if any(abs(t - x) <= 0.05 for x in own):
                    continue
                v = fn(audio, sr, t)
                if v is not None:
                    buckets[name]['extra'].append(v)

    for name, groups in buckets.items():
        print(f'\n=== бок/центр, {name} (ниже = ближе к центру), дБ')
        for key, label in (('own', 'СВОИ выстрелы'), ('other', 'ЧУЖИЕ выстрелы'), ('extra', 'лишние кандидаты')):
            x = np.array(groups[key])
            if not len(x):
                continue
            print(f'   {label:22s} n={len(x):5d}  медиана {np.median(x):6.1f}  '
                  f'квартили {np.percentile(x, 25):6.1f} .. {np.percentile(x, 75):6.1f}')
        own, extra, other = (np.array(groups[k]) for k in ('own', 'other', 'extra'))
        for keep in (0.9, 0.8):
            cut = np.percentile(own, 100 * keep)
            print(f'   сохранить {keep:.0%} своих -> отсекается {(extra > cut).mean():.1%} лишних, '
                  f'{(other > cut).mean():.1%} чужих')

    per_clip.sort(key=lambda r: r[2])
    values = [v for _, _, v in per_clip]
    print(f'\n=== по клипам, медиана на своих выстрелах')
    print(f'   клипов {len(per_clip)}, медиана {np.median(values):.1f} дБ, '
          f'разброс {min(values):.1f} .. {max(values):.1f}')
    print(f'   реально в центре (< -15 дБ): {sum(1 for v in values if v < -15)}')
    print(f'   бок ГРОМЧЕ центра (> 0 дБ):  {sum(1 for v in values if v > 0)}')
    print('\n   Теория требует -40 дБ и ниже. Такого нет ни у одного клипа.')


if __name__ == '__main__':
    main()
