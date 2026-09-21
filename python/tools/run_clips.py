"""Batch run of the counter over the labelled clips.

Writes JSON that TypeScript then reads and scores with the REAL `scoreDetections` from the product.
There is deliberately no scorer of our own here: two implementations of one metric are two truths,
and the project has already paid for that with five bugs.
"""

from __future__ import annotations

import json
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ammo.pipeline import analyze  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


def clip_index() -> list[tuple[str, str, float]]:
    """Triples (slug, path to video, time of the first frame).

    The first frame time comes from `eval/videoStart.ts`, because OpenCV does not report the track's
    start offset, and a one-frame error goes straight into the metric.
    """
    starts = {}
    start_file = ROOT / 'python/out/videoStart.json'
    if start_file.exists():
        starts = json.loads(start_file.read_text(encoding='utf-8'))
    else:
        print('ВНИМАНИЕ: нет python/out/videoStart.json, время считается от нуля.\n'
              '          Сначала: npx tsx eval/videoStart.ts', flush=True)
    out = []
    for label in sorted((ROOT / 'labels').glob('*.json')):
        payload = json.loads(label.read_text(encoding='utf-8'))
        video = ROOT / 'examples' / payload['clip']
        if video.exists():
            entry = starts.get(payload['slug'], {})
            offset = float(entry.get('videoStart', 0.0)) - float(entry.get('audioStart', 0.0))
            out.append((payload['slug'], str(video), offset))
    return out


def one(task: tuple[str, str, float]) -> dict:
    slug, video, start_time = task
    started = time.time()
    try:
        result = analyze(video, start_time=start_time,
                         candidates=_candidates().get(slug, {}).get('times', [])).to_json()
    except Exception as error:  # noqa: BLE001 — one broken clip must not bring the run down
        return {'slug': slug, 'video': video, 'covered': False, 'error': str(error), 'shots': []}
    result['slug'] = slug
    result['seconds'] = round(time.time() - started, 1)
    return result


_CANDIDATES: dict | None = None


def _candidates() -> dict:
    global _CANDIDATES
    if _CANDIDATES is None:
        path = ROOT / 'python/out/audioCandidates.json'
        if not path.exists():
            print('ВНИМАНИЕ: нет python/out/audioCandidates.json — выравнивания по звуку не будет.\n'
                  '          Сначала: npx tsx eval/audioCandidates.ts', flush=True)
            _CANDIDATES = {}
        else:
            _CANDIDATES = json.loads(path.read_text(encoding='utf-8'))
    return _CANDIDATES


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'python/out/clips.json'
    tasks = clip_index()
    print(f'клипов: {len(tasks)}', flush=True)

    results = []
    with ProcessPoolExecutor(max_workers=6) as pool:
        for i, result in enumerate(pool.map(one, tasks), 1):
            mark = 'да ' if result.get('covered') else 'НЕТ'
            note = (result.get('error', '') or result.get('rejected')
                    or (result.get('score') or {}).get('reason', ''))
            off = result.get('alignOffset')
            shift = f'сдвиг={off * 1000:+4.0f}мс' if off else '            '
            print(f'[{i:2d}/{len(tasks)}] {mark} {result["slug"][:40]:40s} '
                  f'выстрелов={len(result.get("shots", [])):4d}  {shift}  {note}', flush=True)
            results.append(result)

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(results, indent=2), encoding='utf-8')
    covered = sum(1 for r in results if r.get('covered'))
    print(f'\nпокрыто клипов: {covered}/{len(results)}')
    print(f'-> {out}')


if __name__ == '__main__':
    main()
