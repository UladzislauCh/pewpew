"""Analysis of the recoil oracle: is a shot visible in the frame through the deformation of the weapon region.

Computes AUC "shot frame against quiet frame" for each quantity. Per clip, because the scales of
the quantities differ between clips and a common pool mixes them.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
QUIET_GUARD = 10
ISOLATED_GAP = 5
FIELDS = ('resid_shift', 'resid_affine', 'field_spread', 'div', 'curl',
          'shift_mag', 'ty', 'tx', 'diff_raw', 'diff_flat', 'bright_delta')


def auc(pos: np.ndarray, neg: np.ndarray) -> float:
    if len(pos) == 0 or len(neg) == 0:
        return float('nan')
    both = np.concatenate([pos, neg])
    order = both.argsort()
    ranks = np.empty(len(both), dtype=np.float64)
    ranks[order] = np.arange(1, len(both) + 1)
    # Average rank for tied values: without it integer shifts look flattering.
    _, inv, counts = np.unique(both, return_inverse=True, return_counts=True)
    sums = np.zeros(len(counts))
    np.add.at(sums, inv, ranks)
    ranks = (sums / counts)[inv]
    u = ranks[:len(pos)].sum() - len(pos) * (len(pos) + 1) / 2
    return float(u / (len(pos) * len(neg)))


def main() -> None:
    data = json.loads((ROOT / 'python/out/recoilProbe.json').read_text(encoding='utf-8'))
    per_clip: dict[str, list[float]] = {f: [] for f in FIELDS}
    per_clip_abs: dict[str, list[float]] = {'div': [], 'curl': [], 'ty': [], 'tx': []}
    profiles: dict[str, list[np.ndarray]] = {f: [] for f in FIELDS}
    total_pos = total_neg = 0

    for clip in data:
        n = len(clip['series']['div'])
        shots = np.asarray([s for s in clip['shots'] if 1 <= s < n], dtype=int)
        if len(shots) < 3:
            continue
        quiet_mask = np.ones(n, dtype=bool)
        quiet_mask[:1] = False
        for s in shots:
            quiet_mask[max(0, s - QUIET_GUARD):s + QUIET_GUARD + 1] = False
        gaps = np.diff(np.concatenate([[-99], shots, [10 ** 6]]))
        isolated = shots[(gaps[:-1] > ISOLATED_GAP) & (gaps[1:] > ISOLATED_GAP)]
        total_pos += len(shots)
        total_neg += int(quiet_mask.sum())

        for name in FIELDS:
            v = np.asarray(clip['series'][name], dtype=np.float64)
            per_clip[name].append(auc(v[shots], v[quiet_mask]))
            if name in per_clip_abs:
                a = np.abs(v)
                per_clip_abs[name].append(auc(a[shots], a[quiet_mask]))
            # Profile around isolated shots, in units of the clip's quiet-time spread.
            base, spread = np.median(v[quiet_mask]), np.percentile(v[quiet_mask], 84) - np.median(v[quiet_mask])
            if spread <= 0 or len(isolated) == 0:
                continue
            window = [v[max(0, min(n - 1, s + d))] for s in isolated for d in range(-6, 7)]
            profiles[name].append((np.asarray(window).reshape(len(isolated), 13).mean(axis=0) - base) / spread)

    clips = len(per_clip['div'])
    print(f'клипов {clips}, кадров выстрела {total_pos}, кадров затишья {total_neg}\n')
    print(f'{"величина":16s} {"AUC медиана":>12s} {"худший клип":>12s} {"лучший":>8s} {"|AUC| медиана":>14s}')
    rows = sorted(FIELDS, key=lambda f: -abs(np.nanmedian(per_clip[f]) - 0.5))
    for name in rows:
        v = np.asarray(per_clip[name])
        extra = ''
        if name in per_clip_abs:
            extra = f'{np.nanmedian(per_clip_abs[name]):14.3f}'
        print(f'{name:16s} {np.nanmedian(v):12.3f} {np.nanmin(v):12.3f} {np.nanmax(v):8.3f} {extra:>14s}')

    print('\nпрофиль вокруг одиночного выстрела (в разбросах затишья), кадр 0 — выстрел')
    print(f'{"величина":16s} ' + ' '.join(f'{d:+5d}' for d in range(-4, 5)))
    for name in rows:
        if not profiles[name]:
            continue
        p = np.nanmean(np.stack(profiles[name]), axis=0)
        print(f'{name:16s} ' + ' '.join(f'{p[d + 6]:+5.1f}' for d in range(-4, 5)))


if __name__ == '__main__':
    main()
