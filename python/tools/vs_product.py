"""Python field reading against the SHIPPED motion model, on the same material.

The same clips, the same candidates, the same per-frame labels from the counter. The numbers from
the journal (AUC 0.910) are not comparable: that was 49 clips, manual labels and a different pool.

Product scores come from `eval/motionScores.html` — that is the real product path, not a copy of
the formulas.

    npx tsx eval/ammoPrep.ts && npm run dev     # then /eval/motionScores.html
    python3 python/tools/vs_product.py          # per clip
    python3 python/tools/vs_product.py --add    # does Python add anything to the product

THE COMPARISON IS GENEROUS TO THE PRODUCT: its weights were trained on all clips without a held-out
set, i.e. on these too, whereas the Python model is checked by training without the clip. So the
real gap is not smaller than measured, but larger.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import field_model as fm  # noqa: E402
import field_series as fs  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
MATCH_FRAMES = 2


def product_column(slugs: list[str], groups: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Product score in the same row order as the Python features."""
    prod = {r['slug']: r for r in json.loads((ROOT / 'eval/.cache/motionScores.json').read_text())}
    times = json.loads((ROOT / 'python/out/frameTimes.json').read_text())
    cands = json.loads((ROOT / 'python/out/audioCandidates.json').read_text())
    regions = fs.regions()
    col, ok = [], []
    for gi, slug in enumerate(slugs):
        if not (groups == gi).any():
            continue
        n = len(fs.load(slug, regions[slug])['diff'])
        stamps = np.asarray(times[slug]['times'])
        cf = np.asarray([int(np.argmin(np.abs(stamps - t))) for t in cands[slug]['times']])
        keep = (cf >= 1) & (cf < n)
        scores = prod.get(slug, {}).get('scores', [])
        if len(scores) != len(cf):
            col.extend([0.0] * int(keep.sum()))
            ok.extend([False] * int(keep.sum()))
            continue
        col.extend(np.asarray([v['score'] for v in scores])[keep])
        ok.extend([True] * int(keep.sum()))
    return np.asarray(col), np.asarray(ok)


def leave_one_clip(xx: np.ndarray, y: np.ndarray, g: np.ndarray) -> dict[int, float]:
    """Training without the clip, AUC WITHIN that clip. Stricter than folds: scale differences
    between clips inside a fold cannot help."""
    out = {}
    for cl in np.unique(g):
        te = g == cl
        tr = ~te
        if y[te].sum() < 2 or (~y[te]).sum() < 2:
            continue
        mu, sd = xx[tr].mean(axis=0), xx[tr].std(axis=0)
        sd[sd < 1e-9] = 1.0
        p = fm.predict(fm.fit((xx[tr] - mu) / sd, y[tr].astype(float), 10.0), (xx[te] - mu) / sd)
        out[int(cl)] = fs.auc(p[y[te]], p[~y[te]])
    return out


def main() -> None:
    fs.use_auto()
    x, y, g, names = fm.build()
    slugs = [p.stem for p in sorted(fs.FIELD_DIR.glob('*.npz'))]
    pcol, ok = product_column(slugs, g)
    x, y, g, pcol = x[ok], y[ok], g[ok], pcol[ok]
    audio = x[:, names.index('audio')]

    sets = {
        'звук один': np.column_stack([audio]),
        'продукт один': np.column_stack([pcol]),
        'питон (движение + звук)': x,
        'продукт + питон': np.column_stack([pcol, x]),
    }
    res = {k: leave_one_clip(v, y, g) for k, v in sets.items()}
    clips = sorted(res['продукт один'])

    print(f'клипов {len(clips)}, кандидатов {len(y)}, своих {int(y.sum())}\n')
    if '--add' not in sys.argv:
        print(f'{"клип":34s} {"звук":>7s} {"продукт":>9s} {"питон":>8s} {"разница":>9s}')
        for cl in clips:
            a, p, q = res['звук один'][cl], res['продукт один'][cl], res['питон (движение + звук)'][cl]
            print(f'{slugs[cl][:34]:34s} {a:7.3f} {p:9.3f} {q:8.3f} {q - p:+9.3f}')
        print()

    print(f'{"набор":26s} {"медиана":>8s} {"среднее":>8s} {"худший клип":>12s}')
    for label, r in res.items():
        v = np.asarray([r[c] for c in clips])
        print(f'{label:26s} {np.median(v):8.3f} {np.mean(v):8.3f} {min(v):12.3f}')

    base = np.asarray([res['продукт один'][c] for c in clips])
    comb = np.asarray([res['продукт + питон'][c] for c in clips])
    print(f'\nпродукт + питон против продукта одного: побед {int((comb > base).sum())} из {len(base)}, '
          f'медиана разницы {np.median(comb - base):+.3f}, среднее {np.mean(comb - base):+.3f}')


if __name__ == '__main__':
    main()
