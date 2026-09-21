"""Building the digit prototype set from a clip, using cluster labels assigned by eye.

Run rarely and by hand. The order is:

    python3 python/tools/cluster_glyphs.py examples/m4a4.mp4 out.png 0.796 0.790
    # look at out.png, write down the digits in cluster order
    python3 python/tools/make_prototypes.py examples/m4a4.mp4 0.796 0.790 "126033670943..."

There are SEVERAL prototypes per digit, and that is not a defect. The HUD is semi-transparent, the
scene moves through the digit, and the same symbol comes in several renderings. An earlier attempt
fought this by clustering into exactly ten groups and failed; here the classifier is nearest
neighbour over the prototype set, and the spread of renderings helps it.

A "-" in the label string means "junk, not a digit".
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ammo.scan import normalize_glyph, scan_video  # noqa: E402
from tools.cluster_glyphs import CELL, cluster  # noqa: E402


def main() -> None:
    video, want_x, want_y, labels = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
    out = Path(sys.argv[5]) if len(sys.argv) > 5 else Path('python/ammo/prototypes.json')

    result = scan_video(video)
    samples = []
    for slot in result.slots:
        rel = (slot.cx / result.width, slot.cy / result.height)
        if abs(rel[0] - want_x) > 0.03 or abs(rel[1] - want_y) > 0.02:
            continue
        for group in slot.glyphs:
            for glyph in group:
                samples.append(normalize_glyph(glyph, CELL))

    clusters = cluster(samples)
    if len(labels) > len(clusters):
        raise SystemExit(f'разметка длиннее числа кластеров: {len(labels)} > {len(clusters)}')

    prototypes = []
    covered = 0
    for (center, count), label in zip(clusters, labels):
        if label == '-':
            continue
        prototypes.append(
            {
                'digit': int(label),
                'count': int(count),
                'bits': ''.join(str(int(v)) for v in center.flatten()),
            }
        )
        covered += count

    total = sum(c for _, c in clusters)
    payload = {
        'cell': list(CELL),
        'source': Path(video).name,
        'prototypes': prototypes,
    }
    out.write_text(json.dumps(payload, indent=2), encoding='utf-8')

    per_digit: dict[int, int] = {}
    for p in prototypes:
        per_digit[p['digit']] = per_digit.get(p['digit'], 0) + 1
    print(f'прототипов {len(prototypes)}, покрыто глифов {covered}/{total} ({covered / total:.1%})')
    print('на цифру:', {d: per_digit.get(d, 0) for d in range(10)})
    print(f'-> {out}')


if __name__ == '__main__':
    main()
