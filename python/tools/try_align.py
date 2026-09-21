"""Sweeping clip-wide offset estimation schemes on saved moments.

No pass over the video is needed: `shotsVideo` is already in clips.json, so a variant is computed in
seconds instead of four minutes. The metric is still computed by TypeScript — here only the files for
`eval/ammoScore.ts` are prepared.

    python3 python/tools/try_align.py oneToOne
    npx tsx eval/ammoScore.ts python/out/clips-oneToOne.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ammo.align as A  # noqa: E402
from ammo.pipeline import MIN_EVENTS_FOR_SNAP_CHECK, MIN_SNAP_RATE  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]

OFFSETS = np.arange(-0.30, 0.3001, 0.005)
TOLERANCE = 0.040


def many_to_one(events: np.ndarray, cand: np.ndarray, offset: float) -> int:
    """How many moments have a candidate within tolerance. One candidate may count many times."""
    if not len(events) or not len(cand):
        return 0
    idx = np.searchsorted(cand, events + offset)
    best = np.full(len(events), np.inf)
    for shift in (-1, 0):
        j = np.clip(idx + shift, 0, len(cand) - 1)
        best = np.minimum(best, np.abs(cand[j] - (events + offset)))
    return int(np.count_nonzero(best <= TOLERANCE))


def one_to_one(events: np.ndarray, cand: np.ndarray, offset: float) -> int:
    """The same, but strictly one candidate per moment and order-preserving.

    The difference is fundamental in dense fire: with a wrong offset several shots of a burst pile
    onto one candidate, and "many to one" counting does not notice it.
    """
    if not len(events) or not len(cand):
        return 0
    shifted = events + offset
    hits = 0
    j = 0
    for t in shifted:
        while j < len(cand) and cand[j] < t - TOLERANCE:
            j += 1
        if j < len(cand) and abs(cand[j] - t) <= TOLERANCE:
            hits += 1
            j += 1
    return hits


SCORERS = {'manyToOne': many_to_one, 'oneToOne': one_to_one}


def estimate(events: np.ndarray, cand: np.ndarray, scorer, gain: float, min_abs: float,
             interval_cap: float = 0.0, unique: float = 0.0) -> float:
    if len(events) < 3 or not len(cand):
        return 0.0
    # Resolvability limit: an offset larger than the clip's inter-shot interval is indistinguishable
    # from landing on the NEIGHBOURING shot of a burst. For dense fire that is almost a ban, for sparse
    # fire almost freedom, and that is exactly what the task requires.
    cap = 1e9
    if interval_cap > 0 and len(events) >= 3:
        cap = interval_cap * float(np.median(np.diff(events)))
    base = scorer(events, cand, 0.0)
    allowed = [o for o in OFFSETS
               if abs(o) <= cap and not (min_abs > 0 and 0 < abs(o) < min_abs)]
    scores = {float(o): scorer(events, cand, float(o)) for o in allowed}
    best_offset, best_hits = 0.0, base
    for o, h in scores.items():
        if h > best_hits or (h == best_hits and abs(o) < abs(best_offset)):
            best_offset, best_hits = o, h
    if best_hits < base + 2 or best_hits < base * gain:
        return 0.0
    if unique > 0:
        # The peak must be UNIQUE. If some distant offset explains just as many events, they can be
        # explained by anything — usually by others' fire, which produces no fewer candidates than
        # our own.
        rival = max((h for o, h in scores.items() if abs(o - best_offset) > 0.06), default=0)
        if best_hits < rival + unique:
            return 0.0
    return best_offset


def main() -> None:
    name = sys.argv[1] if len(sys.argv) > 1 else 'oneToOne'
    scorer = SCORERS[sys.argv[2]] if len(sys.argv) > 2 else SCORERS['oneToOne']
    gain = float(sys.argv[3]) if len(sys.argv) > 3 else 1.2
    min_abs = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0
    interval_cap = float(sys.argv[5]) if len(sys.argv) > 5 else 0.0
    unique = float(sys.argv[6]) if len(sys.argv) > 6 else 0.0
    half_frame = True

    audio = json.loads((ROOT / 'python/out/audioCandidates.json').read_text())
    runs = json.loads((ROOT / 'python/out/clips.json').read_text())

    for run in runs:
        video = run.get('shotsVideo') or []
        if not video:
            continue
        if half_frame:
            video = [t + 0.5 / run['fps'] for t in video]
        a = audio.get(run['slug'], {})
        cand = np.array(sorted(a.get('times', [])), dtype=float)
        ev = np.array(sorted(video), dtype=float)

        offset = estimate(ev, cand, scorer, gain, min_abs, interval_cap, unique)
        alignment = A.align((ev + offset).tolist(), cand.tolist())
        run['shots'] = alignment.times
        run['alignOffset'] = round(offset, 4)
        run['alignSnapped'] = alignment.snapped
        run['rejected'] = None
        if len(cand) and len(ev) >= MIN_EVENTS_FOR_SNAP_CHECK and alignment.snapped / len(ev) < MIN_SNAP_RATE:
            run['rejected'] = 'спуски не совпадают со звуком'
        run['covered'] = run.get('score') is not None and run['rejected'] is None

    out = ROOT / f'python/out/clips-{name}.json'
    out.write_text(json.dumps(runs), encoding='utf-8')
    shifted = sum(1 for r in runs if r.get('alignOffset'))
    print(f'{name}: сдвинуто {shifted}, покрыто {sum(1 for r in runs if r.get("covered"))} -> {out}')


if __name__ == '__main__':
    main()
