"""From probabilities over time — to shot moments.

The metric is computed by TypeScript (`eval/temporalScore.ts`): there is deliberately no scorer in
Python, two implementations of one metric are two truths.

The threshold is swept, and that is HONEST only as a curve. Picking the best number off it and
declaring it the result is not allowed: the threshold would be tuned on the same clips we measure
on. A claim needs a threshold chosen on the training folds.

    python3 python/tools/temporal_peaks.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import temporal_data as td  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
PROB = ROOT / 'python/out/temporalProb'
#: Two own shots cannot be closer than this — the cycle of the fastest-firing CS2 weapon.
MIN_GAP_S = 0.05
THRESHOLDS = (0.5, 0.7, 0.8, 0.85, 0.9, 0.93, 0.95, 0.97, 0.99)


def peaks(prob: np.ndarray, rate: float, threshold: float) -> list[float]:
    gap = max(1, int(round(MIN_GAP_S * rate)))
    out: list[float] = []
    order = np.argsort(-prob)
    taken = np.zeros(len(prob), dtype=bool)
    for i in order:
        if prob[i] < threshold:
            break
        lo, hi = max(0, i - gap), min(len(prob), i + gap + 1)
        if taken[lo:hi].any():
            continue
        taken[i] = True
        out.append(float(i) / rate)
    return sorted(out)


def main() -> None:
    meta = json.loads((PROB / 'index.json').read_text(encoding='utf-8'))
    test: dict[str, dict[str, list[float]]] = {}
    train: dict[str, dict[str, dict[str, list[float]]]] = {}
    for slug in meta['clips']:
        rate = td.load(slug)['rate']
        path = PROB / f'{slug}.npy'
        if path.exists():
            prob = np.load(path)
            test[slug] = {str(t): peaks(prob, rate, t) for t in THRESHOLDS}
        # Predictions on each fold's training clips — the threshold is chosen on them.
        for fold in sorted(set(meta['folds'].values())):
            p = PROB / f'train-{fold}-{slug}.npy'
            if not p.exists():
                continue
            prob = np.load(p)
            train.setdefault(str(fold), {})[slug] = {str(t): peaks(prob, rate, t) for t in THRESHOLDS}
    out = ROOT / 'python/out/temporalShots.json'
    out.write_text(json.dumps({'channels': meta['channels'], 'folds': meta['folds'],
                               'test': test, 'train': train}), encoding='utf-8')
    result = test
    counts = {t: sum(len(v[str(t)]) for v in result.values()) for t in THRESHOLDS}
    print(f'клипов {len(result)}; меток по порогам: {counts}')
    print(f'записано {out}')


if __name__ == '__main__':
    main()
