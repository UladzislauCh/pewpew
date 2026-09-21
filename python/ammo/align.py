"""Aligning counter moments to audio.

Division of labour: **the counter knows HOW MANY shots there were and in which frame; audio
knows exactly WHEN**. Video cannot be more precise than a frame in principle — ±33 ms at
30 fps — while the product metric uses a ±50 ms tolerance, and sound replacement needs to hit
the shot.

Worse, on some clips the tracks have simply drifted apart. Checked frame by frame on `xm1014`:
the counter changing from 7 to 6 and the muzzle flash sit on the SAME frame (t=1.70), i.e. the
video is self-consistent, while the transient in the waveform is 100 ms later. The same on
`g3sg1` (+119 ms) and `nova` (+149 ms), and in both directions: `scar20` is at -66 ms.

A LIMIT OF THE METHOD worth knowing. The clip-wide offset is reliably determined only where the
fire is sparse. In a burst with a 90-100 ms step the offset is NOT IDENTIFIABLE from audio in
principle: both series are periodic with the same period, and a one-shot shift is
indistinguishable from the truth. Checked on anchors where the answer is known from frames
(flash plus counter): for `m4a4` the true offset is +70 ms, while the estimate from the
probability curve gives +195. So on dense clips the clip-wide offset usually stays zero, and the
per-moment matching does the work — it decides for each moment separately and is not fooled by
periodicity.

Candidates come from `eval/audioCandidates.ts` — the same ShotNet and the same threshold the
product uses. Python has no audio stage of its own and must not have one.

This does NOT use labels: both the counter and the candidates are computed without them.

WHAT WAS TRIED AND REJECTED BY MEASUREMENT (so nobody comes here a second time):

- searching the offset on the probability CURVE instead of candidates: 65.8 against 68.7 recall,
  on sparse clips 54.0 against 58.9. The curve has amplitude, and by reasoning it should be more
  precise, but in dense fire its peaks are frequent and it drifts to the neighbouring shot of
  the burst;
- candidates narrow the choice, the curve picks within: it won on average only because it moved
  clips that provably must not be moved (on m4a4 it gave +195 ms against the frame-proven +70);
- offset from the first shots of bursts only: on the m4a4 anchor it gave +215 ms;
- strict one-to-one counting when fitting the offset, a limit by clip interval and a ban on small
  offsets — together gave 2 clips better and 3 worse.

Outcome: fitting the clip-wide offset stayed as it was, and the whole gain came from the fix to
event PLACEMENT in events.py — the moment on the frame, not between frames.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# How far we search for the clip-wide offset. Measured discrepancies lie within ±170 ms; we take
# a margin, but not so large as to catch the neighbouring shot of a burst.
MAX_OFFSET_S = 0.30
OFFSET_STEP_S = 0.005

# Tolerance at which a moment counts as "explained" by a candidate when fitting the offset.
OFFSET_TOLERANCE_S = 0.040

# Window for pulling a moment to an audio candidate.
#
# 100 ms, and this is not a "frame correction": pulling also works as a FALLBACK offset estimator,
# so the window must cover the desync itself, and on the measured clips it reaches 170 ms.
#
# Why not wider. Candidates are on average 214 ms apart (4808 of them over 1031 seconds), so a
# window over half that distance starts reaching the NEIGHBOURING transient rather than its own.
# 100 ms sits right at that boundary.
#
# Measured: going from 50 to 100 ms is better on 7 clips of 19 and worse on none.
SNAP_WINDOW_S = 0.100


@dataclass(frozen=True)
class Alignment:
    times: list[float]
    offset: float
    snapped: int
    kept: int  # moments for which no candidate was found nearby — left as they are


def _explained(events: np.ndarray, candidates: np.ndarray, offset: float, tolerance: float) -> int:
    """How many moments at a given offset fall within tolerance of any candidate."""
    if not len(events) or not len(candidates):
        return 0
    idx = np.searchsorted(candidates, events + offset)
    best = np.full(len(events), np.inf)
    for shift in (-1, 0):
        j = np.clip(idx + shift, 0, len(candidates) - 1)
        best = np.minimum(best, np.abs(candidates[j] - (events + offset)))
    return int(np.count_nonzero(best <= tolerance))


def estimate_offset(events: np.ndarray, candidates: np.ndarray) -> float:
    """Clip-wide offset of video against audio.

    Fitted on CANDIDATES, not on labels: this is what the product has on a user's clip.

    Zero has priority. With a three-shot clip almost any offset explains something, and without
    this rule alignment would become a coincidence generator.
    """
    if len(events) < 3 or not len(candidates):
        return 0.0

    base = _explained(events, candidates, 0.0, OFFSET_TOLERANCE_S)
    best_offset, best_hits = 0.0, base
    for offset in np.arange(-MAX_OFFSET_S, MAX_OFFSET_S + 1e-9, OFFSET_STEP_S):
        hits = _explained(events, candidates, float(offset), OFFSET_TOLERANCE_S)
        # Strictly greater, and on a tie — closer to zero: otherwise the choice wanders along a plateau.
        if hits > best_hits or (hits == best_hits and abs(offset) < abs(best_offset)):
            best_offset, best_hits = float(offset), hits

    # The offset is applied only if it explains NOTICEABLY more than zero. The threshold is not
    # cosmetic: without it clips with few shots drift off onto noise.
    if best_hits < base + 2 or best_hits < base * 1.2:
        return 0.0
    return best_offset


def align(events: list[float], candidates: list[float]) -> Alignment:
    """Shift the moments by the clip-wide offset and pull each one to its own candidate."""
    if not events:
        return Alignment([], 0.0, 0, 0)

    ev = np.array(sorted(events), dtype=float)
    cand = np.array(sorted(candidates), dtype=float)
    offset = estimate_offset(ev, cand)
    shifted = ev + offset

    if not len(cand):
        return Alignment(shifted.tolist(), offset, 0, len(shifted))

    # Pulling is strictly one-to-one and order-preserving. Without this two shots of a burst would
    # collapse onto one candidate, which is exactly the way of losing recall that eval/README.md
    # warns about.
    used: set[int] = set()
    out: list[float] = []
    snapped = 0
    last = -np.inf
    for t in shifted:
        lo = np.searchsorted(cand, t - SNAP_WINDOW_S)
        hi = np.searchsorted(cand, t + SNAP_WINDOW_S)
        pick, pick_d = -1, np.inf
        for j in range(lo, hi):
            if j in used or cand[j] <= last:
                continue
            d = abs(cand[j] - t)
            if d < pick_d:
                pick, pick_d = j, d
        if pick >= 0:
            used.add(pick)
            last = cand[pick]
            out.append(float(cand[pick]))
            snapped += 1
        else:
            last = max(last, t)
            out.append(float(t))

    return Alignment(sorted(out), offset, snapped, len(out) - snapped)
