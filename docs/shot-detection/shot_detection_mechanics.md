# Shot detection mechanics in pewpew

## Overview

The system uses a **three-level approach**:
1. **Audio detection** — finding the acoustic signatures of shots
2. **Candidate filtering** — dropping false positives through specialised gates
3. **Video verification** — checking the muzzle flash and recoil (optional)

---

## Level 1: Audio analysis (Onset Detection)

### Files: `src/domain/detection/onsetDetection.ts`

Computes two independent "event onset" measures for every audio frame:

#### 1.1 Spectral Flux
Measures **any sharp change in the broad spectrum**:
- **What it does**: FFT over a 1024-sample window, then sums only the positive amplitude changes between frames
- **Formula**: `flux = Σ max(0, mag[k]_frame_i - mag[k]_frame_i-1)`
- **Parameters**:
  - `windowSize = 1024` (≈ 21 ms at 48kHz)
  - `hopSize = 256` (hop ~5 ms, resulting frame rate ~100 Hz)
- **Why it helps**: Shots contain a burst of energy across many frequencies at once
- **The mono problem**: It catches any loud transition well, including music, explosions, the commentator

#### 1.2 High-Frequency Rise (HFC)
Measures **the increase in high-frequency content only**:
- **What it does**: `hfcRise[i] = max(0, HFC[i] - HFC[i-1])`, where `HFC = Σ mag[k]·(k+1)`
- **Why "rise"?** A shot may be loud, but if the base already contains sharp frequencies (e.g. in the middle of a burst), we look only at the rise, not at the absolute level
- **Advantage**: Separates one shot from several in a burst (they are caught as separate ones)
- **Without it**: The whole burst merged into one peak (recall 52% instead of 63%)

#### 1.3 Onset Strength Curve
- **What**: `onsetStrength = (spectralFlux + highFrequencyRise) / 2`
- **Normalisation**: Each component is normalised by its own maximum in the clip
- **Result**: A [0,1] curve of ~1000 frames per second of audio

### Key takeaway
Two orthogonal signals are better than one, even if both are noisy. On the labeled set each is imperfect on its own, but together they catch 90%+ of real shots.

---

## Level 2: Finding and filtering peaks

### 2.1 Adaptive local threshold

**File**: `src/domain/detection/shotDetection.ts`, function `computeLocalThreshold()`

Problem: A single threshold level for the whole clip is bad, because loud music or an explosion raises the bar for the rest of the video.

**Solution**: For each frame `i` its own threshold is computed, looking only into the past:

```
threshold[i] = max(
  minThreshold (0.02),
  mean_past + multiplier (2.5) * σ_past
)
```

**Parameters**:
- `thresholdWindowSeconds = 1` — causal window (the past ~100 frames)
- `thresholdMultiplier = 2.5` — how many standard deviations above the mean
- `minThreshold = 0.02` — absolute floor (otherwise noise triggers in quiet stretches)

**Effect**: A loud explosion does not "clutter" the thresholds for calm shooting afterwards.

### 2.2 Peak extraction by valleys

**Function**: `pickPeaks()`

A **state machine** is used rather than a plain maximum search:

```
state = unarmed
for each frame in the curve:
  if not armed && value > threshold[i]:
    armed = true
    peak_value = value
    peak_index = i
  
  if armed:
    if value > peak_value:
      peak_value = value
      peak_index = i
    
    if value < peak_value * 0.25:  # valleyRatio
      emit(peak_index)
      armed = false
```

**Advantage**: 
- A burst of 5 shots (100 ms apart) is caught as 5 separate peaks, not 1
- Long music or an explosion does not create false peaks in the "valley"
- Adapts to the fire rate

**Parameters**:
- `valleyRatio = 0.25` — the curve must fall to 25% of the maximum

### 2.3 Refining to the exact sample

**Function**: `refineToSamplePeak()`

The onset curve has a resolution of ~10 ms (100 Hz). Accurate sound replacement needs an exact sample:

```
1. Take the peak time from the onset curve (accuracy ±10 ms)
2. Find the sample with the maximum amplitude in a ±5 ms window
3. Use it as the exact moment of the shot
```

**Result**: Time resolution of ~1 ms (sound-splicing accuracy).

---

## Level 3: Candidate filtering gates

After peak finding we have a list of candidates. The junk has to be dropped.

### 3.1 Gate 1: Local prominence

**File**: `src/domain/detection/shotDetection.ts`, lines 388–391

```
background = median(RMS) in a ±0.5 s window
prominenceDb = 20 * log10(peak_amplitude / background)
if prominenceDb < 6 dB: DROP
```

**Why the median?** Shots themselves are short impulses (they do not raise the background median), unlike the mean (which gets inflated by loud events).

**Parameter**: `localProminenceDb = 6` dB

**Effect on the labeled set**:
- 6 dB is better than 4 or 8
- Quiet shots (< 6 dB above the background) are treated as noise — an acceptable price for fewer false positives

