# Walkthrough: the main shot detection functions

## Entry point: detectShotsFused()

**File**: `src/domain/detection/shotDetectionFusion.ts`

```typescript
export async function detectShotsFused(
  file: File,
  audio: AudioLike,
  onset: OnsetAnalysis,
  audioOptions: Partial<ShotDetectionOptions> = {},
  videoOptions: Partial<VideoVerificationOptions> = {},
): Promise<DetectedShot[]> {
  // 1. Audio detection
  const candidates = detectShots(audio, onset, audioOptions)
  
  // 2. Video verification (if available)
  return verifyShotsWithVideo(file, candidates, videoOptions)
}
```

**Input**: 
- `file` — the source MP4/WebM
- `audio` — the decoded AudioBuffer
- `onset` — the result of `computeOnsetCurve(audio)`

**Output**: 
- A time-sorted `DetectedShot[]` array

---

## Level 1: Onset Curve (onsetDetection.ts)

### Function: computeOnsetCurve()

```typescript
export function computeOnsetCurve(
  audioBuffer: AudioLike,
  windowSize = DEFAULT_WINDOW_SIZE,    // 1024
  hopSize = DEFAULT_HOP_SIZE,          // 256
): OnsetAnalysis {
  const mono = toMono(audioBuffer)
  const hannWindow = makeHannWindow(windowSize)
  const fft = createFFT(windowSize)
  const halfSize = windowSize / 2
  
  // Compute for every frame
  const numFrames = Math.max(0, Math.floor((mono.length - windowSize) / hopSize) + 1)
  
  const frameTimes = new Float32Array(numFrames)
  const spectralFluxRaw = new Float32Array(numFrames)
  const hfcRaw = new Float32Array(numFrames)
  
  let prevMagnitude: Float32Array | null = null
  
  for (let frame = 0; frame < numFrames; frame++) {
    // Frame window
    const start = frame * hopSize
    const re = new Float32Array(windowSize)
    const im = new Float32Array(windowSize)
    
    for (let i = 0; i < windowSize; i++) {
      re[i] = mono[start + i] * hannWindow[i]  // apply the Hann window
      im[i] = 0
    }
    
    // FFT
    fft.transform(re, im)
    
    // Compute spectral features
    const magnitude = new Float32Array(halfSize)
    let flux = 0
    let hfc = 0
    
    for (let k = 0; k < halfSize; k++) {
      const mag = Math.hypot(re[k], im[k])
      magnitude[k] = mag
      
      // HFC = Σ mag[k] * (k+1) — high frequencies weigh more
      hfc += mag * (k + 1)
      
      // Flux = Σ max(0, mag[k] - prevMag[k])
      if (prevMagnitude) {
        const diff = mag - prevMagnitude[k]
        if (diff > 0) flux += diff
      }
    }
    
    frameTimes[frame] = (start + windowSize / 2) / audioBuffer.sampleRate
    spectralFluxRaw[frame] = flux
    hfcRaw[frame] = hfc
    prevMagnitude = magnitude
  }
  
  // HFC Rise = positive changes only
  const hfcRise = new Float32Array(numFrames)
  for (let i = 1; i < numFrames; i++) {
    hfcRise[i] = Math.max(0, hfcRaw[i] - hfcRaw[i - 1])
  }
  
  // Normalise each by its own peak
  const spectralFlux = normalizeByPeak(spectralFluxRaw)
  const highFrequencyRise = normalizeByPeak(hfcRise)
  
  // Combine: average of both curves
  const onsetStrength = new Float32Array(numFrames)
  for (let i = 0; i < numFrames; i++) {
    onsetStrength[i] = (spectralFlux[i] + highFrequencyRise[i]) / 2
  }
  
  return {
    frameTimes,
    spectralFlux,
    highFrequencyRise,
    onsetStrength,
    windowSize,
    hopSize,
    sampleRate: audioBuffer.sampleRate,
  }
}
```

**Key points**:
1. **Mono downmix**: Everything is analysed on the mono signal
2. **Hann window**: Avoids artefacts at the edges of the FFT window
3. **HFC weighted by k**: Bin i contributes `mag[i] * (i+1)`, i.e. high frequencies weigh more
4. **HFC Rise**: Only the rise is seen, not the absolute level (the key to separating shots in a burst)
5. **Separate normalisation**: Flux and HFC_rise are normalised independently to their own maxima

