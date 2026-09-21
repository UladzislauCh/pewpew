"""Per-frame series from a saved motion field. A shared module for measurements.

The field is stored as (frames, blocks, 4): u, v, block residual, block difference. Scalar series
are computed from it here, including ones RELATIVE TO THE SCENE: the viewmodel is defined by not
moving with the camera, so the overall frame drift is subtracted from the field.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
FIELD_DIR = ROOT / 'python/out/field'


def use_auto(suffix: str = '') -> None:
    """Switch to the product's boxes: a transfer check, see field_probe.py --auto.

    `suffix` selects a set with different field parameters — needed to find the cheapest one that
    keeps the gain.
    """
    global FIELD_DIR, _AUTO, GRID_X, GRID_Y, CROP_W, CROP_H, _DESIGN, _PINV
    FIELD_DIR = ROOT / f'python/out/field-auto{suffix}'
    _AUTO = True
    if suffix:
        parts = [q for q in suffix.lstrip('-').split('-') if q != 'blocks']
        CROP_W, CROP_H = (int(v) for v in parts[0].split('x'))
        GRID_X, GRID_Y = (int(v) for v in parts[1].lstrip('g').split('x'))
        _DESIGN = _design()
        _PINV = np.linalg.pinv(_DESIGN)


_AUTO = False
GRID_X, GRID_Y = 8, 4
SCENE_W, SCENE_H = 160, 90
CROP_W, CROP_H = 320, 160

SERIES = ('diff', 'resid', 'spread', 'div', 'curl', 'resid_aff',
          'u', 'v', 'urel', 'vrel', 'rel_mag', 'deviant', 'scene_mag')


def _design() -> np.ndarray:
    cy, cx = np.mgrid[0:GRID_Y, 0:GRID_X]
    cx = (cx.ravel() + 0.5) / GRID_X * 2 - 1
    cy = (cy.ravel() + 0.5) / GRID_Y * 2 - 1
    return np.stack([np.ones_like(cx), cx, cy], axis=1)


_DESIGN = _design()
_PINV = np.linalg.pinv(_DESIGN)


def load(slug: str, region: dict) -> dict[str, np.ndarray]:
    data = np.load(FIELD_DIR / f'{slug}.npz')
    field, scene = data['field'], data['scene']
    u, v = field[:, :, 0], field[:, :, 1]

    # Scene drift in BOX pixels: the scene was measured on a 160x90 frame, the box is scaled to 320x160.
    fx = max(1e-6, region['x1'] - region['x0'])
    fy = max(1e-6, region['y1'] - region['y0'])
    su = scene[:, 0] * (CROP_W / SCENE_W) / fx
    sv = scene[:, 1] * (CROP_H / SCENE_H) / fy

    urel, vrel = u - su[:, None], v - sv[:, None]
    coef_u = u @ _PINV.T
    coef_v = v @ _PINV.T
    fit_u, fit_v = coef_u @ _DESIGN.T, coef_v @ _DESIGN.T

    out = {
        'diff': field[:, :, 3].mean(axis=1),
        'resid': field[:, :, 2].mean(axis=1),
        'spread': np.hypot(u - u.mean(axis=1, keepdims=True), v - v.mean(axis=1, keepdims=True)).mean(axis=1),
        'div': coef_u[:, 1] + coef_v[:, 2],
        'curl': coef_v[:, 1] - coef_u[:, 2],
        'resid_aff': np.hypot(u - fit_u, v - fit_v).mean(axis=1),
        'u': u.mean(axis=1),
        'v': v.mean(axis=1),
        'urel': urel.mean(axis=1),
        'vrel': vrel.mean(axis=1),
        'rel_mag': np.hypot(urel, vrel).mean(axis=1),
        # Share of blocks that do NOT move with the scene: a cue for the viewmodel itself.
        'deviant': (np.hypot(urel, vrel) > 1.5).mean(axis=1),
        'scene_mag': np.hypot(su, sv),
    }
    out['shots'] = data['shots']
    return out


def regions() -> dict:
    if _AUTO:
        import field_probe
        return field_probe.auto_regions()
    return json.loads((ROOT / 'eval/weaponRegions.json').read_text())['regions']


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
