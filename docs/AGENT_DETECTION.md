# Shot Detection Agent

## Purpose
Improve the core gunshot detection algorithm. Primary metric: **F1 score**.

Current: **60.0%** (Precision 90%, Recall 49%)  
Target: **70–75%** (3 months)

---

## ⚠️ Prerequisites

**This is specialized work.** Before starting, read:
- [`docs/DETECTION_SKILLSET.md`](DETECTION_SKILLSET.md) — Required knowledge (DSP, gating, fingerprints)
- Study plan: ~8–10 hours (4–5 days)
- Then start labeling + evaluation

**If you skip the skillset:** Changes will be guess-and-check instead of informed hypothesis testing.

---

## Domain & Scope

### Files You Own
```
src/domain/detection/
├─ onsetDetection.ts       # Spectral Flux + HFC Rise
├─ shotDetection.ts        # Peak picking, gating cascade
├─ audioFingerprint.ts     # 42D fingerprint, similarity
├─ shotDetectionFusion.ts  # Audio + Video combo
└─ videoShotVerification.ts # Muzzle flash + recoil scoring
```

### Files You DON'T Touch
- ❌ `src/app/`, `src/pages/`, `src/features/*/components/` — UI Agent
- ❌ `eval/`, `labels/` — Tests Agent
- ❌ `src/shared/i18n/` — UI Agent
- ❌ `vite.config.ts`, `tsconfig.json` — Infrastructure

---

## Core Concepts You Need

### Four Stages of Detection

1. **Onset Curve** (onsetDetection.ts)
   - FFT analysis → Spectral Flux + HFC Rise
   - Output: onsetStrength curve [0,1]

2. **Peak Picking** (shotDetection.ts)
   - Adaptive causal threshold
   - Valley-based state machine
   - Refine to sample-level accuracy

3. **Gating Cascade** (shotDetection.ts)
   - Gate 1: Prominence (6 dB above background)
   - Gate 2: Stereo Width (−15 dB S/M ratio)
   - Gate 3: Self-Similarity (0.97 cosine, largestCluster)

4. **Video Verification** (videoShotVerification.ts)
   - Muzzle flash score (ROI brightness)
   - Recoil score (motion in crosshair)
   - Ownership score (combination)

### Current Parameters (DEFAULT_SHOT_DETECTION_OPTIONS)
```typescript
thresholdMultiplier: 2.5        // Mean + 2.5σ for adaptive threshold
minThreshold: 0.02              // Absolute floor
thresholdWindowSeconds: 1       // Causal window (1 sec history)
valleyRatio: 0.25               // Peak valley ratio for separation
localProminenceDb: 6            // Min dB above background
stereoWidthDb: -15              // Side/Mid ratio gate
selfSimilarityThreshold: 0.97   // Fingerprint cosine similarity
selfSimilarityMode: 'largestCluster'  // Keep biggest cluster
minSeparationSeconds: 0         // Echo merging (disabled)
```

---

## Workflow

### Step 1: Understand the Problem
```bash
# Run evaluation on current code
pnpm eval

# See detailed errors
pnpm eval --verbose

# Check one problem clip
pnpm eval --only "clip-name"
```

Sample output:
```
F1: 60.0%, Precision: 90%, Recall: 49%
Missed (FN): 6 shots at [2.3s, 4.5s, 7.1s, ...]
False positives (FP): 2 at [1.2s, 9.8s]
```

### Step 2: Form Hypothesis
Example hypotheses (from eval/README.md analysis):
- "Lower `localProminenceDb` from 6 to 4 on quiet backgrounds"
- "Add spectral centroid gate for mono microphones"
- "Enable `minSeparationSeconds: 0.05` to merge echoes"
- "Use attack/decay time from fingerprint as additional gate"

### Step 3: Implement
Edit the relevant file (e.g., shotDetection.ts):

```typescript
// Example: Lower prominence threshold
export const DEFAULT_SHOT_DETECTION_OPTIONS: ShotDetectionOptions = {
  ...
  localProminenceDb: 4,  // ← Changed from 6
  ...
}
```

### Step 4: Request Measurement
Tell Tests Agent: "Please run `pnpm eval` after my changes"

Tests Agent will report:
```
F1: 60.0% → 62.1% ✓
Precision: 90% → 89% (OK)
Recall: 49% → 52% (good)
```

### Step 5: Commit
If F1 improved:
```bash
git commit -m "fix: lower prominence threshold for quiet shots

- Reduced localProminenceDb from 6 to 4 dB
- Helps detect quiet shots on low-noise background
- F1 improved: 60.0% → 62.1% on 10-clip set
- Precision cost: 90% → 89% (acceptable)
- Eval: Full suite passing, no regression on other clips"
```

If F1 regressed:
```bash
git checkout src/domain/detection/shotDetection.ts
# Try next hypothesis
```

---

## Common Hypotheses to Test

### High-Confidence (from eval/README analysis)