---

## Level 2: Peak Picking (shotDetection.ts)

### Function: computeLocalThreshold()

```typescript
export function computeLocalThreshold(
  curve: Float32Array,
  windowFrames: number,
  multiplier: number,
  minThreshold: number,
): Float32Array {
  const threshold = new Float32Array(curve.length)
  const window = Math.max(1, windowFrames)
  
  for (let i = 0; i < curve.length; i++) {
    // Causal window: past only
    const from = Math.max(0, i - window)
    const to = Math.max(from + 1, i)
    const count = to - from
    
    // Compute mean and σ
    let sum = 0
    for (let j = from; j < to; j++) sum += curve[j]
    const avg = sum / count
    
    let sumSquares = 0
    for (let j = from; j < to; j++) {
      const delta = curve[j] - avg
      sumSquares += delta * delta
    }
    const sd = Math.sqrt(sumSquares / count)
    
    // Threshold = max(floor, mean + k*σ)
    threshold[i] = Math.max(minThreshold, avg + multiplier * sd)
  }
  
  return threshold
}
```

**Parameters at defaults**:
- `windowFrames = Math.round(1 * frameRate)` ≈ 100 frames (1 s)
- `multiplier = 2.5`
- `minThreshold = 0.02`

**Worked example** (frame i=50):
```
from = max(0, 50 - 100) = 0
to = 50
past fragment of the curve: [0.04, 0.05, ..., 0.07, 0.06]
mean = 0.055, σ = 0.008
threshold[50] = max(0.02, 0.055 + 2.5 * 0.008) = max(0.02, 0.075) = 0.075
```

### Function: pickPeaks()

```typescript
export function pickPeaks(
  curve: Float32Array,
  threshold: number | Float32Array,
  valleyRatio: number,
): number[] {
  const peaks: number[] = []
  let armed = false
  let bestIndex = -1
  let bestValue = -Infinity
  const thresholdAt = (i: number) => 
    typeof threshold === 'number' ? threshold : threshold[i]
  
  for (let i = 0; i < curve.length; i++) {
    const value = curve[i]
    
    if (!armed) {
      // Wait for an upward crossing
      if (value > thresholdAt(i)) {
        armed = true
        bestIndex = i
        bestValue = value
      }
      continue
    }
    
    // In armed mode: track the maximum
    if (value > bestValue) {
      bestValue = value
      bestIndex = i
    }
    
    // Check for a valley
    if (value < bestValue * valleyRatio) {
      peaks.push(bestIndex)   // Store the index of the maximum
      armed = false
      bestValue = -Infinity
      bestIndex = -1
    }
  }
  
  // If the curve did not fall by the end, store the last maximum
  if (armed && bestIndex >= 0) peaks.push(bestIndex)
  
  return peaks
}
```

**How it runs** (onsetStrength = [0.02, 0.04, 0.08, 0.10, 0.09, 0.04, 0.03, 0.08, 0.12, 0.05, ...]):

```
i=0: armed=false, 0.02 < 0.075 → nothing
i=1: armed=false, 0.04 < 0.075 → nothing
i=2: armed=false, 0.08 > 0.072 → armed=true, best=0.08, idx=2
i=3: armed=true, 0.10 > 0.08 → best=0.10, idx=3
i=4: armed=true, 0.09 < 0.10 → 0.09 is not < 0.025 (0.10*0.25) → continue
i=5: armed=true, 0.04 < 0.025 → EMIT(3), armed=false
i=6: armed=false, 0.03 < 0.075 → nothing
i=7: armed=false, 0.08 > 0.075 → armed=true
i=8: armed=true, 0.12 > 0.08 → best=0.12, idx=8
i=9: armed=true, 0.05 < 0.03 → EMIT(8), armed=false

Result: [3, 8]
```

### Function: refineToSamplePeak()