**Who passes**: ~60% of audio candidates

### 3.2 Gate 2: Stereo width

**File**: `src/domain/detection/shotDetection.ts`, lines 234–256

Shots in CS2 POV sound **wide in stereo** (the weapon is off-centre).

```
For a ±10 ms window around the shot:
  mid = (L + R) / 2
  side = (L - R) / 2
  
widthDb = 10 * log10(energy_side / energy_mid)

if widthDb < -15 dB: DROP
```

**Why it works** (best single discriminator, AUC 0.741):
- Shots: median −13 dB (medium width)
- False positives: median −19 dB (nearly mono)
  - The commentator's voice (channel correlation 0.973)
  - Music (often centred)
  - UI sounds

**Parameters**:
- `stereoWidthDb = -15` — the threshold
- A plateau from −25 to −15 dB keeps F1 at 46%—48%, confirming a real effect

**Who passes**: ~92% of audio candidates

### 3.3 Gate 3: Fingerprint self-similarity

**Files**: `src/domain/detection/audioFingerprint.ts`, `src/domain/detection/shotDetection.ts` (filterBySelfSimilarity)

**Idea**: Shots from one weapon in one clip sound nearly identical (one and the same game sample in CS2). Junk (music, voice) is not alike.

#### 3.3.1 Fingerprint (42 numbers)

**What is measured**:
- 3 "attacks" (−5, +10, +25 ms from the peak) + 1 "tail" (+100 ms)
- Each frame: 10 numbers = 8 logarithmic band ratios + spectral centroid + spectral flatness

```
FINGERPRINT_LENGTH = 4 frames * 10 features + 2 temporal scalars = 42
```

**Temporal features**:
- `attackTime` — how fast it rose to the peak (normalised to 50 ms)
- `decayTime` — how long it decayed (normalised to 300 ms)

#### 3.3.2 Comparing fingerprints

Cosine similarity between two fingerprints:

```
similarity = dot_product / (norm_a * norm_b)
range: [0, 1]
1 = identical timbres
0 = orthogonal
```

#### 3.3.3 Clustering

**Default mode**: `largestCluster` (assistant for POV)

```
1. Build a graph: vertex = candidate, edge = similarity >= 0.97
2. Find the connected components
3. Keep only the largest component
```

**Why this beats neighbor mode**:
- POV clip: one cluster dominates (own weapon) + small clusters (junk, enemies)
- `largestCluster` removes the junk, the main weapon remains
- Reduces user corrections from ~330 to ~114

**Parameters**:
- `selfSimilarityThreshold = 0.97` — minimum similarity for an edge
- `selfSimilarityMinNeighbors = 2` — not used in largestCluster mode
- `selfSimilarityWhenNoCluster = 'keep'` — if there are no pairs above 0.97 at all, keep the candidates (protects rare single shots)

**Who passes**: ~70% of audio candidates

### 3.4 Merging close shots

**Function**: `mergeCloseShots()`

If two candidates are closer than `minSeparationSeconds`, keep the stronger one (echo, rattle).

**Parameter**: `minSeparationSeconds = 0` (disabled by default, because the minimum within a burst is 0.09 s)

---

## Level 4: Video verification (optional)

### 4.1 Muzzle flash detection

**Files**: `src/domain/detection/videoShotVerification.ts`, `src/domain/video/videoFrameMetrics.ts`

**ROI**: Bottom-centre of the screen (36% of the width, 30% of the height)

```python
def scoreMuzzleFlash(baselineLuma, peakLuma):
    rise = peakLuma - baselineLuma
    if rise < 0.035:  # compression noise, HUD flicker
        return 0
    # Typical flash: +0.08–0.35 luma
    return min(1, rise / 0.16)
```

**Parameters**:
- `preRollSeconds = 0.05` — before the shot (baseline lighting)
- `postRollSeconds = 0.04` — after the shot (flash peak)
- `minFlashScore = 0.28` — minimum to pass

### 4.2 Recoil detection

**ROI**: The central crosshair (24% of the width, 28% of the height)

```python
def scoreRecoil(meanAbsDiff):
    if meanAbsDiff < 0.025:  # walking, mouse look
        return 0
    return min(1, meanAbsDiff / 0.1)
```

**Parameters**:
- Ordinary mouse movement: Δ ≈ 0.02–0.04 luma
- ≥ 0.025 is required to filter out noise

### 4.3 Ownership Score

```python
def combineOwnershipScores(flashScore, recoilScore):
    if flashScore <= 0:
        return 0  # the flash is the primary signal
    # 75% for the flash, 25% for recoil, a bonus when both agree
    return min(1, 
        flashScore * 0.75 + 
        recoilScore * 0.25 + 
        flashScore * recoilScore * 0.15
    )
```

**Thresholds**:
- `minOwnershipScore = 0.4` — to pass

---

## Optional matching against the weapon library

