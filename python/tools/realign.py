"""Fast alignment sweep without recomputing the video.

Video moments (`shotsVideo`) are already in `clips.json`, while a pass over the video takes four
minutes. The alignment rule can be swept over them in seconds, and this is exactly the trick by
which, in the 21-24 August session, fourteen weighting schemes took seconds instead of an hour.

    python3 python/tools/realign.py python/out/clips-variant.json --gate 1.2

The metric is then computed by `npx tsx eval/ammoScore.ts <file>`.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ammo.align as A  # noqa: E402
from ammo.pipeline import MIN_EVENTS_FOR_SNAP_CHECK, MIN_SNAP_RATE  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('out', nargs='?', default=str(ROOT / 'python/out/clips-realigned.json'))
    parser.add_argument('--snap', type=float, default=A.SNAP_WINDOW_S)
    parser.add_argument('--max-offset', type=float, default=A.MAX_OFFSET_S)
    parser.add_argument('--tolerance', type=float, default=A.OFFSET_TOLERANCE_S)
    args = parser.parse_args()

    A.SNAP_WINDOW_S = args.snap
    A.MAX_OFFSET_S = args.max_offset
    A.OFFSET_TOLERANCE_S = args.tolerance

    audio = json.loads((ROOT / 'python/out/audioCandidates.json').read_text())
    runs = json.loads((ROOT / 'python/out/clips.json').read_text())

    shifted = 0
    for run in runs:
        video = run.get('shotsVideo') or []
        if not video:
            continue
        a = audio.get(run['slug'], {})
        alignment = A.align(video, a.get('times', []))
        run['shots'] = alignment.times
        run['alignOffset'] = round(alignment.offset, 4)
        run['alignSnapped'] = alignment.snapped
        run['alignKept'] = alignment.kept
        if alignment.offset:
            shifted += 1

        # The same plausibility check as in the pipeline: an own shot always makes a sound.
        run['rejected'] = None
        if a.get('times') and len(video) >= MIN_EVENTS_FOR_SNAP_CHECK:
            rate = alignment.snapped / len(video)
            if rate < MIN_SNAP_RATE:
                run['rejected'] = f'спуски не совпадают со звуком ({rate:.0%} притянуто)'
        run['covered'] = run.get('score') is not None and run['rejected'] is None

    Path(args.out).write_text(json.dumps(runs, indent=2), encoding='utf-8')
    covered = sum(1 for r in runs if r.get('covered'))
    print(f'окно {args.snap * 1000:.0f}мс: покрыто {covered}, сдвинуто {shifted} -> {args.out}')


if __name__ == '__main__':
    main()