```typescript
export function refineToSamplePeak(
  mono: Float32Array,
  approxTime: number,
  sampleRate: number,
  searchRadiusSeconds: number,
): { time: number; amplitude: number } {
  const centerSample = Math.round(approxTime * sampleRate)
  const radius = Math.round(searchRadiusSeconds * sampleRate)
  const start = Math.max(0, centerSample - radius)
  const end = Math.min(mono.length, centerSample + radius)
  
  let peakIndex = centerSample
  let peakAmplitude = 0
  
  for (let i = start; i < end; i++) {
    const amplitude = Math.abs(mono[i])
    if (amplitude > peakAmplitude) {
      peakAmplitude = amplitude
      peakIndex = i
    }
  }
  
  return { time: peakIndex / sampleRate, amplitude: peakAmplitude }
}
```

**Example** (onset gave t≈4.5 s, windowSize=1024, hopSize=256):
```
approxTime = 4.5
searchRadiusSeconds = (1024 / 256) / (48000 / 2) ≈ 0.0053 s = 5 ms
centerSample = 4.5 * 48000 = 216000
radius = 256 samples
start = 215744, end = 216256
search for max(|mono[i]|) in this window
found: 216042 → time = 216042 / 48000 = 4.50088 s
```

---

## Level 3: Gating Filters

### Gate 1: Prominence

```typescript
// from shotDetection.ts, lines 374–391
const backgroundAt = measureBackground(mono, audioBuffer.sampleRate, opts.backgroundWindowSeconds)

for (const frameIndex of peakIndices) {
  const approxTime = onset.frameTimes[frameIndex]
  const { time, amplitude } = refineToSamplePeak(mono, approxTime, sampleRate, searchRadiusSeconds)
  
  // Local background around the shot
  const background = backgroundAt(time)
  const prominenceDb = 20 * Math.log10((amplitude + 1e-9) / (background + 1e-9))
  
  if (prominenceDb < opts.localProminenceDb) continue  // ← DROPPED
  
  // Continue to the remaining gates...
}
```

**The measureBackground() function** — median RMS over a ±0.5 s window:

```typescript
function measureBackground(
  mono: Float32Array,
  sampleRate: number,
  halfWindowSeconds: number,
): (time: number) => number {
  const frameLength = Math.max(1, Math.round(0.01 * sampleRate))  // 10 ms frames
  const frameCount = Math.max(1, Math.floor(mono.length / frameLength))
  
  // RMS of each 10 ms frame
  const rms = new Float32Array(frameCount)
  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * frameLength
    const end = Math.min(mono.length, start + frameLength)
    let energy = 0
    for (let i = start; i < end; i++) energy += mono[i] * mono[i]
    rms[frame] = Math.sqrt(energy / Math.max(1, end - start))
  }
  
  // Running median
  const halfWindow = Math.max(1, Math.round(halfWindowSeconds / 0.01))  // 50 frames for 0.5 s
  const median = new Float32Array(frameCount)
  const scratch: number[] = []
  
  for (let frame = 0; frame < frameCount; frame++) {
    const from = Math.max(0, frame - halfWindow)
    const to = Math.min(frameCount, frame + halfWindow + 1)
    scratch.length = 0
    for (let i = from; i < to; i++) scratch.push(rms[i])
    scratch.sort((a, b) => a - b)
    median[frame] = scratch[scratch.length >> 1]
  }
  
  // Lookup function
  return (time) => {
    const frame = Math.round((time * sampleRate) / frameLength)
    return median[Math.min(frameCount - 1, Math.max(0, frame))]
  }
}
```

### Gate 2: Stereo Width

```typescript
// shotDetection.ts, lines 237–256
function measureStereoWidthDb(audio: AudioLike, time: number): number {
  if (audio.numberOfChannels < 2) return Infinity  // Mono → skip the gate
  
  const left = audio.getChannelData(0)
  const right = audio.getChannelData(1)
  const from = Math.max(0, Math.round((time - 0.002) * audio.sampleRate))  // −2 ms (pre-roll)
  const to = Math.min(left.length, from + Math.round(0.02 * audio.sampleRate))  // 20 ms window
  
  let midEnergy = 0
  let sideEnergy = 0
  
  for (let i = from; i < to; i++) {
    const mid = (left[i] + right[i]) / 2
    const side = (left[i] - right[i]) / 2
    midEnergy += mid * mid
    sideEnergy += side * side
  }
  
  return 10 * Math.log10((sideEnergy + 1e-12) / (midEnergy + 1e-12))
}

// In detectShots:
if (measureStereoWidthDb(audioBuffer, time) < opts.stereoWidthDb) continue  // ← DROPPED
```