### Files: `src/domain/detection/weaponTemplates.ts`, `src/domain/detection/weaponTemplates.json`

**Purpose**: An informational hint in the UI, **NOT a gate**.

**Why not a gate?**
On the labeled set, matching against the dry template library gave F1 ≤ 52%, while self-similarity → 60%. The reason: a dry asset (game sample) and mixed-down video are too far apart.

**Signature**:
```typescript
matchWeaponFingerprint(fingerprint: Float32Array): WeaponMatch | null
{
  weaponId, label, confidence, variant: 'single' | 'burst'
}
```

**Fingerprint**: The same 42 numbers as in self-similarity.

---

## Profiles and presets

### DEFAULT_SHOT_DETECTION_OPTIONS (current assistant)

Optimised for `min(FP + FN)` for own shots:

```typescript
{
  thresholdMultiplier: 2.5,
  minThreshold: 0.02,
  thresholdWindowSeconds: 1,
  valleyRatio: 0.25,
  localProminenceDb: 6,
  backgroundWindowSeconds: 0.5,
  stereoWidthDb: -15,
  selfSimilarityThreshold: 0.97,
  selfSimilarityMinNeighbors: 2,
  selfSimilarityMode: 'largestCluster',
  selfSimilarityWhenNoCluster: 'keep',
  minSeparationSeconds: 0,
  matchWeaponTemplates: true,
}
```

**Results on ~201 shots**:
- F1 ≈ 60%
- Precision ≈ 90%
- Recall ≈ 49%
- **Corrections**: ~114 (versus ~330 in recall-first mode)

### RECALL_AUDIO_SHOT_DETECTION_OPTIONS

High coverage, lots of junk:
- `selfSimilarityThreshold: 0`
- `selfSimilarityWhenNoCluster: 'keep'`

### PRECISION_AUDIO_SHOT_DETECTION_OPTIONS

Strict mode for any weapon:
- `thresholdMultiplier: 3.0`
- `selfSimilarityWhenNoCluster: 'drop'`
- `minSeparationSeconds: 0.055`

---

## Measurement and evaluation

### Infrastructure

**Synthetic tests** (`eval/*.test.ts`):
- Controlled impulses with known timecodes
- Gaussian noise, music, explosions
- Work for everyone (no data dependencies)

**Real clips** (local):
- Labels in `labels/*.json`
- Audio in `examples/.cache/*.wav` (32-bit float)
- Video in `examples/` (copyrighted)

### Metrics

Matching: one-to-one by time (not greedy "nearest").

**Tolerances**:
- ±50 ms (MIREX standard for onsets)
- ±25 ms (stricter)

**Outputs**:
- Precision / Recall / F1
- Median |Δt| for hits on a shot (for sound replacement)
- Recall on the `hard` category separately (junk, loud events)

### Commands

```bash
npm test                              # synthetic + regression protection
npm run eval                          # per-clip table
npm run eval -- --verbose             # with error timecodes
npm run eval -- --only <slug>         # one clip
npm run eval -- --update-baseline     # pin the numbers
npm run eval -- --fail-on-regression  # exit code when F1 drops
```

---

## What did not work (rejected)

Found on the labeled set, not worth trying without new data:

- **Local MAD normalisation**: the z-score blew up in quiet stretches
- **Subtracting the median from the curve**: F1 34.8% vs 36.4%
- **Log compression / band-limited flux**: false positives brighter than shots (centroid 5467 vs 4063 Hz)
- **YAMNet zero-shot (AudioSet)**: AUC 0.436 (worse than random), CS2 POV is out of distribution
- **Decoding cadence by RPM**: the grid cuts recall harder (lots of semi-auto without an ideal rhythm)
- **Fixed refractory period instead of valleys**: F1 40% vs 48%
- **Logistic regression on spectral features**: 45.6% vs 44.4% (overfitting on five clips)

---

## Final architecture

```
File (MP4/WebM)
    ↓
[mediaAnalysis] → decode video/audio
    ↓
[computeOnsetCurve] → spectralFlux + HFC_rise → onsetStrength
    ↓
[detectShots] → (audio-only candidate stage)
    ├─ computeLocalThreshold
    ├─ pickPeaks (valley-based)
    ├─ refineToSamplePeak (sample-level accuracy)
    ├─ Prominence Gate (6 dB)
    ├─ Stereo Width Gate (−15 dB)
    ├─ Self-Similarity Filter (0.97 cosine, largestCluster)
    └─ mergeCloseShots
    ↓
[detectShotsFused] → verifyShotsWithVideo (optional)
    ├─ scoreMuzzleFlash
    ├─ scoreRecoil
    └─ combineOwnershipScores
    ↓
DetectedShot[] → UI editor

```

**Filtering along the path**:
- Audio candidates: 100% → 60% (Prominence) → 92% (Stereo) → 70% (Self-Sim)
- Video verification: final filter by flash + recoil

**F1 on the labeled set**: ~60% (assistant mode, own shots)
