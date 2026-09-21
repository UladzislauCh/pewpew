"""Reconciling manual labels with the ammo counter.

A report for the person who will go and fix labels. The comparison is BY EPISODE, not by
individual label, and that is fundamental: the counter knows the NUMBER of shots reliably, but
the moment only to within a frame. So the question is "how many shots were in this burst", not
"did the label match the event".

The evidence in the report is the game's own reading series: "27 -> 24" means three shots, and
there is nothing to argue about.

A caveat without which the report must not be used: the counter is not all-powerful either. It is
blind when the HUD cannot be read — knife in hand, an overlay, a weapon switch. So every episode
prints whether the counter was read nearby, and episodes without reads are marked separately:
there a discrepancy does NOT mean a labelling error.

    python3 python/tools/audit_labels.py            # report to python/out/audit.txt
    python3 python/tools/audit_labels.py --clip m4a4
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# The gap at which firing is split into episodes. 400 ms is well above the inter-shot interval
# of the slowest automatic weapon and well below a typical pause between bursts.
EPISODE_GAP_S = 0.40

# What share of the episode the counter must have been read for its readings to be trusted.
MIN_READ_COVERAGE = 0.75

# A decrement larger than this in one step of the series is not a burst but a read error. The same
# bound as in ammo/events.py: that many shots do not fit into one frame interval.
MAX_STEP = 3


def episodes(times: list[float], gap: float = EPISODE_GAP_S) -> list[tuple[float, float]]:
    """Time spans within which events come no more than `gap` apart."""
    if not times:
        return []
    spans = []
    start = previous = times[0]
    for t in times[1:]:
        if t - previous > gap:
            spans.append((start, previous))
            start = t
        previous = t
    spans.append((start, previous))
    return spans


def merge(spans: list[tuple[float, float]], gap: float = EPISODE_GAP_S) -> list[tuple[float, float]]:
    """Merge overlapping and close spans."""
    if not spans:
        return []
    spans = sorted(spans)
    out = [list(spans[0])]
    for a, b in spans[1:]:
        if a - out[-1][1] <= gap:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [(a, b) for a, b in out]


def ammo_change(series: list[tuple[float, int]], start: float, end: float) -> tuple[str, int | None]:
    """What the counter showed in the episode and how many shots that is.

    The number is returned only if the series can be trusted. It cannot in two cases: the counter
    was not read in the episode at all, or the series has an implausible jump — a decrement of more
    than `MAX_STEP` in one step. Such a jump is a read error (seen: "12 -> 1 -> 11"), and adding it
    up as shots produces nonsense.
    """
    # The value IN EFFECT on entering the episode. Taking the last entry "no later than the start"
    # is wrong: the first shot of a burst changes the counter almost simultaneously with the start
    # of the episode, and then its own drop is lost. We step back 100 ms.
    before = [v for t, v in series if t <= start - 0.10]
    inside = [(t, v) for t, v in series if start - 0.10 < t <= end + 0.20]
    if not inside:
        return ('счётчик молчал', None)

    values = ([before[-1]] if before else []) + [v for _, v in inside]
    shots = 0
    reloaded = False
    broken = False
    for a, b in zip(values, values[1:]):
        if b < a:
            if a - b > MAX_STEP:
                broken = True
            shots += a - b
        elif b > a:
            reloaded = True

    path = ' -> '.join(str(v) for v in values[:10]) + (' ...' if len(values) > 10 else '')
    if reloaded:
        path += '  [была перезарядка]'
    if broken:
        path += '  [СБОЙ ЧТЕНИЯ: скачок больше чем на 3]'
        return (path, None)
    return (path, shots)


def read_coverage(spans: list[tuple[float, float]], start: float, end: float) -> float:
    """What share of the episode fell into spans where the counter was read.

    Computed over READ spans, not change points: a quiet stretch is read, but the value on it is
    constant, and by the change series it would look blind.
    """
    width = max(1e-6, (end + 0.15) - (start - 0.15))
    covered = 0.0
    for a, b in spans:
        lo, hi = max(a, start - 0.15), min(b, end + 0.15)
        if hi > lo:
            covered += hi - lo
    return min(1.0, covered / width)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--clip', default=None, help='подстрока slug, чтобы посмотреть один клип')
    parser.add_argument('--out', default=None)
    args = parser.parse_args()
    # Viewing one clip must not overwrite the full report.
    out = Path(args.out) if args.out else ROOT / 'python/out' / (
        f'audit-{args.clip}.txt' if args.clip else 'audit.txt'
    )

    runs = json.loads((ROOT / 'python/out/clips.json').read_text(encoding='utf-8'))
    lines: list[str] = []
    summary: list[tuple[str, int, int, float, int, int, str]] = []

    for run in sorted(runs, key=lambda r: r['slug']):
        if not run.get('covered'):
            continue
        if args.clip and args.clip not in run['slug']:
            continue

        labels = json.loads((ROOT / f"labels/{run['slug']}.json").read_text(encoding='utf-8'))
        own = sorted(s['time'] for s in labels['shots'] if s.get('source') == 'own')
        events = sorted(run['shots'])
        series = [(t, v) for t, v in run.get('series', [])]
        read_spans = [(a, b) for a, b in run.get('readSpans', [])]
        shooting = merge(episodes(own) + episodes(events))
        disagreements = 0
        blind = 0
        block: list[str] = []

        for start, end in shooting:
            in_labels = [t for t in own if start - 0.05 <= t <= end + 0.05]
            in_events = [t for t in events if start - 0.05 <= t <= end + 0.05]
            path, by_ammo = ammo_change(series, start, end)
            coverage = read_coverage(read_spans, start, end)
            trusted = coverage >= MIN_READ_COVERAGE

            # If the series cannot be trusted, neither can the readings: then the episode goes
            # into the "blind" ones rather than being passed off as a labelling discrepancy.
            expected = by_ammo if by_ammo is not None else len(in_events)
            if len(in_labels) == expected:
                continue

            if not trusted or by_ammo is None:
                blind += 1
                why = f'{coverage:.0%} эпизода' if coverage < MIN_READ_COVERAGE else 'сбой чтения'
                mark = f'СЧЁТЧИК НЕНАДЁЖЕН ({why}) — расхождение может быть не ваше'
            else:
                disagreements += 1
                mark = 'ДОБАВИТЬ' if expected > len(in_labels) else 'ЛИШНИЕ'

            shown = str(expected) if by_ammo is not None else '  ?'
            block.append(
                f'  {start:7.2f}..{end:6.2f}  размечено {len(in_labels):3d}   счётчик {shown:>3s}   '
                f'{mark}\n      показания: {path}'
            )

        # Trust in the clip as a whole. A slot outside the bottom part of the frame is not a HUD
        # line but the match score at the top or a timer, and labels must not be fixed by it.
        slot = run.get('slot') or {}
        presence = slot.get('presence', 0.0)
        if not 0.60 < slot.get('y', 0.0) < 1.0:
            trust = 'СЛОТ НЕ В HUD — НЕ ПРАВИТЬ'
        elif presence < 0.55:
            trust = 'слот виден меньше половины клипа'
        else:
            trust = ''

        summary.append((run['slug'], len(own), len(events), presence, disagreements, blind, trust))
        if block:
            lines.append(f"\n=== {run['slug']}   размечено {len(own)}, счётчик {len(events)}, "
                         f"слот виден в {presence:.0%} клипа"
                         + (f'   [{trust}]' if trust else ''))
            lines.extend(block)

    header = [
        'СВЕРКА РАЗМЕТКИ СО СЧЁТЧИКОМ ПАТРОНОВ',
        '',
        'Сравнение по эпизодам стрельбы, а не по отдельным меткам: счётчик надёжно знает',
        'КОЛИЧЕСТВО выстрелов, а момент — только с точностью до кадра.',
        '',
        'ДОБАВИТЬ — игра списала больше патронов, чем размечено выстрелов.',
        'ЛИШНИЕ  — размечено больше, чем игра списала патронов.',
        f'СЧЁТЧИК НЕНАДЁЖЕН — читался меньше чем на {MIN_READ_COVERAGE:.0%} эпизода (нож в руках,',
        '               оверлей, смена оружия) либо в ряду сбой чтения.',
        '               Здесь расхождение НЕ означает ошибку разметки.',
        '',
        'Столбец "слот" — доля клипа, где счётчик вообще присутствовал в кадре.',
        'Клипы с пометкой "СЛОТ НЕ В HUD" править по этому отчёту нельзя: там опознан',
        'не боезапас, а верхний счёт матча.',
        '',
        f'{"клип":42s} {"метки":>6s} {"счётчик":>8s} {"слот":>6s} {"спорных":>8s} {"слепых":>7s}  примечание',
    ]
    for slug, n_own, n_ev, rate, dis, bl, trust in summary:
        header.append(f'{slug[:42]:42s} {n_own:6d} {n_ev:8d} {rate:6.0%} {dis:8d} {bl:7d}  {trust}')

    report = '\n'.join(header + lines) + '\n'
    out.write_text(report, encoding='utf-8')
    print(report if args.clip else '\n'.join(header))
    print(f'\nполный отчёт -> {out}')


if __name__ == '__main__':
    main()