**Example**:
```
L = [0.5, 0.6, 0.4]
R = [0.3, 0.5, 0.2]
mid = [(0.5+0.3)/2, (0.6+0.5)/2, (0.4+0.2)/2] = [0.4, 0.55, 0.3]
side = [(0.5-0.3)/2, (0.6-0.5)/2, (0.4-0.2)/2] = [0.1, 0.05, 0.1]

midEnergy = 0.16 + 0.3025 + 0.09 = 0.5525
sideEnergy = 0.01 + 0.0025 + 0.01 = 0.0225

widthDb = 10 * log10(0.0225 / 0.5525) ≈ 10 * log10(0.041) ≈ 10 * (-1.39) ≈ -13.9 dB
threshold −15 dB → −13.9 > −15 → PASS ✓
```

### Gate 3: Self-Similarity

```typescript
// shotDetection.ts, lines 419–454
function filterBySelfSimilarity(
  shots: DetectedShot[],
  fingerprints: Float32Array[],
  opts: ShotDetectionOptions,
): DetectedShot[] {
  if (opts.selfSimilarityThreshold <= 0 || shots.length < 2) return shots
  
  // Look for at least one pair above the threshold
  let anyPairMatches = false
  for (let i = 0; i < fingerprints.length && !anyPairMatches; i++) {
    for (let j = i + 1; j < fingerprints.length; j++) {
      if (compareFingerprints(fingerprints[i], fingerprints[j]) >= opts.selfSimilarityThreshold) {
        anyPairMatches = true
        break
      }
    }
  }
  
  if (!anyPairMatches) {
    return opts.selfSimilarityWhenNoCluster === 'drop' ? [] : shots
  }
  
  // largestCluster mode: find and keep only the largest component
  if (opts.selfSimilarityMode === 'largestCluster') {
    return keepLargestFingerprintCluster(shots, fingerprints, opts.selfSimilarityThreshold)
  }
  
  // neighbors mode: keep those with enough neighbours
  return shots.filter((_, index) => {
    let neighbors = 0
    for (let other = 0; other < fingerprints.length; other++) {
      if (other === index) continue
      if (compareFingerprints(fingerprints[index], fingerprints[other]) >= opts.selfSimilarityThreshold) {
        neighbors++
        if (neighbors >= opts.selfSimilarityMinNeighbors) return true
      }
    }
    return false
  })
}

// keepLargestFingerprintCluster (lines 456–493) — BFS over the similarity graph
function keepLargestFingerprintCluster(
  shots: DetectedShot[],
  fingerprints: Float32Array[],
  threshold: number,
): DetectedShot[] {
  const n = shots.length
  
  // Build the graph: i → j if similarity[i][j] >= threshold
  const adj: number[][] = Array.from({ length: n }, () => [])
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (compareFingerprints(fingerprints[i], fingerprints[j]) >= threshold) {
        adj[i].push(j)
        adj[j].push(i)
      }
    }
  }
  
  // Find connected components
  const seen = Array.from({ length: n }, () => false)
  let best: number[] = []
  
  for (let i = 0; i < n; i++) {
    if (seen[i]) continue
    
    // BFS from i
    const stack = [i]
    seen[i] = true
    const component = [i]
    
    while (stack.length > 0) {
      const u = stack.pop()!
      for (const v of adj[u]) {
        if (seen[v]) continue
        seen[v] = true
        stack.push(v)
        component.push(v)
      }
    }
    
    // Keep the largest component
    if (component.length > best.length) best = component
  }
  
  if (best.length < 2) return shots  // No cluster
  return best.map((index) => shots[index])
}
```

---

## Computing the fingerprint

**File**: `src/domain/detection/audioFingerprint.ts`, functions `computeShotFingerprint()`, `computeFrameFeatures()`

