#!/usr/bin/env python3
"""
Zero-shot YAMNet scoring of detector candidates.

Reads eval/.candidates.json (from scripts/_exportCandidates.mts), loads each clip's cached WAV,
scores a ~1s window around every candidate with YAMNet, and reports how well AudioSet gunshot-
related classes separate own shots from false alarms — without changing the app.
"""
from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

import numpy as np
import resampy
import soundfile as sf
import tensorflow as tf
import tensorflow_hub as hub

ROOT = Path(__file__).resolve().parents[1]
CANDIDATES_PATH = ROOT / "eval" / ".candidates.json"
YAMNET_DIR = ROOT / "eval" / ".yamnet_model"
TOLERANCE = 0.05

# AudioSet / YAMNet classes that should fire on gunfire or close relatives.
GUNSHOT_LIKE = {
    "Gunshot, gunfire",
    "Cap gun",
    "Fireworks",
    "Explosion",
    "Burst, pop",
    "Fusillade",
    "Machine gun",
    "Artillery fire",
}

WINDOW_SECONDS = 0.975  # YAMNet needs ≥975 ms for one frame
SAMPLE_RATE = 16000


def load_yamnet():
    # Prefer a local saved_model (downloaded once) so we don't hit TF Hub SSL issues.
    if (YAMNET_DIR / "saved_model.pb").exists():
        print(f"loading YAMNet from {YAMNET_DIR}…", flush=True)
        model = hub.load(str(YAMNET_DIR))
        class_map_path = YAMNET_DIR / "assets" / "yamnet_class_map.csv"
    else:
        print("loading YAMNet from TF Hub…", flush=True)
        model = hub.load("https://tfhub.dev/google/yamnet/1")
        class_map_path = Path(model.class_map_path().numpy().decode("utf-8"))
    class_names: list[str] = []
    with open(class_map_path, newline="") as f:
        for row in csv.DictReader(f):
            class_names.append(row["display_name"])
    gun_indices = [i for i, name in enumerate(class_names) if name in GUNSHOT_LIKE]
    found = [class_names[i] for i in gun_indices]
    missing = GUNSHOT_LIKE - set(found)
    print(f"  classes: {len(class_names)}; gunshot-like indices: {gun_indices}")
    print(f"  found: {found}")
    if missing:
        print(f"  missing from map (ignored): {sorted(missing)}")
    return model, class_names, gun_indices


def read_mono_16k(path: Path) -> np.ndarray:
    audio, sr = sf.read(str(path), always_2d=True, dtype="float32")
    mono = audio.mean(axis=1)
    if sr != SAMPLE_RATE:
        mono = resampy.resample(mono, sr, SAMPLE_RATE)
    return mono.astype(np.float32)


def window_around(mono: np.ndarray, time: float) -> np.ndarray:
    center = int(round(time * SAMPLE_RATE))
    half = int(round(WINDOW_SECONDS * SAMPLE_RATE / 2))
    start = center - half
    end = start + int(round(WINDOW_SECONDS * SAMPLE_RATE))
    # Pad with zeros if the window sticks out past the clip.
    length = end - start
    out = np.zeros(length, dtype=np.float32)
    src_start = max(0, start)
    src_end = min(len(mono), end)
    dst_start = src_start - start
    dst_end = dst_start + (src_end - src_start)
    out[dst_start:dst_end] = mono[src_start:src_end]
    return out


def score_window(model, gun_indices: list[int], waveform: np.ndarray) -> dict[str, float]:
    scores, _embeddings, _spec = model(waveform)
    # scores: [frames, 521]; take max over time so a brief crack isn't diluted by surrounding speech.
    frame_scores = scores.numpy()
    mean_scores = frame_scores.mean(axis=0)
    max_scores = frame_scores.max(axis=0)
    gun_mean = float(mean_scores[gun_indices].max()) if gun_indices else 0.0
    gun_max = float(max_scores[gun_indices].max()) if gun_indices else 0.0
    top = int(mean_scores.argmax())
    return {
        "gun_mean": gun_mean,
        "gun_max": gun_max,
        "top_mean": float(mean_scores[top]),
        "top_class": top,
    }


def auc(pos: list[float], neg: list[float]) -> float:
    if not pos or not neg:
        return float("nan")
    wins = 0.0
    for p in pos:
        for n in neg:
            if p > n:
                wins += 1
            elif p == n:
                wins += 0.5
    return wins / (len(pos) * len(neg))


