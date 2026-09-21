"""A pass over the clip: where the numbers sit on screen and how they changed.

The pass produces "slots". A slot is a stable position of a number on screen: ammo, health,
armour, reserve ammo, round timer, score. A slot holds, per frame, the glyphs that stood there.

Identifying the ammo among the slots is NOT done here — it is in identify.py and relies on the
behaviour of the values, not on position. Position cannot be a constant: there are at least
three layouts (native HUD, tournament broadcast, cropped framing).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

from .glyphs import Glyph, Group, find_glyphs, group_glyphs, to_ink


@dataclass
class Slot:
    """A stable position of a number on screen and its glyphs per frame."""

    cx: float
    cy: float
    height: float
    frames: list[int] = field(default_factory=list)
    glyphs: list[tuple[Glyph, ...]] = field(default_factory=list)

    def add(self, frame: int, group: Group) -> None:
        n = len(self.frames)
        # Running average of the position: the HUD stays put, but the number's box wanders by a pixel
        # when the digit count changes (16 -> 9), and the anchor must move with it.
        self.cx = (self.cx * n + group.cx) / (n + 1)
        self.cy = (self.cy * n + group.cy) / (n + 1)
        self.height = (self.height * n + (group.bottom - group.y)) / (n + 1)
        self.frames.append(frame)
        self.glyphs.append(group.glyphs)

    def matches(self, group: Group) -> bool:
        tol = max(0.6 * self.height, 6.0)
        if abs(group.cy - self.cy) > tol:
            return False
        # Horizontal tolerance is wider: the number grows left or right depending on alignment,
        # and the centre shifts by half a digit.
        if abs(group.cx - self.cx) > max(1.5 * self.height, 12.0):
            return False
        return abs((group.bottom - group.y) - self.height) <= 0.35 * self.height


@dataclass
class ScanResult:
    slots: list[Slot]
    frame_count: int
    fps: float
    width: int
    height: int
    # Time of the first frame from the container. OpenCV ignores it and computes time as
    # index/fps, while in the set's clips the video track starts one frame after the audio.
    # Measured separately with mediabunny: see eval/videoStart.ts.
    start_time: float = 0.0

    def time_of(self, frame: float) -> float:
        return self.start_time + frame / self.fps


def scan_video(
    path: str,
    max_frames: int | None = None,
    stride: int = 1,
    start_time: float = 0.0,
) -> ScanResult:
    """One pass over the video: glyphs, groups, slots.

    `stride` skips frames — fine for cheap exploration, but NOT for counting shots: ammo decreases
    by one per frame, and skipping a frame loses a shot.
    """
    capture = cv2.VideoCapture(path)
    if not capture.isOpened():
        raise RuntimeError(f'Видео не открылось: {path}')

    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))

    slots: list[Slot] = []
    index = 0
    seen = 0

    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            if max_frames is not None and seen >= max_frames:
                break
            if index % stride == 0:
                gray = to_ink(frame)
                taken: set[int] = set()
                for group in group_glyphs(find_glyphs(gray)):
                    # The nearest matching slot, not the first one found, and no more than one
                    # group per slot per frame: otherwise neighbouring captions merge into one slot
                    # and it gathers more entries than the clip has frames.
                    best, best_d = -1, float('inf')
                    for i, slot in enumerate(slots):
                        if i in taken or not slot.matches(group):
                            continue
                        d = abs(group.cx - slot.cx) + abs(group.cy - slot.cy)
                        if d < best_d:
                            best, best_d = i, d
                    if best >= 0:
                        slots[best].add(index, group)
                        taken.add(best)
                    else:
                        slot = Slot(group.cx, group.cy, group.bottom - group.y)
                        slot.add(index, group)
                        slots.append(slot)
                        taken.add(len(slots) - 1)
                seen += 1
            index += 1
    finally:
        capture.release()

    # A slot that flickered in a couple of frames is scenery or an editing caption, not a HUD reading.
    min_life = max(8, int(0.1 * seen))
    slots = [s for s in slots if len(s.frames) >= min_life]
    slots.sort(key=lambda s: -len(s.frames))

    return ScanResult(
        slots=slots, frame_count=index, fps=fps, width=width, height=height, start_time=start_time
    )


def normalize_glyph(glyph: Glyph, size: tuple[int, int] = (16, 24)) -> np.ndarray:
    """Glyph into a fixed box — to compare across frames and across clips.

    Nearest neighbour, not smoothing: the mask is binary, and half-tones on its edge only blur the
    difference between similar digits.
    """
    return cv2.resize(glyph.mask, size, interpolation=cv2.INTER_NEAREST).astype(np.uint8)
