"""Flashbang windows: when both our sensors are blind at once.

A flashbang blinds the player and mutes their sound. In those seconds a shot can be found neither
by the muzzle flash (the screen is whited out) nor by audio (the game muffles everything) — and the
player does not hear them either. So in quality evaluation these windows are dropped entirely:
there is nothing to measure there and nothing to penalise.

Found not by reasoning but by analysis: the user listened to `mp5sd` at 38.5 s, where seven shots
have one label, and explained — "it's a spray there, but after the first shot a flashbang goes
off". He gave the same answer about `ump45`.

THE SIGNATURE, and all three conditions are needed:

  * a SHARP rise within tenths of a second — cuts out smoke and lighting changes;
  * a PLATEAU — cuts out the muzzle flash, which lives one or two frames;
  * a RETURN to the previous level — cuts out an editing cut. A cut gives the same instant jump,
    but the brightness after it stays new. Without this condition the detector marked a quarter of
    the corpus as flashbangs.

Everything is measured FROM THE LEVEL RIGHT BEFORE THE JUMP, not from the median over the second
before it: in `ump45` brightness was rising before the explosion too, the median understated the
background, the rise came out "not sharp enough relative to the jump", and a real flashbang was lost.

    python3 python/tools/flashbangs.py            # windows to eval/flashbangs.json
    python3 python/tools/flashbangs.py --clip mp5sd
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2

ROOT = Path(__file__).resolve().parents[2]
CLIPS = ROOT / 'fixtures/__ammo'
OUT = ROOT / 'eval/flashbangs.json'
#: Offset of the video clock relative to the audio clock: labels live on the audio clock.
VIDEO_START = ROOT / 'python/out/videoStart.json'

RISE_S = 0.15                      # how fast the rise must happen
SHARP_ABS, SHARP_REL = 25.0, 0.15  # size of the rise: brightness levels and fraction
HOLD_S, HOLD_SHARE = 0.4, 0.75     # plateau: how long it holds and at what fraction
BACK_SHARE, BACK_S = 0.35, 5.0     # return: down to what fraction of the rise and within how long


def brightness(path: Path) -> tuple[float, list[float]]:
    cap = cv2.VideoCapture(str(path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    mean: list[float] = []
    while True:
        ok, fr = cap.read()
        if not ok:
            break
        g = cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY)
        # Four times smaller: whole-frame brightness does not change from this, and the corpus
        # is read three times faster.
        small = cv2.resize(g, (g.shape[1] // 4, g.shape[0] // 4))
        mean.append(float(small.mean()))
    cap.release()
    return fps, mean


def windows(fps: float, m: list[float], offset: float) -> list[list[float]]:
    n = len(m)
    hold, rise = max(1, int(HOLD_S * fps)), max(1, int(RISE_S * fps))
    out: list[list[float]] = []
    i = rise
    while i < n - hold:
        pre = m[i - rise]
        sharp = m[i] - pre
        if sharp < SHARP_ABS or sharp < SHARP_REL * pre:
            i += 1
            continue
        if min(m[i:i + hold]) < pre + HOLD_SHARE * sharp:
            i += 1
            continue
        peak = max(m[i:i + hold])
        lim = min(n, i + int(BACK_S * fps))
        back = next((k for k in range(i + hold, lim)
                     if m[k] <= pre + BACK_SHARE * (peak - pre)), None)
        if back is None:                      # brightness did not return — it is a cut
            i += hold
            continue
        out.append([round((i - rise) / fps + offset, 2), round(back / fps + offset, 2)])
        i = back
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--clip', default=None, help='подстрока slug: посчитать один клип')
    args = ap.parse_args()

    start = json.loads(VIDEO_START.read_text()) if VIDEO_START.exists() else {}
    man = json.loads((CLIPS / 'manifest.json').read_text())
    found: dict[str, list[list[float]]] = {}
    if OUT.exists() and args.clip:
        found = json.loads(OUT.read_text())

    for e in man['entries']:
        slug = e['slug']
        if args.clip and args.clip not in slug:
            continue
        video = CLIPS / f'{slug}.mp4'
        if not video.exists():
            continue
        fps, mean = brightness(video)
        s = start.get(slug, {})
        off = float(s.get('videoStart', 0.0)) - float(s.get('audioStart', 0.0))
        w = windows(fps, mean, off)
        found.pop(slug, None)
        if w:
            found[slug] = w
        print(f'{slug[:48]:48} окон {len(w)}  '
              + '  '.join(f'{a:.1f}-{b:.1f}' for a, b in w), flush=True)

    OUT.write_text(json.dumps(dict(sorted(found.items())), indent=1) + '\n')
    print(f'\nокон {sum(len(w) for w in found.values())} в {len(found)} клипах -> {OUT}')


if __name__ == '__main__':
    main()