def median(values: list[float]) -> float:
    if not values:
        return float("nan")
    s = sorted(values)
    return s[len(s) // 2]


def f1_at_cut(rows: list[dict], clips: list[dict], score_key: str, cut: float) -> tuple[int, int, int, float, float, float]:
    tp = fp = fn = 0
    by_slug = {c["slug"]: c for c in clips}
    for slug, clip in by_slug.items():
        kept = [r["time"] for r in rows if r["slug"] == slug and r[score_key] >= cut]
        targets = [t["time"] for t in clip["targets"]]
        enemies = [e["time"] for e in clip["enemies"]]
        matched_t = set()
        matched_p = set()
        for pi, pt in enumerate(kept):
            for ti, tt in enumerate(targets):
                if ti in matched_t:
                    continue
                if abs(pt - tt) <= TOLERANCE:
                    matched_t.add(ti)
                    matched_p.add(pi)
                    break
        tp += len(matched_p)
        for pi, pt in enumerate(kept):
            if pi in matched_p:
                continue
            if any(abs(pt - et) <= TOLERANCE for et in enemies):
                continue
            fp += 1
        fn += len(targets) - len(matched_t)
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if precision + recall else 0.0
    return tp, fp, fn, precision, recall, f1


def main() -> int:
    if not CANDIDATES_PATH.exists():
        print(f"missing {CANDIDATES_PATH}; run: pnpm exec tsx scripts/_exportCandidates.mts", file=sys.stderr)
        return 1

    payload = json.loads(CANDIDATES_PATH.read_text())
    clips = payload["clips"]
    model, class_names, gun_indices = load_yamnet()

    rows: list[dict] = []
    for clip in clips:
        mono = read_mono_16k(Path(clip["cacheWav"]))
        print(f"\n{clip['clip'][:50]}  candidates={len(clip['candidates'])}", flush=True)
        for cand in clip["candidates"]:
            waveform = window_around(mono, cand["time"])
            scores = score_window(model, gun_indices, waveform)
            row = {
                "slug": clip["slug"],
                "clip": clip["clip"][:28],
                "time": cand["time"],
                "kind": cand["kind"],
                "weapon": cand["weapon"],
                "gun_mean": scores["gun_mean"],
                "gun_max": scores["gun_max"],
                "top_class": class_names[scores["top_class"]],
                "top_mean": scores["top_mean"],
            }
            rows.append(row)

    own = [r for r in rows if r["kind"] == "own"]
    enemy = [r for r in rows if r["kind"] == "enemy"]
    fp = [r for r in rows if r["kind"] == "fp"]

    print("\n=== YAMNet zero-shot vs candidates (self-sim off) ===")
    print(f"own={len(own)} enemy={len(enemy)} fp={len(fp)}")

    for key in ("gun_mean", "gun_max"):
        print(f"\n{key}:")
        print(f"  med own   {median([r[key] for r in own]):.4f}")
        print(f"  med enemy {median([r[key] for r in enemy]):.4f}")
        print(f"  med fp    {median([r[key] for r in fp]):.4f}")
        print(f"  AUC own>fp    {auc([r[key] for r in own], [r[key] for r in fp]):.3f}")
        print(f"  AUC own>enemy {auc([r[key] for r in own], [r[key] for r in enemy]):.3f}")

    print("\ntop predicted class among own shots:")
    from collections import Counter

    for name, n in Counter(r["top_class"] for r in own).most_common(10):
        print(f"  {n:3d}  {name}")
    print("top predicted class among false alarms:")
    for name, n in Counter(r["top_class"] for r in fp).most_common(10):
        print(f"  {n:3d}  {name}")

    print("\nпорог по gun_max (гейт поверх кандидатов без self-sim):")
    print("  cut      TP   FP   FN      P      R     F1")
    for cut in [0.01, 0.02, 0.05, 0.08, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]:
        tp, fp_n, fn, p, r, f1 = f1_at_cut(rows, clips, "gun_max", cut)
        print(f"  {cut:4.2f}   {tp:3d}  {fp_n:3d}  {fn:3d}  {p*100:5.1f}% {r*100:5.1f}% {f1*100:5.1f}%")

    print("\nпорог по gun_mean:")
    print("  cut      TP   FP   FN      P      R     F1")
    for cut in [0.01, 0.02, 0.05, 0.08, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5]:
        tp, fp_n, fn, p, r, f1 = f1_at_cut(rows, clips, "gun_mean", cut)
        print(f"  {cut:4.2f}   {tp:3d}  {fp_n:3d}  {fn:3d}  {p*100:5.1f}% {r*100:5.1f}% {f1*100:5.1f}%")

    # Weakest own / strongest FP for inspection
    print("\nown с самым низким gun_max:")
    for r in sorted(own, key=lambda x: x["gun_max"])[:8]:
        print(f"  {r['clip']:22s} {r['time']:6.3f}  {str(r['weapon']):8s} gun_max={r['gun_max']:.3f} top={r['top_class']}")
    print("fp с самым высоким gun_max:")
    for r in sorted(fp, key=lambda x: -x["gun_max"])[:8]:
        print(f"  {r['clip']:22s} {r['time']:6.3f}  gun_max={r['gun_max']:.3f} top={r['top_class']}")

    out = ROOT / "eval" / ".yamnet_scores.json"
    out.write_text(json.dumps({"rows": rows}, indent=2))
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    tf.get_logger().setLevel("ERROR")
    raise SystemExit(main())
