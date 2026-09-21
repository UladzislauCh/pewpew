# Quick reference: shot detection mechanics

## Code navigation

### Main detection files

| File | Function | Purpose |
|------|---------|-----------|
| `src/domain/detection/onsetDetection.ts` | `computeOnsetCurve()` | Computing Spectral Flux + HFC Rise → Onset Strength curve |
| `src/domain/detection/shotDetection.ts` | `detectShots()` | Audio candidate detection + filters |
| `src/domain/detection/shotDetection.ts` | `computeLocalThreshold()` | Adaptive causal threshold |
| `src/domain/detection/shotDetection.ts` | `pickPeaks()` | State-machine peak extraction by valleys |
| `src/domain/detection/shotDetection.ts` | `refineToSamplePeak()` | Sample-level precision (±5 ms → ±1 ms) |
| `src/domain/detection/audioFingerprint.ts` | `computeShotFingerprint()` | 42D shot timbre vector |
| `src/domain/detection/audioFingerprint.ts` | `compareFingerprints()` | Cosine similarity between fingerprints |
| `src/domain/detection/shotDetectionFusion.ts` | `detectShotsFused()` | Combining audio + video verification |
| `src/domain/detection/videoShotVerification.ts` | `verifyShotsWithVideo()` | Checking muzzle flash + recoil |
| `src/domain/video/videoFrameMetrics.ts` | `scoreMuzzleFlash()` | Flash measure in the ROI |
| `src/domain/video/videoFrameMetrics.ts` | `scoreRecoil()` | Recoil measure in the ROI |

### Parameter constants

| Parameter | Value | Where | Effect |
|----------|----------|-----|--------|
| `DEFAULT_WINDOW_SIZE` | 1024 | onsetDetection.ts:25 | FFT window (21 ms @ 48kHz) |
| `DEFAULT_HOP_SIZE` | 256 | onsetDetection.ts:26 | Hop (5 ms @ 48kHz, ≈100 Hz output) |
| `thresholdMultiplier` | 2.5 | shotDetection.ts:105 | σ multiplier for the adaptive threshold |
| `minThreshold` | 0.02 | shotDetection.ts:106 | Absolute threshold floor |
| `thresholdWindowSeconds` | 1 | shotDetection.ts:107 | Causal window (1 s of history) |
| `valleyRatio` | 0.25 | shotDetection.ts:108 | Valley = peak * 0.25 |
| `localProminenceDb` | 6 | shotDetection.ts:110 | Minimum above the local background |
| `stereoWidthDb` | −15 | shotDetection.ts:112 | Side/Mid gate (shots −13, junk −19) |
| `selfSimilarityThreshold` | 0.97 | shotDetection.ts:114 | Cosine similarity for clustering |
| `minFlashScore` | 0.28 | videoShotVerification.ts:32 | Minimum flash |
| `minOwnershipScore` | 0.40 | videoShotVerification.ts:32 | Combined video score |
| `FINGERPRINT_LENGTH` | 42 | audioFingerprint.ts:32 | Fingerprint vector size |

## Parameters by profile

### DEFAULT_SHOT_DETECTION_OPTIONS (current)
Optimised for: `min(FP + FN)` for own shots

```
Recall ≈ 49%, Precision ≈ 90%, F1 ≈ 60%
Corrections ≈ 114 on ~200 shots
```

### RECALL_AUDIO_SHOT_DETECTION_OPTIONS
High coverage, many false positives

```
selfSimilarityThreshold: 0 (disable the filter)
selfSimilarityWhenNoCluster: 'keep'
```

### PRECISION_AUDIO_SHOT_DETECTION_OPTIONS
Strict mode for any weapon

```
thresholdMultiplier: 3.0 (higher threshold)
selfSimilarityWhenNoCluster: 'drop'
minSeparationSeconds: 0.055 (merging echoes)
```

## Pipeline architecture

```
File (MP4/WebM)
  ↓ mediaAnalysis
  └─→ audio: AudioBuffer
  └─→ video: File (for verification)
  
audio → computeOnsetCurve()
  └─→ spectralFlux, highFrequencyRise, onsetStrength
  
onsetStrength → computeLocalThreshold()
  └─→ per-frame adaptive threshold (mean + 2.5σ)
  
(curve, threshold) → pickPeaks()
  └─→ indices[] (where value > threshold & fell below value*0.25)
  
indices → refineToSamplePeak()
  └─→ candidates: {time, strength, relativeLoudness}
  
candidates ↓
  ├─ computeShotFingerprint() → 42D fingerprint
  ├─ measureStereoWidthDb() → S/M ratio
  └─ measureBackground() → local RMS median
  
Gates (in sequence):
  1. Prominence: 20log10(peak/bg) ≥ 6 dB
  2. Stereo Width: S/M ≥ −15 dB
  3. Self-Similarity: cosine ≥ 0.97 + largestCluster
  
candidates → mergeCloseShots()
  └─→ audio_detected: DetectedShot[]

(optional) → verifyShotsWithVideo()
  ├─ scoreMuzzleFlash() → flashScore
  ├─ scoreRecoil() → recoilScore
  └─ combineOwnershipScores() → videoScore
  
verified: DetectedShot[] (sorted by time)
  {
    time: number (seconds)
    strength: number (0-1)
    relativeLoudness: number (0-1)
    weaponMatch?: WeaponMatch (informational)
    videoScore?: number (0-1)
    videoFlashScore?: number
    videoRecoilScore?: number
  }
```

