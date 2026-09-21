# Shot detection mechanics: full overview

## TL;DR: 30 seconds

The system uses a **three-stage pipeline**:

1. **Onset Detection** (onsetDetection.ts): FFT analysis of the audio → two independent measures (Spectral Flux, HFC Rise) → onsetStrength curve [0,1]

2. **Peak Picking & Gating** (shotDetection.ts): 
   - Adaptive threshold (1 s causal window, mean + 2.5σ)
   - Peak extraction by valleys (valley-based, not a refractory period)
   - Sample-level refinement (±5 ms window)
   - Filter cascade: Prominence (6 dB) → Stereo Width (−15 dB) → Self-Similarity (0.97 cosine)

3. **Video Verification** (videoShotVerification.ts): Checking muzzle flash + recoil (optional)

**Result**: F1 ≈ 60% on the labeled set, ~114 corrections on ~200 shots.

---

## Detection architecture

```
Audio File (MP4/WebM)
    ↓
[Decode] → Mono AudioBuffer
    ↓
[Onset Curve]
  ├─ Spectral Flux: Σ max(0, mag[k]_i - mag[k]_i-1)
  └─ HFC Rise: max(0, HFC[i] - HFC[i-1]), where HFC = Σ mag[k]·(k+1)
    ↓
[Adaptive Local Threshold]
  per-frame: max(0.02, mean_past + 2.5·σ_past) / 1-sec causal window
    ↓
[Peak Picking: Valley-based State Machine]
  armed = false
  → when value > threshold: arm, track peak
  → when value < peak·0.25: emit peak, disarm
    ↓
[Sample-level Refinement]
  ±5 ms window around each peak → exact sample (±1 ms)
    ↓
[Gating Cascade]
  1. Prominence Gate: 20log10(peak/background) ≥ 6 dB  → ~60% pass
  2. Stereo Width Gate: Side/Mid ≥ −15 dB              → ~92% pass
  3. Self-Similarity Gate: 42D fingerprint cosine ≥ 0.97, largestCluster → ~70% pass
    ↓
[Merge Close] → audio_detected: DetectedShot[]
    ↓
[Optional Video Verification]
  ├─ scoreMuzzleFlash() → viewmodel ROI luminance rise
  ├─ scoreRecoil() → crosshair ROI motion
  └─ combineOwnershipScores() → ownership_verified: DetectedShot[]
```

---

## Key innovations

### 1. HFC Rise instead of raw HFC
**Problem**: Raw HFC stays high for the whole burst → the entire burst becomes one peak  
**Solution**: `hfcRise[i] = max(0, HFC[i] - HFC[i-1])` → each shot is caught separately  
**Effect**: Recall 52% → 63%, especially on bursts

### 2. Causal adaptive local threshold
**Problem**: One threshold level per clip: loud music raises the bar for the whole remainder  
**Solution**: For each frame `i`: `threshold = max(0.02, mean[i-window:i] + 2.5·σ[i-window:i])`  
**Effect**: Quiet shooting is caught after an explosion/music

### 3. Valley-based peak picking instead of a refractory period
**Problem**: A burst has ~100 ms between shots; a refractory period either misses shots or merges them  
**Solution**: A state machine with valleys (value < peak·0.25) → adapts to the fire rate  
**Effect**: Slow shots, fast bursts — one rule

### 4. Stereo width — the best single feature
**Discovery**: Shots are wide (Side/Mid ≈ −13 dB), junk is mono (−19 dB)  
**Effect**: AUC 0.741 for own>fp classification  
**Problem**: Mono microphones (e.g. mobile video) do not work

### 5. Fingerprint self-similarity for clustering
**Idea**: Shots from one weapon in one clip are near-identical copies (one game sample in CS2)  
**Implementation**: 42D fingerprint (spectral bands, centroid, flatness, attack/decay times)  
**largestCluster mode**: Keep only the largest cluster (own weapon), drop enemies and junk  
**Effect**: F1 ~60% vs ~52% for matching against a template library

### 6. Video verification via muzzle flash and recoil
**Flash ROI**: Bottom-centre of the frame (36% of the width) → brightness measure  
**Recoil ROI**: Crosshair centre (24% of the width) → motion measure  
**Ownership**: `0.75·flash + 0.25·recoil + bonus` when flash ≥ 0.28  
**Effect**: The final filter, tells own shots from others'

