"""Did anything come alive from the resolution: the same quantities on a single candidate frame."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

import field_series as fs

ROOT = Path(__file__).resolve().parents[2]
MATCH_FRAMES = 2


def main() -> None:
    regions = fs.regions()
    cands = json.loads((ROOT / 'python/out/audioCandidates.json').read_text())
    times = json.loads((ROOT / 'python/out/frameTimes.json').read_text())
    pos = {k: [] for k in fs.SERIES}
    neg = {k: [] for k in fs.SERIES}
    pc, nc = [], []

    for path in sorted(fs.FIELD_DIR.glob('*.npz')):
        slug = path.stem
        s = fs.load(slug, regions[slug])
        n = len(s['diff'])
        shots = np.asarray([x for x in s['shots'] if 1 <= x < n])
        if len(shots) < 3:
            continue
        stamps = np.asarray(times[slug]['times'])
        cf = np.asarray([int(np.argmin(np.abs(stamps - t))) for t in cands[slug]['times']])
        conf = np.asarray(cands[slug]['confidence'], dtype=float)
        keep = (cf >= 1) & (cf < n)
        cf, conf = cf[keep], conf[keep]
        own = np.zeros(len(cf), dtype=bool)
        for sh in shots:
            d = np.abs(cf - sh)
            if len(d) and d.min() <= MATCH_FRAMES:
                own[int(np.argmin(d))] = True
        for k in fs.SERIES:
            pos[k].extend(s[k][cf[own]])
            neg[k].extend(s[k][cf[~own]])
        pc.extend(conf[own])
        nc.extend(conf[~own])

    print(f'кандидатов своих {len(pc)}, прочих {len(nc)}\n')
    rows = [(k, fs.auc(np.asarray(pos[k]), np.asarray(neg[k]))) for k in fs.SERIES]
    rows.append(('звук', fs.auc(np.asarray(pc), np.asarray(nc))))
    print(f'{"величина":12s} {"AUC":>7s}   {"было при 192x96":>16s}')
    was = {'diff': 0.781, 'resid': 0.776, 'resid_aff': 0.619, 'spread': 0.603,
           'div': 0.558, 'curl': 0.505, 'v': 0.458, 'звук': 0.723}
    for k, a in sorted(rows, key=lambda r: -abs(r[1] - 0.5)):
        print(f'{k:12s} {a:7.3f}   {was.get(k, ""):>16}')


if __name__ == '__main__':
    main()