```typescript
export function computeShotFingerprint(
  mono: Float32Array,
  sampleRate: number,
  peakIndex: number,
): Float32Array {
  const out = new Float32Array(FINGERPRINT_LENGTH)  // 42
  
  // 3 attack frames
  let offset = 0
  for (const offsetMs of ATTACK_FRAME_OFFSETS_MS) {  // [-5, 10, 25]
    const startSample = peakIndex + Math.round((offsetMs / 1000) * sampleRate)
    const frame = extractFrame(mono, startSample)
    computeFrameFeatures(frame, sampleRate, out, offset)
    offset += FEATURES_PER_FRAME  // 10
  }
  
  // 1 tail frame
  const tailStartSample = peakIndex + Math.round((100 / 1000) * sampleRate)
  const tailFrame = extractFrame(mono, tailStartSample)
  computeFrameFeatures(tailFrame, sampleRate, out, offset)
  offset += FEATURES_PER_FRAME
  
  // 2 temporal scalars
  const [attackTime, decayTime] = computeTemporalFeatures(mono, peakIndex, sampleRate)
  out[offset] = attackTime
  out[offset + 1] = decayTime
  
  return out
}

function computeFrameFeatures(
  frame: Float32Array,
  sampleRate: number,
  out: Float32Array,
  offset: number,
): void {
  const fft = getFFT()
  const re = frame.slice()
  const im = new Float32Array(FFT_SIZE)
  fft.transform(re, im)
  
  const halfSize = FFT_SIZE / 2
  const magnitude = new Float32Array(halfSize)
  let totalEnergy = 0
  
  for (let k = 0; k < halfSize; k++) {
    const mag = Math.hypot(re[k], im[k])
    magnitude[k] = mag
    totalEnergy += mag
  }
  
  // 8 band energy ratios
  const bandEdgeBins = BAND_EDGES_HZ.map((hz) =>    // [150, 300, 600, 1200, 2400, 4800, 9600]
    Math.round((hz / (sampleRate / 2)) * halfSize)
  )
  
  let bandStart = 0
  for (let band = 0; band < NUM_BANDS; band++) {
    const bandEnd = band < bandEdgeBins.length ? Math.min(halfSize, bandEdgeBins[band]) : halfSize
    let bandEnergy = 0
    for (let k = bandStart; k < bandEnd; k++) bandEnergy += magnitude[k]
    out[offset + band] = totalEnergy > 0 ? bandEnergy / totalEnergy : 0
    bandStart = bandEnd
  }
  
  // Spectral centroid (normalized to [0, 1])
  let weightedSum = 0
  for (let k = 0; k < halfSize; k++) weightedSum += k * magnitude[k]
  const centroidBin = totalEnergy > 0 ? weightedSum / totalEnergy : 0
  out[offset + NUM_BANDS] = centroidBin / halfSize
  
  // Spectral flatness (geometric mean / arithmetic mean)
  const epsilon = 1e-6
  let logSum = 0
  for (let k = 0; k < halfSize; k++) logSum += Math.log(magnitude[k] + epsilon)
  const geometricMean = Math.exp(logSum / halfSize)
  const arithmeticMean = totalEnergy / halfSize + epsilon
  out[offset + NUM_BANDS + 1] = geometricMean / arithmeticMean
}
```

**Result**: a 42-element vector describing the shot's timbre.

---

## Comparing fingerprints

```typescript
export function compareFingerprints(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0
  let normA = 0
  let normB = 0
  const length = Math.min(a.length, b.length)
  
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))  // Cosine similarity
}
```

**Example**:
```
a = [0.5, 0.3, 0.2, ...]
b = [0.48, 0.31, 0.21, ...]  (a similar shot)

dot = 0.5*0.48 + 0.3*0.31 + 0.2*0.21 + ... ≈ high
normA = 0.25 + 0.09 + 0.04 + ... ≈ 1.0
normB = 0.23 + 0.096 + 0.044 + ... ≈ 0.99

similarity = dot / sqrt(normA * normB) ≈ 0.975 (very similar)
```

---

## Video verification (Simplified)

**File**: `src/domain/detection/videoShotVerification.ts`

