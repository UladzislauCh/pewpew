# Detection Agent Skillset & Knowledge Base

Before diving into improvements, Detection Agent needs to understand these concepts deeply.

---

## Required Knowledge

### 1. Digital Signal Processing (DSP) Basics
**Why:** Gunshot detection is pure DSP — understand what you're optimizing.

**Must Know:**
- FFT: Converts time-domain audio → frequency-domain spectrum
  - Window size (1024) = frequency resolution
  - Hop size (256) = time resolution
  - Trade-off: bigger window = better frequency detail, worse time precision
  
- Spectral Flux: Change in spectrum frame-to-frame
  - Detects ANY broadband energy increase
  - Good for: finding transients
  - Problem: loud music also spikes

- HFC (High Frequency Content): Energy weighted by frequency
  - `HFC = Σ magnitude[k] * (k+1)`
  - High frequencies weighted more than low
  - Detects sharp "crack" (attack phase)

- HFC Rise (KEY INSIGHT): Only positive delta
  - `rise[i] = max(0, HFC[i] - HFC[i-1])`
  - Separates individual shots in burst (recall 52% → 63%)
  - Without this: whole burst = one peak

**Read:**
- `src/domain/detection/onsetDetection.ts` lines 49–60 (comments explain it well)
- `eval/README.md` "What worked" (in "What has already been measured") for why HFC Rise matters

---

### 2. Gating & Filtering (The Cascade)

**Gate 1: Prominence (dB above background)**
```
What:     20·log10(peak_amplitude / background_rms)
Why:      Distinguishes real shots (loud) from noise (quiet)
Current:  6 dB threshold
Problem:  Tightest gate, loses quiet shots
Tune:     Lowering helps quiet, raises FP on music
```

**Gate 2: Stereo Width (Side/Mid energy ratio)**
```
What:     10·log10(side_energy / mid_energy)
Why:      Gunshots are spatially wide; voice/music is mono
Current:  −15 dB threshold
Stats:    Shots ~−13dB, FP ~−19dB (AUC 0.741 — best single gate!)
Problem:  Fails on mono mics (15% of clips)
Tune:     Adding spectral gate for mono cases
```

**Gate 3: Self-Similarity (Fingerprint Clustering)**
```
What:     42D spectral fingerprint, cosine similarity ≥ 0.97
Why:      Shots from same gun = near-identical copies
Current:  largestCluster mode (keep biggest group)
Stats:    Own gun = tight cluster; enemy/music = scattered
Problem:  Cuts recall if cluster is small (rare burst)
Tune:     Different modes for different game types
```

**Read:**
- `src/domain/detection/shotDetection.ts` lines 25–97 (parameter comments)
- `src/domain/detection/audioFingerprint.ts` lines 3–16 (fingerprint layout)

---

### 3. Fingerprint & Similarity

**42-Dimensional Vector:**
```
Layout:
├─ 4 time windows (around shot peak)
│  └─ Each: 8 band ratios + centroid + flatness = 10 features
│     = 40 numbers
└─ 2 global: attackTime, decayTime
  = 42 total
```

**Why it works:**
- Spectral shape (band ratios): characterizes timbral quality
- Centroid: "center of mass" in frequency (voice higher than gunshot)
- Flatness: Gaussian-like (flat = noise, peaky = tone)
- Attack/Decay: temporal envelope (gunshot sharp, explosion slow)

**Cosine Similarity:**
```
similarity = dot(a,b) / (norm(a) * norm(b))
Range:     0 (nothing alike) → 1 (identical)
Typical:   Own shots ~0.97, music ~0.1
Threshold: 0.97 = very strict (almost perfect match)
```

**Read:**
- `src/domain/detection/audioFingerprint.ts` lines 65–105 (frame features)
- `src/domain/detection/audioFingerprint.ts` lines 172–184 (similarity)

---

### 4. Video Verification (Secondary)

**Muzzle Flash:**
```
ROI:     Lower-center of frame (weapon area)
Signal:  Luminance rise when weapon fires
Typical: +0.08–0.35 luma increase
Noise:   < 0.035 (UI blinks, compression)
Score:   min(1, rise / 0.16)
```

**Recoil (Camera Kick):**
```
ROI:     Center crosshair area
Signal:  Pixel changes from weapon recoil
Typical: 0.02–0.04 mean abs difference
Noise:   Mouse look, walking (similar magnitude)
Score:   min(1, diff / 0.1)
```

**Ownership:**
```
Formula:     0.75·flash + 0.25·recoil + bonus
Requirement: flash ≥ 0.28, combined ≥ 0.40
Why:         Flash is primary (own shots light weapon)
             Recoil is backup (camera motion isn't sufficient)
```

