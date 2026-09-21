"""Burst period by audio autocorrelation: tested, does not work on this corpus.

THE IDEA. The fire-rate grid is strong, but its period is fitted to audio candidates, and there
are three times more of them than shots, so a dense grid finds support by chance: `ak47` comes
out at 857 rounds per minute instead of the spec 600. Autocorrelation should fix that: it works
on a CONTINUOUS envelope, and the density of the peak list does not matter to it.

AN IMPORTANT CORRECTION TO THE PREMISE. Our period is already computed from audio, not from video
frames — the grid is anchored to audio candidates. The 857 rpm error comes not from frame
quantisation but from candidate density.

MEASURED, 21 clips with the weapon known from the name. The estimate is compared with the spec
fire rate and rounded to the nearest rate in the table:

  ShotNet curve, raw autocorrelation            3 of 21
  the same, normalised by overlap               6 of 20
  the same, first high-enough peak              6 of 20
  raw audio attack envelope, 2 ms               5 of 21

The best is six of twenty. For comparison, the current fit by candidates is wrong on `ak47`,
`aug` and some compilation clips, but gets `bizon`, `deagle` and scoped weapons right.

WHY IT DOES NOT WORK. Bursts are short — four to fifteen shots, i.e. a dozen periods, and the
autocorrelation has nothing to converge on. Inside a burst there are echoes, hits, others' fire
and music added by the editor, which has its own steady tempo: errors go both ways, from three
times slower (`mp7` 750 -> 246) to three times faster (`g3sg1` 240 -> 789), and not only at
subharmonics, as happens with a clean signal.

    python3 python/tools/period_probe.py
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[2]

#: Spec fire rate by clip name — the only reference that does not depend on the
#: labels.
RPM = {
    'mp9': 857, 'mac10': 800, 'bizon': 750, 'mp7': 750, 'mp5sd': 750, 'm249': 750,
    'galil': 666, 'm4a4': 666, 'aug': 666, 'ump45': 666, 'ak47': 600, 'm4a1s': 600,
    'dual-berettas': 500, 'tec9': 500, 'five-seven': 400, 'p250': 400,
    'usp-0': 352, 'p2000': 352, 'glock': 352, 'scar20': 240, 'g3sg1': 240,
}
TABLE = sorted(set(RPM.values()), reverse=True)
#: Envelope step. 2 ms is an order of magnitude finer than any inter-shot interval.
HOP_S = 0.002
BURST_GAP_S = 0.4


def envelope(audio: np.ndarray, sr: int) -> tuple[np.ndarray, float]:
    """Envelope of energy INCREASE: a shot is an attack, not loudness."""
    x = audio.mean(axis=1) if audio.ndim > 1 else audio
    hop = max(1, int(HOP_S * sr))
    win = hop * 4
    n = max(0, (len(x) - win) // hop)
    energy = np.array([np.sqrt(np.mean(x[i * hop:i * hop + win] ** 2)) for i in range(n)])
    if not len(energy):
        return energy, 1.0 / HOP_S
    return np.maximum(np.diff(energy, prepend=energy[:1]), 0), 1.0 / HOP_S


def period_rpm(segment: np.ndarray, rate: float) -> float | None:
    """Rate from the segment's autocorrelation.

    Normalising by the number of overlapping samples is mandatory: without it the series decays on
    its own and the maximum always lands on a small lag (half the clips came out at 1034 rounds per
    minute). The FIRST high-enough peak is taken, not the global maximum: that one often lands on
    a multiple of the period.
    """
    segment = segment - segment.mean()
    n = len(segment)
    if n < 40:
        return None
    ac = np.correlate(segment, segment, mode='full')[n - 1:] / np.arange(n, 0, -1)
    if ac[0] <= 0:
        return None
    ac = ac / ac[0]
    lo, hi = int(0.065 * rate), min(n - 2, int(0.300 * rate))
    if hi <= lo + 2:
        return None
    peaks = [k for k in range(lo + 1, hi) if ac[k] > ac[k - 1] and ac[k] >= ac[k + 1]]
    if not peaks:
        return None
    top = max(ac[k] for k in peaks)
    for k in peaks:
        if ac[k] >= 0.7 * top:
            return 60.0 / (k / rate)
    return None


def bursts(times: list[float]) -> list[list[float]]:
    out = [[times[0]]]
    for t in times[1:]:
        if t - out[-1][-1] <= BURST_GAP_S:
            out[-1].append(t)
        else:
            out.append([t])
    return out


def main() -> None:
    print(f"{'клип':16s} {'паспорт':>8} {'оценка':>8} {'ближайший':>10}")
    hit = total = 0
    for name, rpm in sorted(RPM.items(), key=lambda x: -x[1]):
        wav = next((p for p in (ROOT / 'examples/.cache').glob(f'{name}-*.wav')), None)
        if wav is None:
            continue
        label = ROOT / f'labels/{wav.stem}.json'
        if not label.exists():
            continue
        payload = json.loads(label.read_text(encoding='utf-8'))
        if not payload.get('complete'):
            continue
        audio, sr = sf.read(str(wav), dtype='float32', always_2d=True)
        env, rate = envelope(audio, sr)
        own = sorted(s['time'] for s in payload['shots'] if s.get('source') == 'own')
        if not own:
            continue

        estimates = []
        for group in bursts(own):
            if len(group) < 4:
                continue
            a = max(0, int((group[0] - 0.05) * rate))
            b = int((group[-1] + 0.05) * rate)
            value = period_rpm(env[a:b], rate)
            if value:
                estimates.append(value)
        if not estimates:
            continue
        estimate = float(np.median(estimates))
        nearest = min(TABLE, key=lambda r: abs(r - estimate))
        total += 1
        hit += nearest == rpm
        print(f'{name:16s} {rpm:8d} {estimate:8.0f} {nearest:10d}'
              + ('' if nearest == rpm else '   <- мимо'))
    print(f'\nугадано {hit} из {total}')


if __name__ == '__main__':
    main()
