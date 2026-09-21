"""Who is right: the counter or the label? Checking both against the waveform.

Labels were placed on the waveform, the counter lives in the video. If they disagree, the cause is
either track desync or the label itself. Only a third party can tell them apart — the audio itself:
we look for the nearest sharp energy rise and see which of the two it is closer to.

The waveform is taken from `examples/.cache/<slug>.wav` — the same cache `npm run eval` uses,
32-bit float, bit-identical to the samples the app analyses.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from scipy.io import wavfile

ROOT = Path(__file__).resolve().parents[2]


def read_wav_float32(path: Path) -> tuple[np.ndarray, int]:
    """32-bit float WAV to mono.

    The standard `wave` module cannot open this format (tag 3, IEEE float), hence scipy. This is
    an exploration tool, it does not ship in the product.
    """
    rate, data = wavfile.read(str(path))
    data = np.asarray(data, dtype=np.float32)
    if data.ndim > 1:
        data = data.mean(axis=1)
    return data, int(rate)


def onsets(samples: np.ndarray, rate: int, hop: int = 128) -> tuple[np.ndarray, np.ndarray]:
    """A rough attack curve: energy growth from window to window.

    This is NOT the project's detector and does not claim to replace it — all that is needed here
    is an independent reference for "where in the audio is a sharp transient".
    """
    frames = len(samples) // hop
    energy = np.array([float(np.sqrt(np.mean(samples[i * hop : (i + 1) * hop] ** 2))) for i in range(frames)])
    rise = np.maximum(0.0, np.diff(energy, prepend=energy[0]))
    times = np.arange(frames) * hop / rate
    return times, rise


def nearest_onset(times: np.ndarray, rise: np.ndarray, at: float, window: float = 0.35) -> float | None:
    """The strongest rise in a window around the moment."""
    lo, hi = np.searchsorted(times, at - window), np.searchsorted(times, at + window)
    if hi <= lo:
        return None
    local = rise[lo:hi]
    if not local.size or local.max() <= 0:
        return None
    return float(times[lo + int(np.argmax(local))])


def main() -> None:
    slugs = sys.argv[1:]
    runs = {r['slug']: r for r in json.loads((ROOT / 'python/out/clips.json').read_text())}

    for slug in slugs:
        run = runs.get(slug)
        if not run or not run.get('covered'):
            print(f'{slug}: не покрыт'); continue

        labels = json.loads((ROOT / f'labels/{slug}.json').read_text())
        own = np.array(sorted(s['time'] for s in labels['shots'] if s.get('source') == 'own'))
        pred = np.array(sorted(run['shots']))

        samples, rate = read_wav_float32(ROOT / f'examples/.cache/{slug}.wav')
        times, rise = onsets(samples, rate)

        # For each of OUR labels: where the nearest transient is and where the nearest human label is.
        d_counter, d_label = [], []
        for t in pred:
            onset = nearest_onset(times, rise, t)
            if onset is None:
                continue
            d_counter.append(onset - t)
            if len(own):
                d_label.append(onset - own[np.argmin(np.abs(own - t))])

        if not d_counter:
            print(f'{slug}: транзиентов рядом нет'); continue
        c, l = np.array(d_counter), np.array(d_label)
        print(f'{slug:32s} n={len(c):3d}')
        print(f'    транзиент минус СЧЁТЧИК: медиана {np.median(c) * 1000:+6.0f}мс  '
              f'p25..p75 {np.percentile(c, 25) * 1000:+.0f}..{np.percentile(c, 75) * 1000:+.0f}')
        print(f'    транзиент минус МЕТКА:   медиана {np.median(l) * 1000:+6.0f}мс  '
              f'p25..p75 {np.percentile(l, 25) * 1000:+.0f}..{np.percentile(l, 75) * 1000:+.0f}')


if __name__ == '__main__':
    main()