```typescript
export async function verifyShotsWithVideo(
  file: File,
  shots: DetectedShot[],
  options: Partial<VideoVerificationOptions> = {},
): Promise<DetectedShot[]> {
  if (shots.length === 0) return shots
  
  const opts = { ...DEFAULT_VIDEO_VERIFICATION_OPTIONS, ...options }
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  
  try {
    const videoTrack = await input.getPrimaryVideoTrack()
    if (!videoTrack || !(await videoTrack.canDecode())) return []
    
    // Prepare decoding
    const sink = new CanvasSink(videoTrack, {
      width: opts.analysisWidth,  // 480
      poolSize: 1,
    })
    
    // Decode frames around each candidate
    const timeOrigin = await videoTrack.getFirstTimestamp()
    const offsets = [-0.05, -0.025, 0, 0.02, 0.04]  // −50, −25, 0, +20, +40 ms
    const timestamps = uniqueSorted(
      shots.flatMap((shot) =>
        offsets.map((offset) => timeOrigin + shot.time + offset),
      ),
    )
    
    const frameAt = new Map<number, FrameSnapshot>()
    let flashRoi: PixelRect | null = null
    let recoilRoi: PixelRect | null = null
    
    for await (const result of sink.canvasesAtTimestamps(timestamps)) {
      if (!result) continue
      const canvas = result.canvas as CanvasLike
      
      // Initialise the ROIs (Regions of Interest) once
      if (!flashRoi || !recoilRoi) {
        flashRoi = rectToPixels(VIEWMODEL_FLASH_ROI, canvas.width, canvas.height)
        recoilRoi = rectToPixels(CROSSHAIR_RECOIL_ROI, canvas.width, canvas.height)
      }
      
      // Take luminance snapshots
      const mediaTime = result.timestamp - timeOrigin
      const key = Math.round(mediaTime * 1000) / 1000
      frameAt.set(key, snapshotFrame(canvas, mediaTime, flashRoi, recoilRoi))
    }
    
    // Score the candidates
    const verified: DetectedShot[] = []
    for (const shot of shots) {
      const scores = scoreCandidate(shot.time, frameAt, opts)
      if (!scores) continue
      if (scores.flashScore < opts.minFlashScore) continue
      if (scores.ownershipScore < opts.minOwnershipScore) continue
      
      verified.push({
        ...shot,
        videoScore: scores.ownershipScore,
        videoFlashScore: scores.flashScore,
        videoRecoilScore: scores.recoilScore,
      })
    }
    
    return verified.sort((a, b) => a.time - b.time)
  } finally {
    input.dispose()
  }
}
```

---

## Maintenance and testing

### Synthetic test (clips.test.ts)

```typescript
it('detects single shots in silence with standard options', () => {
  const audio = createTestAudio(48000, 2, 2)  // 2 s, stereo
  const shots = generateShots([0.5, 1.0])     // Shots at 0.5 and 1.0 s
  
  const onset = computeOnsetCurve(audio)
  const detected = detectShots(audio, onset)
  
  expect(detected).toHaveLength(2)
  expect(detected[0].time).toBeCloseTo(0.5, 2)
  expect(detected[1].time).toBeCloseTo(1.0, 2)
})
```

### Real clip (eval/run.ts)

```bash
npm run eval -- --only "ak47-dbf13655"
```

Compares detection with `labels/ak47-dbf13655.json` ("ground truth" labels).

### Update the baseline

```bash
npm run eval -- --update-baseline
```

Pins the current F1 / precision / recall numbers as the reference.

---

## Key takeaways

| Component | Purpose | Critical parameter | Effect |
|-----------|-----------|------|--------|
| **Onset Curve** | Finding event onsets | HFC Rise vs Flux | Separating shots in a burst |
| **Adaptive Threshold** | Adapting to context | 1 s causal window | A loud event does not raise the bar |
| **Peak Picking** | Precise localisation | valleyRatio 0.25 | Adapts to the fire rate |
| **Prominence Gate** | Filter out noise | 6 dB | +60% → ~90% precision |
| **Stereo Gate** | Filter out junk | −15 dB | Best single AUC 0.741 |
| **Self-Similarity** | Keep one cluster | 0.97 cosine | Filter out enemies, UI sounds |
| **Video Verification** | Verification by flash | minOwnershipScore 0.4 | Final filter |