## Lost in the code? Search by task

### Need to understand how it works...

**Finding shots by audio:**
- Start: `computeOnsetCurve()` in onsetDetection.ts
- Curves: spectralFlux, highFrequencyRise, onsetStrength

**Adaptive threshold:**
- Function: `computeLocalThreshold()` in shotDetection.ts:160–189
- Idea: each frame looks into the past (causal window)

**Separating individual shots:**
- Function: `pickPeaks()` in shotDetection.ts:268–303
- Key: valleys (value < peak * 0.25), not a refractory period

**Where does a false alarm come from?**
- Gate 1: `prominenceDb < 6 dB` → background
- Gate 2: `stereoWidthDb < −15 dB` → mono (voice, music)
- Gate 3: No self-similar neighbors → unique noise
- Video: `videoScore < 0.4` → no flash/recoil

**Fingerprints and matching:**
- Computation: `computeShotFingerprint()` in audioFingerprint.ts:145–166
- Comparison: `compareFingerprints()` in audioFingerprint.ts:172–184
- Clustering: `keepLargestFingerprintCluster()` in shotDetection.ts:456–493

**Video verification:**
- Main: `verifyShotsWithVideo()` in videoShotVerification.ts:157–220
- Flash: `scoreMuzzleFlash()` in videoFrameMetrics.ts:90–99
- Recoil: `scoreRecoil()` in videoFrameMetrics.ts:104–108
- Combining: `combineOwnershipScores()` in videoFrameMetrics.ts:113–116

## Testing and evaluation

### Commands

```bash
# Synthetic tests (always work)
npm test

# Evaluation on real clips (local)
npm run eval

# One clip
npm run eval -- --only "ak47-dbf13655"

# Verbose output (error timecodes)
npm run eval -- --verbose

# Update the baseline
npm run eval -- --update-baseline

# Non-zero exit code if F1 dropped
npm run eval -- --fail-on-regression
```

### Metrics

- **Precision / Recall / F1** @ ±50 ms (MIREX) and ±25 ms
- **Median |Δt|** — timing accuracy for sound replacement
- **Recall on `hard`** — separately on noisy shots

### Where are the labels?

- Ground truth: `labels/*.json` (committed)
- Audio cache: `examples/.cache/*.wav` (WAV 32-bit float)
- Video: `examples/*.mp4` (copyrighted, local only)

## Common mistakes

| Problem | Cause | Fix |
|----------|---------|---------|
| Many FP on music | The stereo gate lets mono through | Lower stereoWidthDb (but FN grows) |
| False peaks on noise | minThreshold too low | Raise minThreshold or localProminenceDb |
| A burst merges into 1 peak | HFC_rise was not used instead of HFC | Check computeOnsetCurve (it must be rise) |
| Single shots get filtered out | selfSimilarityWhenNoCluster = 'drop' | Switch to 'keep' for sparse shots |
| Video verification fails | Wrong ROI for the frame | Check VIEWMODEL_FLASH_ROI, CROSSHAIR_RECOIL_ROI in videoRegions.ts |

## Metrics on the labeled set (approximate)

| Stage | Passes | Filtered out | Reasons |
|------|---------|-----------|-----------------|
| Audio candidates | 100% | — | — |
| Prominence gate | 60% | 40% | Noise, music (weak) |
| Stereo gate | 92% | 8% | Mono (voice, UI) |
| Self-similarity | 70% | 30% | Unique junk |
| Video filter | 80% | 20% | No flash/recoil |
| **Final** | **~50%** | **~50%** | Combined F1 ≈ 60% |

## How to extend?

### Add a new gate

```typescript
// In shotDetection.ts, in the detectShots() loop
const myMetric = computeMyMetric(mono, time)
if (myMetric < MY_THRESHOLD) continue  // ← DROPPED

shots.push({ ..., myMetric })
```

### Change the profile

```typescript
export const MY_PROFILE: ShotDetectionOptions = {
  ...DEFAULT_SHOT_DETECTION_OPTIONS,
  localProminenceDb: 8,  // ← stricter
  stereoWidthDb: -17,    // ← stricter
}
```

### Test a profile

```typescript
// in eval/evaluate.ts
const detector = (audio) => detectShots(audio, onset, MY_PROFILE)
// or in the app:
const shots = detectShots(audio, onset, MY_PROFILE)
```

## Reference material

- **eval/README.md** — full documentation of the metrics and decisions made
- **weapon-samples/** — dry CS2 weapon assets (for templates)
- **labels/** — annotated ground-truth clips
- **vitest.config.ts** — test configuration (FFmpeg worker, fixtures)

## FAQ

**Q: Why can't the fingerprint be used as a gate?**  
A: On the labeled set self-similarity (0.97) gives F1 ~60%, while template matching gives only 52%. Dry game samples are too far from compressed game footage. The fingerprint is used for clustering (self-similarity within one clip), not for recognising the weapon type.

**Q: Why HFC Rise and not raw HFC?**  
A: Raw HFC = high-frequency energy, it stays high for the whole burst. Rise = only the increase, which lets each shot be separated. Without it a burst merged into one peak (recall 52% → 63%).

**Q: Can it work without video?**  
A: Yes, audio detection is independent. Video is an optional final filter for raising precision and for recognising other players' shots (absence of a flash).

**Q: How is ownership computed?**  
A: `0.75 * flash + 0.25 * recoil + bonus`. The flash is the primary signal (if absent, score = 0). Recoil is secondary confirmation.