---

## Default parameters (DEFAULT_SHOT_DETECTION_OPTIONS)

**Optimised for**: `min(FP + FN)` for own shots on the labeled set

| Parameter | Value | Purpose |
|----------|----------|-----------|
| `thresholdMultiplier` | 2.5 | σ multiplier of the adaptive threshold |
| `minThreshold` | 0.02 | Absolute threshold floor |
| `thresholdWindowSeconds` | 1 | Causal window (1 s of history) |
| `valleyRatio` | 0.25 | Valley = peak * 0.25 (separating shots) |
| `localProminenceDb` | 6 | Minimum above the local background (dB) |
| `backgroundWindowSeconds` | 0.5 | Window for the background RMS median |
| `stereoWidthDb` | −15 | Side/Mid gate (shots −13, junk −19) |
| `selfSimilarityThreshold` | 0.97 | Cosine similarity for the cluster |
| `selfSimilarityMinNeighbors` | 2 | Not used in largestCluster mode |
| `selfSimilarityMode` | 'largestCluster' | Mode: largestCluster or neighbors |
| `selfSimilarityWhenNoCluster` | 'keep' | No cluster: keep (protects single shots) or drop |
| `minSeparationSeconds` | 0 | Merging close ones (usually 0) |
| `matchWeaponTemplates` | true | Informational hint for the UI |

**Results**:
- Precision ≈ 90%
- Recall ≈ 49%
- F1 ≈ 60%
- **Corrections ≈ 114** on ~200 shots (vs ~330 in recall-first mode)

---

## Filtering along the path (Gating Cascade)

### Stage 1: Prominence Gate (6 dB)
```
background = median(RMS) in a ±0.5 s window
prominenceDb = 20 * log10(peak / background)
PASS: prominenceDb >= 6 dB
```
**Approximate result**: 100% of candidates → 60% pass  
**Filtered out**: Noise, low background sounds

### Stage 2: Stereo Width Gate (−15 dB)
```
widthDb = 10 * log10(side_energy / mid_energy)
PASS: widthDb >= −15 dB
```
**Approximate result**: 60% → 55% (8% more filtered out)  
**Filtered out**: Mono voice, music, UI sounds

### Stage 3: Self-Similarity (0.97 cosine)
```
fingerprint = 42D vector of spectral + temporal features
for each pair: cosine_similarity >= 0.97 → edge in the graph
connected components → keep largestCluster
```
**Approximate result**: 55% → 40% (another 15%)  
**Filtered out**: Unique noise events, enemies in small clusters

### Final result
**Audio detection without video**: ~40–50% of candidates remain  
**+ Video verification**: ~30–40% after the flash gate  
**But F1 ≈ 60%** thanks to high precision

---

## Training and evaluation

### Infrastructure

**Synthetic tests** (`eval/*.test.ts`):
- Controlled impulses + noise/music/explosions
- Test specific hypotheses

**Real clips** (local):
- Labels: `labels/*.json` (committed)
- Audio: `examples/.cache/*.wav` (32-bit float, committed)
- Video: `examples/*.mp4` (copyrighted, not committed)

### What is measured

- **Matching**: one-to-one by time (not greedy "nearest")
- **Tolerances**: ±50 ms (MIREX), ±25 ms (strict)
- **Metrics**: Precision, Recall, F1
- **Median |Δt|**: timing accuracy (for sound replacement)
- **Recall on the `hard` category**: noisy shots separately

### Commands

```bash
npm test                              # synthetic
npm run eval                          # per-clip table
npm run eval -- --verbose             # with error timecodes
npm run eval -- --only <slug>         # one clip
npm run eval -- --update-baseline     # pin the current numbers
npm run eval -- --fail-on-regression  # non-zero exit code
```

---

## What did not work (rejected on the labeled set)

Checked, not worth trying without new data:

- **Local MAD normalisation**: the z-score blew up, 1031 false positives
- **Subtracting a running median from the curve**: F1 34.8% vs 36.4%
- **Centred (non-causal) window for mean+kσ**: the peak inflates σ and blocks events
- **Log compression / band-limited flux**: false positives brighter than shots, emphasising high frequencies amplifies junk
- **Mid-frequency weighting (300–2000 Hz)**: spectral shape is useful for scoring, not for search
- **Refractory period instead of valleys**: F1 40% vs 48%
- **Logistic regression on spectral features**: overfitting (45.6% vs 44.4%)
- **Matching against a template library as a gate**: F1 51% vs 60% (dry samples are far from compressed game footage)
- **YAMNet zero-shot (AudioSet gunshot classes)**: AUC 0.436 (worse than random), CS2 POV is out of distribution

---

## Known limitations

### Low recall (~49%)

Remaining FN (false negatives):
- Quiet/buried shots (< 6 dB above the background)
- Video verification may rescue them if there is a visual signal

### Precision depends on stereo

- Mono microphones (mobile video, streaming) → the stereo gate does not work
- Alternative gates for mono are needed (e.g. spectral shape, but it is worse)

### Dependence on game samples

- Fingerprint self-similarity works thanks to CS2 (one sample per burst)
- Other games with more random sounds → it may not work

### Video verification requires POV

- Flash and recoil are visible only in POV clips
- Spectator/third-person cameras do not see these signals
- Good lighting is required (bright flashes, contrasting backgrounds)

---

## File layout

```
src/domain/detection/
├─ onsetDetection.ts              # Spectral Flux + HFC Rise
├─ shotDetection.ts               # Peak picking + gating cascade
├─ audioFingerprint.ts            # 42D fingerprint, cosine similarity
├─ shotDetectionFusion.ts         # Combining audio + video
├─ videoShotVerification.ts       # Verification by video
├─ weaponTemplates.ts             # Weapon template matching
└─ detectionMetrics.ts            # TP/FP/FN matching

src/domain/video/
├─ videoFrameMetrics.ts           # Flash/recoil scoring
├─ videoRegions.ts                # ROI coordinates
└─ mediaAnalysis.ts               # MP4 decoding

eval/
├─ *.test.ts                      # Synthetic tests
├─ evaluate.ts                    # Evaluation framework
├─ run.ts                         # Main eval script
└─ fixtures.ts                    # Test data

labels/                           # Ground-truth labels (JSON)
examples/                         # Video clips + audio cache (WAV)
weapon-samples/                   # Dry CS2 assets
```

---

## Recommendations for extension

### Add a new gate

```typescript
// shotDetection.ts, in the detectShots() loop
const myFeature = computeMyFeature(mono, time)
if (myFeature < MY_THRESHOLD) continue  // DROPPED
shots.push({ ..., myFeature })
```

### Change the profile for a specific case

```typescript
export const MY_PROFILE = {
  ...DEFAULT_SHOT_DETECTION_OPTIONS,
  localProminenceDb: 8,  // Stricter
  stereoWidthDb: -17,    // Stricter
  selfSimilarityThreshold: 0.95,  // Looser clustering
}
```

### Test on synthetic data

```bash
# Add to eval/synthetic.test.ts
it('my new profile works on bursts', () => {
  const detected = createDetector(MY_PROFILE)(audio)
  expect(detected).toHaveLength(expectedCount)
})

# Run
npm test -- synthetic.test.ts
```

### Evaluate on real clips

```bash
# If you have local labels
npm run eval

# Or in code
const candidates = detectShots(audio, onset, MY_PROFILE)
const verified = await verifyShotsWithVideo(file, candidates)
```

---

## Takeaways

1. **Layered design matters**: Each layer (onset, threshold, picking, gating, verification) solves a specific problem

2. **Adaptivity is critical**: A causal local threshold beats a global one; valleys beat a refractory period

3. **Gate orchestration**: The precision of the first two gates (prominence, stereo) does most of the work; self-similarity adds refinement

4. **Fewer models, more signals**: FFT + explicit features beat neural black boxes on small data (YAMNet F1 38% vs 60%)

5. **Video as a safety net**: Not required for basic detection, but helps with ownership recognition (own vs enemy)

6. **Optimising for the business metric**: F1 = the scientific metric; the user cares about corrections (FP + FN). Asymmetric thresholds beat aiming for a 50/50 P/R

---

**Status**: The system is stable on the labeled set, ready for production. The next level is fuller labeling for ownership classification (own/enemy/random).