**Read:**
- `src/domain/detection/videoShotVerification.ts` lines 87–125
- `src/domain/video/videoFrameMetrics.ts` lines 90–116

---

## Practical Skills

### Skill 1: Reading Eval Output

**Run:**
```bash
pnpm eval --verbose
```

**Output format:**
```
=== clip1.mp4 ===
Ground truth: 24 shots @ [0.5s, 0.8s, 1.2s, ...]
Detected:     18 shots @ [0.48s, 0.9s, 1.2s, ...]

Missed (FN): 6
  - 0.7s (why missed?)
  - 1.5s (why missed?)

False positives (FP): 2
  - 2.3s (what was it?)
  - 4.1s (what was it?)

Metrics:
  Precision: 18/(18+2) = 90%
  Recall:    18/(18+6) = 75%
  F1:        2*90*75/(90+75) = 81%
```

**What to look for:**
1. **FN pattern:** All quiet shots? After loud events? Mono mics?
2. **FP pattern:** Music? Voice? Explosions? Echoes?
3. **Which gate:** Prominence (6dB check)? Stereo (−15dB)? Self-sim?

### Skill 2: Hypothesis Formation

**Decision tree:**

```
Looking at eval results...

Many FN on quiet shots (< 5 dB above BG)?
├─ Yes → Hypothesis: Lower localProminenceDb (6 → 4)
└─ No → Next

Many FP on mono audio or voice?
├─ Yes → Hypothesis: Add spectral gate for mono
└─ No → Next

FP on ~100ms echoes/ricochet?
├─ Yes → Hypothesis: Enable minSeparationSeconds (0 → 0.05)
└─ No → Next

Pattern unclear? Varied errors?
└─ Need more clips to see pattern (Tests Agent: label 5 more)
```

### Skill 3: Interpreting Failure

**If F1 regressed after change:**

```
Scenario 1: Precision dropped (more FP)
├─ Gate too loose (threshold lowered)
├─ Example: localProminenceDb 6 → 4 increased FP on music
├─ Fix: Revert or add secondary gate

Scenario 2: Recall dropped (more FN)
├─ Gate too strict (threshold raised)
├─ Example: stereoWidthDb −15 → −17 lost mono shots
├─ Fix: Revert or combine with alternative gate

Scenario 3: No change (F1 flat)
├─ Hypothesis was wrong or insufficient data
├─ Action: Try next hypothesis, or ask for more clips
```

### Skill 4: Parameter Tuning

**When to adjust each parameter:**

| Parameter | Tune if | Direction | Risk |
|-----------|---------|-----------|------|
| `localProminenceDb` | Many FN quiet | Lower (6→4) | ↑ FP on music |
| `stereoWidthDb` | Many FP mono | Lower (−15→−20) | ↑ FN no gate |
| `minSeparationSeconds` | Echo FP | Increase (0→0.05) | ↑ FN fast bursts |
| `selfSimilarityThreshold` | Lose rare shots | Lower (0.97→0.95) | ↑ FP trash |
| `thresholdMultiplier` | Need gentler adapt | Lower (2.5→2.0) | ↑ FP on noise |

**Rule:** One parameter per hypothesis. Measure. Lock in if helps.

---

## Reference Materials (In This Repo)

**Must Read Before Starting:**
1. ✅ `CLAUDE.md` — Overall workflow
2. ✅ `docs/AGENT_DETECTION.md` — Your job description
3. ✅ `eval/README.md` — Why each optimization worked
4. ⭐ `docs/shot-detection/shot_detection_mechanics.md` — Deep dive (you created this)

**Code References:**
- `src/domain/detection/onsetDetection.ts:58–125` — Onset curve generation
- `src/domain/detection/shotDetection.ts:160–189` — Adaptive threshold
- `src/domain/detection/shotDetection.ts:268–303` — Peak picking
- `src/domain/detection/audioFingerprint.ts:145–195` — Fingerprint computation
- `src/domain/detection/shotDetection.ts:419–454` — Self-similarity filtering

**Test Cases (to understand edge cases):**
- `eval/synthetic.test.ts` — Controlled scenarios
- `eval/detectionMetrics.ts` — How F1 is calculated
- `labels/*.json` — Real examples (look at timestamps)

---

## Decision Support: When to Call Main (Claude)

**Call Main if:**

- ❓ Eval results don't make sense (e.g., F1 0% on good clips)
- ❓ Unsure which hypothesis to test next
- ❓ Parameter change broke something unexpected
- ❓ Want second opinion on interpretation
- ❓ Need help writing code for complex hypothesis

**Don't call Main if:**
- ✅ F1 changed predictably (you understand why)
- ✅ Next hypothesis is obvious from error table
- ✅ Code is simple parameter adjustment