| Hypothesis | Why | Expected Impact | Effort |
|-----------|-----|-----------------|--------|
| Adaptive prominence on quiet BG | Many FN on silent sections | +1–2% F1 | Low |
| Spectral gate for mono mics | Mono doesn't have stereo gate | +2–3% F1 | Medium |
| Attack/decay time gate | Already in fingerprint | +1–2% F1 | Low |
| Echo merging (minSeparation) | Duplicates from ricochet | +0.5–1% F1 | Low |

### Medium-Confidence (new data might reveal)

| Hypothesis | Why | Expected Impact |
|-----------|-----|-----------------|
| Spectral flatness threshold | Music has different character | +1–2% F1 |
| Adaptive stereoWidthDb | Mono vs stereo tradeoff | +1–2% F1 |
| Centroid-based discrimination | Gunshots vs voice/music | +0.5–1% F1 |

### Low-Confidence (already tested, didn't work)

❌ Matching weapon templates (F1 51% vs 60%)  
❌ YAMNet zero-shot (AUC 0.436, worse than random)  
❌ RPM cadence detection (hurt recall)  
❌ Logistic regression (overfit on 5 clips)  

---

## How to Debug

### "Why was this shot missed?"

1. Get timestamp from eval: `FN at 3.45s`
2. Examine audio at that time:
   ```python
   # In your head or with analysis
   - What's the audio level compared to background?
   - Is it stereo or mono?
   - Does it look similar to nearby shots?
   ```
3. Which gate rejected it?
   - Prominence: < 6 dB above background
   - Stereo: < −15 dB S/M ratio
   - Self-similarity: unique fingerprint

4. Hypothesis: "Lower prominence to 4 dB"
5. Test & measure

### "Why was this false positive detected?"

1. Get timestamp: `FP at 1.23s`
2. What was it? (from eval --verbose: "music bleed", "voice", "explosion", "UI sound")
3. Which gate failed?
   - Passed prominence (loud enough)
   - Passed stereo (wide enough)
   - Passed self-similarity (matched cluster)
4. Add targeted gate?
   - Spectral shape check
   - Centroid threshold
   - Max duration check

---

## Testing Your Changes

### Before committing:

1. **Local eval:**
   ```bash
   pnpm eval
   # Compare F1 with baseline (should see improvement)
   ```

2. **Detailed analysis:**
   ```bash
   pnpm eval --verbose
   # Check that FN/FP patterns improved as expected
   ```

3. **Regression check:**
   ```bash
   pnpm eval --fail-on-regression
   # Should exit with code 0 if F1 didn't drop
   ```

4. **Specific clip:**
   ```bash
   pnpm eval --only "problematic-clip"
   # Deep dive on one clip where your hypothesis should help
   ```

---

## Constants Reference

From `src/domain/detection/shotDetection.ts`:

| Constant | Purpose |
|----------|---------|
| `DEFAULT_SHOT_DETECTION_OPTIONS` | Current best params (60% F1) |
| `RECALL_AUDIO_SHOT_DETECTION_OPTIONS` | High recall, many FP (50% precision) |
| `PRECISION_AUDIO_SHOT_DETECTION_OPTIONS` | Strict mode (95% precision, low recall) |

---

## Communication with Tests Agent

**You → Tests:**
```
"Run eval after I lowered prominence threshold.
File: src/domain/detection/shotDetection.ts line 110
Expected: +1-2% F1 on quiet shots"
```

**Tests → You:**
```
"Eval results:
- F1: 60.0% → 62.1% ✓
- Precision: 90% → 89%
- Recall: 49% → 52%
- No regression on other 4 baseline clips
Ready to commit!"
```

---

## Milestones (3 Months)

| Week | Clips | F1 Target | Focus |
|------|-------|-----------|-------|
| 2 | 5 | ~60% | Analyze first errors |
| 4 | 10 | ~61% | Hypothesis 1-2 |
| 6 | 10 | ~63% | Hypothesis 3-4 |
| 8 | 20 | ~64% | New data, adapt |
| 10 | 30 | ~67% | Final tuning |
| 12 | 30 | ~71% | Production ready |

---

## Success = ?

### Each Sprint (typically 1-2 weeks)
- [ ] Analyzed eval output (`pnpm eval --verbose`)
- [ ] Identified 1-2 hypotheses from error patterns
- [ ] Implemented hypothesis (code change)
- [ ] Tests Agent measured impact
- [ ] Committed with before/after metrics
- [ ] F1 improved by 0.5-3% (or learn why it didn't)

### By Week 12
- [ ] F1 ≥ 70% on all 30+ clips
- [ ] Precision ≥ 85%
- [ ] Recall ≥ 55-60%
- [ ] Every improvement documented in commit
- [ ] Ready for production deployment

---

## Questions?

Refer to:
- Full analysis: `docs/shot-detection/shot_detection_mechanics.md` (your context)
- eval/README.md: Why each improvement worked/didn't
- CLAUDE.md: How to coordinate with other agents

When stuck: ask Main (Claude) to clarify scope.
