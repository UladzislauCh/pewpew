# Improvements & Progress Tracking

Long-term roadmap and current status for pewpew enhancement.

---

## Phase 1: Foundation & Analysis (Weeks 1-4)

### Goal
Collect first 10 labeled clips, understand current error patterns.

**Definition of Done:** F1 measured on 10 clips, top 3 hypotheses identified.

### Week 1-2: Prepare Infrastructure
- [ ] **Tests Agent:** Verify labeler.html works
  - [ ] Can load video
  - [ ] Shortcuts respond (A, E, H, X)
  - [ ] Save creates labels/*.json
- [ ] **UI Agent:** Improve labeler UX (if bottlenecks found)
- [ ] **Detection Agent:** Ready to analyze
- [ ] **Status:** Baseline established (F1 60%)

**Owner:** Tests Agent  
**Effort:** ~4 hours

---

### Week 3-4: First Data Collection
- [ ] **Tests Agent:** Coordinate with UI on labeling
  - [ ] User labels 5 clips via labeler.html
  - [ ] Verify labels match audio (spot check)
  - [ ] Run eval: `pnpm eval`
  - [ ] Baseline: F1 ~60% on 5 clips

- [ ] **Detection Agent:** Prepare for analysis
  - [ ] Understand eval output
  - [ ] Review eval/README.md
  
- [ ] **UI Agent:** Polish labeler based on user feedback
  - [ ] Speed up labeling workflow
  - [ ] Fix any UX friction

- [ ] **Status:** 5 clips labeled, errors analyzed

**Owner:** Tests Agent (coordination)  
**Effort:** ~8 hours labeling + 2 hours analysis

---

### Analysis: Error Patterns
After 5-10 clips, Tests Agent creates error table:

```
| Clip | Time | Type | dB Above Bg | Format | Gate | Notes |
|------|------|------|------------|--------|------|-------|
| c1 | 2.3s | FN | 4 dB | Stereo | Prom | Quiet shot |
| c1 | 1.2s | FP | -22dB | Mono | Stereo | Voice leak |
```

**Outcome:** Hypotheses for Phase 2

---

## Phase 2: First Improvements (Weeks 5-8)

### Goal
Test 2-3 hypotheses, achieve F1 ~63-65%.

**Definition of Done:** Each hypothesis tested, 1-2 committed, F1 improved.

### Hypothesis 1: Adaptive Prominence Gate
**Problem:** Many FN on quiet shots (< 6 dB)  
**Solution:** Lower localProminenceDb to 4 on low-noise background  
**Expected Impact:** +1-2% F1

- [ ] Detection Agent:
  - [ ] Implement adaptive threshold (low BG = lower gate)
  - [ ] Code: `src/domain/detection/shotDetection.ts` line ~110
  
- [ ] Tests Agent:
  - [ ] Run eval before/after
  - [ ] Report: F1 delta, precision cost
  
- [ ] Result: ✓ Merged / ✗ Reverted

**Owner:** Detection Agent  
**Effort:** 2-3 hours

---

### Hypothesis 2: Spectral Gate for Mono
**Problem:** Stereo-width gate fails on mono mics (15% of clips)  
**Solution:** Add centroid-based filtering when channels === 1  
**Expected Impact:** +2-3% F1 on mono, no cost on stereo

- [ ] Detection Agent:
  - [ ] Detect mono: `if (channels === 1)`
  - [ ] Add spectral gate (high centroid = voice/music)
  - [ ] Code: `src/domain/detection/shotDetection.ts`
  
- [ ] Tests Agent:
  - [ ] Eval with/without
  - [ ] Check: F1 on mono clips specifically
  
- [ ] Result: ✓ Merged / ✗ Reverted

**Owner:** Detection Agent  
**Effort:** 3-4 hours

---

### Hypothesis 3: Echo Merging
**Problem:** Ricochet/echo creates FP 100ms after shot  
**Solution:** Enable `minSeparationSeconds: 0.05`  
**Expected Impact:** +0.5-1% F1

- [ ] Detection Agent:
  - [ ] Change: `minSeparationSeconds: 0.05`
  - [ ] Caution: might lose very-fast bursts
  
- [ ] Tests Agent:
  - [ ] Eval on clips with known echoes
  - [ ] Confirm: doesn't hurt fast auto-fire
  
- [ ] Result: ✓ Merged / ✗ Reverted

**Owner:** Detection Agent  
**Effort:** 1-2 hours

---

### Parallel: Expand Data
- [ ] **Tests Agent:** Label 5-10 more clips (total 15-20)
  - Different audio conditions (mono, Bluetooth, etc.)
  - Different lighting (for video verification)
  - Different cameras (POV, spectator, third-person)

**Owner:** Tests Agent (coordinate with UI)  
**Effort:** ~10 hours labeling

---

### End of Phase 2
- **Tests Agent:** Update baseline
  - `pnpm eval --update-baseline`
  - F1: 60% → ~63%
  - Track in IMPROVEMENTS.md

- **Detection Agent:** Document findings
  - Which hypotheses worked/failed
  - Why (data-driven reasoning)

- **UI Agent:** Monitor performance
  - Build still fast?
  - No regressions in main app?

---

## Phase 3: Scale & Optimize (Weeks 9-12)

### Goal
Reach F1 ~70-75%, document all improvements.

**Definition of Done:** 30 clips labeled, F1 ≥ 70%, production-ready.

### Expand Data to 30 Clips
- [ ] **Tests Agent:** Coordinate labeling of 10-15 more clips
- [ ] **UI Agent:** Ensure labeler stays responsive at scale
- [ ] **Detection Agent:** Analyze new error patterns

**Status after week 10:** 30 clips, F1 ~67-68%

---

### Final Hypothesis Round (Weeks 10-12)

#### Hypothesis 4: Attack/Decay Time Gate
**Problem:** Some false positives have unusual temporal envelopes  
**Solution:** Use attackTime, decayTime from fingerprint  
**Expected Impact:** +0.5-1% F1

- [ ] Detection Agent: Implement (low effort, already in fingerprint)
- [ ] Tests Agent: Measure impact

#### Hypothesis 5: Adaptive Stereo Width
**Problem:** Some clips have different stereo characteristics  
**Solution:** Adjust stereoWidthDb threshold per clip  
**Expected Impact:** +0.5-1% F1

- [ ] Detection Agent: Analyze cluster, adapt threshold
- [ ] Tests Agent: Eval per-clip

#### Hypothesis 6+: Data-Driven
**Problem:** TBD based on week 10 error analysis  
**Solution:** TBD  
**Expected Impact:** +0.5-2% F1

---

### Documentation
- [ ] Detection Agent: `docs/DECISIONS.md`
  - Why each hypothesis was tested
  - Results (with numbers)
  - Why we didn't pursue certain ideas

- [ ] Tests Agent: Error analysis summary
  - Remaining FN/FP patterns
  - Are they fundamental or tunable?

- [ ] UI Agent: UX iteration log
  - What improved usability
  - What's still friction

---

## Progress Tracking

### Baseline Epochs

**Epoch 1 (August 2026):**
```
Date:      August 13, 2026
Clips:     5
F1:        60.0%
Precision: 90%
Recall:    49%
Owner:     Initial baseline
Notes:     Default options, no hypotheses yet
```

**Epoch 2 (Target: Week 6):**
```
Date:      September 24, 2026
Clips:     10
F1:        63.0% (+3%)
Precision: 89%
Recall:    52%
Owner:     Hyp 1 (adaptive prominence) + Hyp 2 (spectral gate)
Changes:   -localProminenceDb: 4 on quiet BG
           +spectral gate for mono
```

**Epoch 3 (Target: Week 12):**
```
Date:      October 22, 2026
Clips:     30
F1:        71.0% (+11% from baseline)
Precision: 86%
Recall:    60%
Owner:     All hypotheses 1-6 integrated
Changes:   5+ commits, each measured
```

---

## Success Criteria

### Phase 1 (Week 4)
- ✅ 10 clips labeled
- ✅ Baseline F1 measured (~60%)
- ✅ Top 3 hypotheses identified
- ✅ Error analysis table created

### Phase 2 (Week 8)
- ✅ 1-2 hypotheses tested & committed
- ✅ F1 improved to ~63-65%
- ✅ 15-20 clips labeled (data expanded)
- ✅ No regressions on baseline clips

### Phase 3 (Week 12)
- ✅ F1 ≥ 70% on 30+ clips
- ✅ Precision ≥ 85%
- ✅ Recall ≥ 55-60%
- ✅ All improvements documented
- ✅ Production-ready code

---

## Known Limitations (Won't Fix)

These were tested and didn't help:

- ❌ Weapon template matching: F1 51% (vs 60% self-similarity)
- ❌ YAMNet zero-shot: AUC 0.436 (worse than random)
- ❌ RPM cadence: Hurts recall on semi-auto
- ❌ Logistic regression: Overfits on 5 clips

**Reason:** Data limitations. Revisit only with 50+ clips.

---

## Future Work (Post-Phase 3)

If F1 ≥ 70%:
- **Option A:** Deploy (F1 sufficient, precision good)
- **Option B:** Try ML classifier on 30+ clips
- **Option C:** Ownership classification (own vs enemy shots)
- **Option D:** Extend to other games (new data needed)

If F1 < 70%:
- **Option A:** More data (50+ clips might reveal patterns)
- **Option B:** Revisit ML (only if data sufficient)
- **Option C:** Different approach (e.g., spectrogram CNN)

---

## How to Update This Document

**When you complete a task:**
1. Update checkbox: `- [x]` instead of `- [ ]`
2. Add result comment: `(F1 60% → 62.1% ✓)`
3. Add date/owner if not filled
4. Create new `## Epoch X` entry if baseline updated

**Example:**
```markdown
- [x] Detection Agent:
  - [x] Implement adaptive threshold
  - [x] Run eval: F1 60% → 62.1% ✓
  
Owner: Detection Agent
Date:  September 24, 2026
```

---

**Last Updated:** August 13, 2026  
**Maintained By:** Main (Claude) + 3 Agents  
**Next Review:** End of Phase 1 (Week 4)
