"""Reading weapon motion on audio candidates: the shape of the process, not the value in a frame.

The task is framed the way it stands in the product: audio has produced candidates, and we must
decide which of them are OWN. The truth is per-frame and comes from the ammo counter, not from a
hand — so the window around a candidate is cut by frames without fear that the label has drifted.

    python3 python/tools/field_model.py [--ridge 1,3,10] [--drop diff]

TWO PITFALLS this very program has already stepped on. Both looked convincing.

1. THE SERIES MUST NOT BE NORMALISED OVER THE CANDIDATE'S NEIGHBOURHOOD. A ±12-frame ring in a
   firefight contains OTHER shots: the background rises exactly where the shot is, and the z-score
   suppresses what we are looking for. Head-to-head on the diff series: raw 0.794, per-clip
   normalisation 0.694, per-neighbourhood normalisation 0.572 — the harm is monotonic in
   locality. The series go in raw.

2. SCORES FROM DIFFERENT FOLDS MUST NOT BE POOLED. They are calibrated differently, and the pooled
   AUC is meaningless: one feature came out at 0.361 against a real 0.612.
   AUC is computed WITHIN a fold, and the median goes out.

Folds are by clip: a clip is entirely either in training or in test. Within a clip candidates
are not independent.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import field_series as fs  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
MATCH_FRAMES = 2
LAGS = (-3, -2, -1, 0, 1, 2, 3)
FOLDS = 8
USE = ('diff', 'resid', 'spread', 'resid_aff', 'rel_mag', 'vrel', 'urel',
       'deviant', 'div', 'curl', 'v', 'u', 'scene_mag')


def _window(series: np.ndarray, frame: int, n: int) -> np.ndarray:
    """Raw series values in the window plus simple differences. No normalisation, see pitfall 1."""
    vals = np.asarray([series[min(n - 1, max(0, frame + d))] for d in LAGS], dtype=np.float64)
    i0 = LAGS.index(0)
    return np.concatenate([vals, [vals[i0] - vals[i0 - 1],
                                  vals[i0] - vals[LAGS.index(2)],
                                  vals[i0] - vals.min(),
                                  vals[i0 + 1:].max() - vals[:i0].max()]])


def build() -> tuple[np.ndarray, np.ndarray, np.ndarray, list[str]]:
    regions = fs.regions()
    cands = json.loads((ROOT / 'python/out/audioCandidates.json').read_text())
    times = json.loads((ROOT / 'python/out/frameTimes.json').read_text())
    rows, labels, groups, names = [], [], [], []

    for gi, path in enumerate(sorted(fs.FIELD_DIR.glob('*.npz'))):
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

        for j, frame in enumerate(cf):
            rows.append(np.concatenate([_window(s[k], int(frame), n) for k in USE] + [[conf[j]]]))
            labels.append(bool(own[j]))
            groups.append(gi)
        if not names:
            tail = [f'l{d}' for d in LAGS] + ['rise', 'decay', 'over_min', 'post_pre']
            names = [f'{k}.{t}' for k in USE for t in tail] + ['audio']
    return np.asarray(rows, dtype=np.float64), np.asarray(labels), np.asarray(groups), names


def fit(x: np.ndarray, y: np.ndarray, ridge: float) -> np.ndarray:
    """Logistic regression by Newton's method.

    A linear model is not laziness but a conclusion from the journal: at this number of clips
    capacity beyond it hurts MONOTONICALLY (a network with 8/24/48 neurons lost the more, the larger it was).
    """
    xb = np.hstack([np.ones((len(x), 1)), x])
    w = np.zeros(xb.shape[1])
    reg = ridge * np.eye(xb.shape[1])
    reg[0, 0] = 0.0
    for _ in range(60):
        p = 1 / (1 + np.exp(-np.clip(xb @ w, -30, 30)))
        s = np.clip(p * (1 - p), 1e-6, None)
        step = np.linalg.solve(xb.T @ (xb * s[:, None]) + reg, xb.T @ (p - y) + reg @ w)
        w -= step
        if np.abs(step).max() < 1e-9:
            break
    return w


def predict(w: np.ndarray, x: np.ndarray) -> np.ndarray:
    return 1 / (1 + np.exp(-np.clip(np.hstack([np.ones((len(x), 1)), x]) @ w, -30, 30)))


def per_fold_auc(x: np.ndarray, y: np.ndarray, groups: np.ndarray, ridge: float) -> list[float]:
    uniq = np.unique(groups)
    out = []
    for f in range(FOLDS):
        te = np.isin(groups, uniq[f::FOLDS])
        tr = ~te
        if y[te].sum() == 0 or (~y[te]).sum() == 0 or y[tr].sum() == 0:
            continue
        mu, sd = x[tr].mean(axis=0), x[tr].std(axis=0)
        sd[sd < 1e-9] = 1.0
        p = predict(fit((x[tr] - mu) / sd, y[tr].astype(float), ridge), (x[te] - mu) / sd)
        out.append(fs.auc(p[y[te]], p[~y[te]]))
    return out


def main() -> None:
    ridges = [float(v) for v in (sys.argv[sys.argv.index('--ridge') + 1].split(',')
                                 if '--ridge' in sys.argv else ['1', '10', '50'])]
    if '--auto' in sys.argv:
        fs.use_auto()
    x, y, groups, names = build()
    print(f'кандидатов {len(y)}, своих {int(y.sum())}, клипов {len(np.unique(groups))}, '
          f'признаков {x.shape[1]}\n')
    pick = lambda p: x[:, [i for i, n in enumerate(names) if p(n)]]  # noqa: E731
    motion = tuple(k for k in USE)
    variants = {
        'звук один': pick(lambda n: n == 'audio'),
        'разница кадров, ОДИН кадр': pick(lambda n: n == 'diff.l0'),
        'разница кадров, окно': pick(lambda n: n.startswith('diff.')),
        'звук + разница, окно': pick(lambda n: n.startswith('diff.') or n == 'audio'),
        'движение без звука': pick(lambda n: n != 'audio'),
        'движение + звук': x,
        'движение + звук, без аффинных': pick(lambda n: not n.startswith(('div.', 'curl.'))),
        'три ряда + звук': pick(lambda n: n.startswith(('diff.', 'spread.', 'vrel.')) or n == 'audio'),
    }
    print(f'{"набор":32s} {"призн.":>7s} ' + ' '.join(f'{"ridge " + str(r):>14s}' for r in ridges))
    for label, xx in variants.items():
        cells = []
        for r in ridges:
            a = per_fold_auc(xx, y, groups, r)
            cells.append(f'{np.median(a):.3f} ({min(a):.2f}-{max(a):.2f})'.rjust(14))
        print(f'{label:32s} {xx.shape[1]:7d} ' + ' '.join(cells))


if __name__ == '__main__':
    main()
