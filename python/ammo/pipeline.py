"""Full pass: video -> own shot moments from the ammo counter."""

from __future__ import annotations

from dataclasses import asdict, dataclass

from .align import Alignment, align
from .events import ShotEvents, extract_shots
from .identify import SlotScore, score_series
from .reader import Prototypes, Series, read_slot
from .scan import scan_video

# Below this score a slot does not count as ammo, and the clip is declared uncovered.
# Better to honestly say "no counter" than to pass off a foreign row as shots.
MIN_SLOT_SCORE = 0.6

# Share of events that found an audio candidate nearby. Every own shot makes a sound, so for a
# real counter it is high; for a timer, the score or money it is not.
# The check is free (the candidates are needed for alignment anyway) and does not touch labels.
MIN_SNAP_RATE = 0.60
# With few events the share means nothing: three of them will match anything.
MIN_EVENTS_FOR_SNAP_CHECK = 4


@dataclass
class ClipResult:
    video: str
    covered: bool
    fps: float
    width: int
    height: int
    slot: dict | None
    score: SlotScore | None
    events: ShotEvents | None
    slots_examined: int
    alignment: Alignment | None = None
    rejected: str | None = None
    # Counter readings at CHANGE points: (time, value). Needed for reconciling labels — it shows
    # not "the model thinks there is a shot here" but "the game showed 27, then 24", i.e. direct
    # evidence of the shot count.
    series: list[tuple[float, int]] | None = None
    read_rate: float = 0.0
    # Time spans on which the counter was ACTUALLY read. Without them a quiet stretch (read, but
    # the value did not change) is indistinguishable from a blind one, because `series` holds only
    # change points.
    read_spans: list[tuple[float, float]] | None = None

    def to_json(self) -> dict:
        return {
            'video': self.video,
            'covered': self.covered,
            'fps': self.fps,
            'width': self.width,
            'height': self.height,
            'slot': self.slot,
            'score': asdict(self.score) if self.score else None,
            'shots': self.alignment.times if self.alignment else (self.events.times if self.events else []),
            'shotsVideo': self.events.times if self.events else [],
            'reloads': self.events.reloads if self.events else [],
            'skippedSteps': self.events.skipped if self.events else 0,
            'slotsExamined': self.slots_examined,
            'alignOffset': round(self.alignment.offset, 4) if self.alignment else 0.0,
            'alignSnapped': self.alignment.snapped if self.alignment else 0,
            'alignKept': self.alignment.kept if self.alignment else 0,
            'rejected': self.rejected,
            'series': [[round(t, 3), v] for t, v in (self.series or [])],
            'readRate': round(self.read_rate, 3),
            'readSpans': [[round(a, 3), round(b, 3)] for a, b in (self.read_spans or [])],
        }


def analyze(
    video: str,
    prototypes: Prototypes | None = None,
    start_time: float = 0.0,
    candidates: list[float] | None = None,
) -> ClipResult:
    """Video -> own shot moments.

    `candidates` are the audio candidates of the product stage (`eval/audioCandidates.ts`).
    Without them the moments stay frame-based: ±33 ms precision at 30 fps, and track desync is not
    corrected. Labels take no part in any step here.
    """
    protos = prototypes or Prototypes.load()
    scan = scan_video(video, start_time=start_time)

    best: tuple[float, SlotScore, Series, dict] | None = None
    for slot in scan.slots:
        series = read_slot(protos, slot)
        score = score_series(series, scan.fps)
        if score.score <= 0:
            continue
        where = {
            'x': slot.cx / scan.width,
            'y': slot.cy / scan.height,
            'height': slot.height / scan.height,
            # Share of the SLOT's frames where the number was read in full.
            'readRate': series.read_rate,
            # Share of the CLIP's frames where the slot was present at all. Without it readRate is
            # deceptive: for a clip where the HUD is visible a tenth of the time it is still 99%.
            'presence': len(slot.frames) / max(1, scan.frame_count),
        }
        if best is None or score.score > best[0]:
            best = (score.score, score, series, where)

    if best is None or best[0] < MIN_SLOT_SCORE:
        return ClipResult(
            video=video,
            covered=False,
            fps=scan.fps,
            width=scan.width,
            height=scan.height,
            slot=best[3] if best else None,
            score=best[1] if best else None,
            events=None,
            slots_examined=len(scan.slots),
        )

    _, score, series, where = best
    events = extract_shots(series, scan.fps, scan.start_time)

    # Change points only: between them the value is constant and need not be stored.
    changes: list[tuple[float, int]] = []
    previous: int | None = None
    for frame, value in zip(series.frames.tolist(), series.values.tolist()):
        if value != previous:
            changes.append((scan.start_time + frame / scan.fps, int(value)))
            previous = value

    # Continuous read spans: neighbouring frames are joined, a gap of more than three frames breaks
    # the span. Three — so that a single unreadable frame does not cut a steady stretch.
    spans: list[tuple[float, float]] = []
    for frame in series.frames.tolist():
        t = scan.start_time + frame / scan.fps
        if spans and t - spans[-1][1] <= 3.5 / scan.fps:
            spans[-1] = (spans[-1][0], t)
        else:
            spans.append((t, t))
    alignment = align(events.times, candidates or [])

    # An own shot always makes a sound. If the chosen slot's decrements do not match the audio,
    # it is not ammo but a timer, the score or money — and it is better to declare the clip
    # uncovered than to pass off a foreign row as shots.
    rejected = None
    if candidates and len(events.times) >= MIN_EVENTS_FOR_SNAP_CHECK:
        rate = alignment.snapped / len(events.times)
        if rate < MIN_SNAP_RATE:
            rejected = f'спуски не совпадают со звуком ({rate:.0%} притянуто)'

    return ClipResult(
        video=video,
        covered=rejected is None,
        fps=scan.fps,
        width=scan.width,
        height=scan.height,
        slot=where,
        score=score,
        events=events,
        slots_examined=len(scan.slots),
        alignment=alignment,
        rejected=rejected,
        series=changes,
        read_rate=series.read_rate,
        read_spans=spans,
    )
