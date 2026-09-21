"""Weapon region quantities ON AUDIO CANDIDATES, with per-frame truth from the counter.

This is the very architecture in question: audio gives candidates, video decides. Previously this
was measured against MANUAL labels, which wander by half a frame; now the truth is per-frame and
comes not from a hand but from the ammo counter.

Separately, the thing all of this was started for is counted: MERGED candidates. The 85.5% recall
ceiling exists because in a dense burst several shots get one candidate.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
FIELDS = ('diff_raw', 'diff_flat', 'bright_delta', 'resid_shift', 'resid_affine',
          'field_spread', 'shift_mag', 'div', 'curl', 'ty')
#: A candidate counts as "own" if it is closer than this many frames to a counter shot.
MATCH_FRAMES = 2


def auc(pos: np.ndarray, neg: np.ndarray) -> float:
    if len(pos) == 0 or len(neg) == 0:
        return float('nan')
    both = np.concatenate([pos, neg])
    order = both.argsort()
    ranks = np.empty(len(both))
    ranks[order] = np.arange(1, len(both) + 1)
    _, inv, counts = np.unique(both, return_inverse=True, return_counts=True)
    sums = np.zeros(len(counts))
    np.add.at(sums, inv, ranks)
    ranks = (sums / counts)[inv]
    u = ranks[:len(pos)].sum() - len(pos) * (len(pos) + 1) / 2
    return float(u / (len(pos) * len(neg)))


def main() -> None:
    probe = {c['slug']: c for c in json.loads((ROOT / 'python/out/recoilProbe.json').read_text(encoding='utf-8'))}
    cands = json.loads((ROOT / 'python/out/audioCandidates.json').read_text(encoding='utf-8'))
    times = json.loads((ROOT / 'python/out/frameTimes.json').read_text(encoding='utf-8'))

    pos: dict[str, list[float]] = {f: [] for f in FIELDS}
    neg: dict[str, list[float]] = {f: [] for f in FIELDS}
    pos_conf, neg_conf = [], []
    merged = own_total = 0

    for slug, clip in probe.items():
        if slug not in cands or slug not in times:
            continue
        stamps = np.asarray(times[slug]['times'])
        n = len(clip['series']['div'])
        shots = np.asarray([s for s in clip['shots'] if 1 <= s < n])
        if len(shots) < 3:
            continue
        cframes = np.asarray([int(np.argmin(np.abs(stamps - t))) for t in cands[slug]['times']])
        conf = np.asarray(cands[slug]['confidence'], dtype=float)
        keep = (cframes >= 1) & (cframes < n)
        cframes, conf = cframes[keep], conf[keep]

        # The own candidate is the one nearest to the shot, one per shot. Shots left without
        # a candidate of their own are exactly the recall ceiling.
        taken = {}
        for s in shots:
            d = np.abs(cframes - s)
            if len(d) and d.min() <= MATCH_FRAMES:
                taken.setdefault(int(np.argmin(d)), []).append(int(s))
        own_total += len(shots)
        merged += sum(len(v) - 1 for v in taken.values())

        is_own = np.zeros(len(cframes), dtype=bool)
        is_own[list(taken.keys())] = True
        for name in FIELDS:
            v = np.asarray(clip['series'][name], dtype=float)
            pos[name].extend(v[cframes[is_own]])
            neg[name].extend(v[cframes[~is_own]])
        pos_conf.extend(conf[is_own])
        neg_conf.extend(conf[~is_own])

    print(f'кандидатов своих {len(pos_conf)}, чужих и шума {len(neg_conf)}')
    print(f'своих выстрелов {own_total}, из них СЛИТЫ с соседом в одного кандидата {merged} '
          f'({100 * merged / max(1, own_total):.1f}%)\n')
    print(f'{"величина":16s} {"AUC свой против остальных":>26s}')
    rows = [(f, auc(np.asarray(pos[f]), np.asarray(neg[f]))) for f in FIELDS]
    rows.append(('звук (уверенность)', auc(np.asarray(pos_conf), np.asarray(neg_conf))))
    for name, a in sorted(rows, key=lambda r: -abs(r[1] - 0.5)):
        print(f'{name:16s} {a:26.3f}')


if __name__ == '__main__':
    main()