---

## Your Study Plan (Before Week 1 Labeling)

### Day 1 (2–3 hours)
- [ ] Read: CLAUDE.md
- [ ] Read: This file (DETECTION_SKILLSET.md)
- [ ] Read: docs/AGENT_DETECTION.md

### Day 2 (2–3 hours)
- [ ] Read: eval/README.md (focus: "What worked")
- [ ] Read: docs/shot-detection/shot_detection_mechanics.md (4 stages)
- [ ] Skim: src/domain/detection/shotDetection.ts (understand parameter locations)

### Day 3 (1–2 hours)
- [ ] Run: `pnpm eval` (understand output format)
- [ ] Look at: `labels/ak47-dbf13655.json` (example ground truth)
- [ ] Look at: eval error table in README (what was analyzed)

### Day 4–5
- [ ] Hands-on: Download clips, start labeling
- [ ] First eval run
- [ ] Identify hypotheses from errors

---

## Quick Reference: Key Constants

```typescript
// src/domain/detection/shotDetection.ts:104–120

DEFAULT_SHOT_DETECTION_OPTIONS = {
  thresholdMultiplier: 2.5,          // Adaptive threshold: mean + 2.5σ
  minThreshold: 0.02,                // Floor (no gate at this)
  thresholdWindowSeconds: 1,         // Causal window = 1 sec history
  valleyRatio: 0.25,                 // Peak valley = 25% of peak
  localProminenceDb: 6,              // ← Most likely to tune (quiet shots)
  backgroundWindowSeconds: 0.5,      // Median RMS window
  stereoWidthDb: -15,                // ← Second priority (mono shots)
  selfSimilarityThreshold: 0.97,     // Fingerprint match threshold
  selfSimilarityMode: 'largestCluster', // Keep biggest cluster
  minSeparationSeconds: 0,           // ← Third priority (echo merging)
}
```

---

## Gotchas & Misconceptions

### ❌ "Lower threshold = better detection"
**Wrong.** Lower threshold catches more but also more garbage.
**Right:** Each gate serves a purpose; lower = more false positives elsewhere.

### ❌ "Fingerprint matching will solve everything"
**Wrong.** On labeled set, self-similarity (0.97) beats weapon templates (51% F1).
**Right:** Fingerprints are for within-clip clustering, not template matching.

### ❌ "FFT gives frequency content, why not filter by it?"
**Wrong.** Gunshots and voice both have wide spectra; spectral weighting underperformed.
**Right:** Use spectral features (centroid, flatness) but not for primary detection.

### ❌ "Video verification can replace audio gates"
**Wrong.** Video only available on POV; many clips third-person or spectator.
**Right:** Video is backup. Audio gates are primary.

---

## Success Indicators

**After finishing this skillset:**
- ✅ Understand why HFC Rise matters (recall 52%→63%)
- ✅ Can explain all 3 gates (Prominence, Stereo, Self-Sim)
- ✅ Can read eval output and spot patterns
- ✅ Can guess which parameter to tune from error table
- ✅ Understand trade-offs (F1 vs Precision vs Recall)

---

## Questions to Test Your Understanding

**Test yourself before starting:**

1. Why is `minThreshold = 0.02` needed even if we have `mean + 2.5σ`?
   - Answer: In silent sections, σ→0, threshold→0, noise triggers

2. What's the difference between Spectral Flux and HFC Rise?
   - Answer: Flux = raw change; HFC Rise = only positive change in high freq (separates shots in burst)

3. Why does stereo-width gate fail on mono?
   - Answer: mono = L=R, so side=(L-R)/2=0, ratio undefined/zero

4. If you lower localProminenceDb from 6 to 4, what happens?
   - Answer: More FN caught (good); more FP on music/explosion (cost); net if +F1 then keep

5. When would you NOT want largestCluster mode?
   - Answer: Multi-weapon scene (want all clusters); or rare single burst (main cluster too small)

**If stuck on any:** Read the reference sections above.

---

## Time Investment

**Before you touch code:**
- Study plan: 8–10 hours (spread over 4–5 days)
- Hands-on labeling: 2–3 hours (first 5 clips)
- First analysis: 1–2 hours (eval, hypothesis)

**Total before first code change:** ~12 hours

**Payoff:** First hypothesis changes will be confident, measured, and likely successful.

---

**You're ready when you can:**
1. ✅ Explain the 4 detection stages (onset → picking → gating → video)
2. ✅ Run `pnpm eval --verbose` and understand the output
3. ✅ Create error table and spot patterns
4. ✅ Propose 2–3 hypotheses with reasoning
5. ✅ Change a parameter, measure impact, understand trade-off

**Next step:** Start the study plan. Questions? Ask Main (Claude).
