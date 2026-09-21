# Tests & Eval Agent

## Purpose
Measure performance reliably. Prevent regression. Track progress.

Current baseline: **F1 60.0%** (Precision 90%, Recall 49%)  
Measurement tool: `pnpm eval`

---

## Domain & Scope

### You Own
```
eval/                      # Evaluation infrastructure
├─ *.test.ts              # Synthetic tests
├─ evaluate.ts            # Measurement framework
├─ run.ts                 # Main eval runner
└─ fixtures.ts            # Test data

labels/                    # Ground truth annotations
├─ *.json                 # Labeled shots (time, own/enemy, hard tag)

examples/                  # Clips & cached audio
├─ *.mp4                  # Video files
└─ .cache/*.wav           # Decoded audio (32-bit float)
```

### You DON'T Touch
- ❌ `src/domain/detection/shotDetection.ts` — Detection Agent
- ❌ `src/app/`, `src/pages/`, `src/features/*/components/` — UI Agent
- ❌ Architecture decisions without Main approval

---

## Core Concepts

### Two-Tier Testing

**Synthetic Tests** (eval/*.test.ts)
- Controlled: known pulses + managed noise
- Reproducible: same every run
- Fast: seconds, no data needed
- Examples: "quiet shots after loud explosion", "echo rejection"

**Real Clips** (labels/, examples/)
- Realistic: actual CS2 gameplay
- Messy: real player audio, compression, etc.
- Slower: minutes per clip
- Ground truth: manually labeled shot times

### Evaluation Metrics

```bash
pnpm eval
# Output:

F1: 60.0%
├─ Precision: 90% (TP / (TP + FP))
├─ Recall: 49% (TP / (TP + FN))
└─ Median |Δt|: 12ms (timing accuracy for audio splicing)

Per-clip breakdown:
├─ clip1.mp4: F1 62%, P 91%, R 51%
├─ clip2.mp4: F1 58%, P 89%, R 47%
└─ ...

Regression check:
├─ Previous baseline: 60.0%
├─ Current: 60.0%
└─ Δ: +0.0% (OK)
```

### Matching Algorithm

One-to-one pairing (not greedy):
```
Ground truth: [0.5s, 0.55s, 1.0s]
Detected:     [0.48s, 1.02s, 1.8s]
Tolerance:    ±50ms (MIREX standard)

Matches:
- 0.5s ← → 0.48s ✓ (within 50ms)
- 0.55s — (no match, FN)
- 1.0s ← → 1.02s ✓ (within 50ms)
- 1.8s (no match, FP)

Result: TP=2, FN=1, FP=1
```

---

## Workflow

### Routine: Before Detection Agent Commits

**Detection Agent:** "Lowered prominence to 4 dB, run eval"

**You:**
```bash
# Run full evaluation
pnpm eval

# Show detailed output
pnpm eval --verbose

# Report:
"F1: 60.0% → 62.1% ✓
Precision: 90% → 89% (−1% acceptable)
Recall: 49% → 52% (+3% good)
All 5 baseline clips pass (no regression)"

# Detection commits if happy
```

### Routine: After New Clips Are Labeled

**UI Agent:** "We labeled 5 more clips (total 10 now)"

**You:**
```bash
# Eval on all 10
pnpm eval

# Report:
"With 10 clips:
- F1: 62.1% (was 60% on 5)
- New clips slightly harder (60.5% vs 61% on old 5)
- Hypothesis still seems solid"

# Identify new error patterns
pnpm eval --verbose > eval-results.txt
# Share with Detection Agent
```

### Routine: Regression Check Before Merge

**Any Agent:** "About to commit changes"

**You:**
```bash
pnpm eval --fail-on-regression

# Exit code 0 = no regression (safe to merge)
# Exit code 1 = F1 dropped > 1% (don't merge)
```

---

## Key Commands

### Full Evaluation
```bash
# On all labeled clips
pnpm eval

# Shows: F1, Precision, Recall, Median |Δt|, Regression check
```

### Detailed (with Error Times)
```bash
pnpm eval --verbose

# Shows: every FP & FN with timestamp and reason
```

### One Clip Deep Dive
```bash
pnpm eval --only "clip-name"

# Focuses on single clip, good for debugging
```

### Update Baseline
```bash
pnpm eval --update-baseline

# After good improvements, lock in new baseline
# Use sparingly (only when confident in changes)
```

### Regression Alert
```bash
pnpm eval --fail-on-regression

# Exit code indicates: 0 = OK, 1 = regression
# Use in CI/pre-commit hooks
```

### Synthetic Tests
```bash
pnpm test

# Runs eval/*.test.ts
# Fast validation (seconds)
# Good for quick feedback
```

---

## Baseline Tracking

### Current Epoch 1 (August 2026)
```
Date:      August 13, 2026
Clips:     5 (all CS2 POV, good audio)
F1:        60.0%
Precision: 90%
Recall:    49%
Edits:     ~114 per 200 shots
Notes:     Default options, audio-only verification
```

**When to update baseline:**
- After successful hypothesis (+2-3% F1)
- After reaching new clip milestone (10 clips, 20 clips, etc.)
- After major parameter sweep

---

## Working with Labeled Data

### Adding New Clips

1. **User labels clip via UI (labeler.html)**
2. **Two files appear:**
   ```
   labels/new-clip-name.json      # Ground truth
   examples/.cache/new-clip-name.wav  # Decoded audio
   ```
3. **You verify:**
   ```bash
   pnpm eval --only "new-clip-name"
   # Check: does it make sense? Is labeling accurate?
   ```

### Labeling Quality Checks

If eval looks weird (F1 0%, all FN or all FP):
- Likely: ground truth labeling error
- Check: `labels/clip.json` has correct shot times
- Confirm: shot times match actual audio peaks (±50ms)

### Error Analysis Table

Create and maintain (Google Sheets or CSV):

```
Epoch | Clip | Time | Type | Level | AudioChar | Gate | Notes
-----|------|------|------|-------|-----------|------|----------
  1  | c1   | 2.3s | FN   | −5dB  | Quiet BG  | Prom | Below 6dB threshold
  1  | c1   | 4.5s | FP   | −22dB | Mono      | Stereo | No stereo info
  1  | c2   | 7.1s | FN   | −4dB  | Quiet BG  | Prom | Confirm: quiet
```

This table drives Detection Agent's hypotheses.

---

## Synthetic Tests

Location: `eval/*.test.ts`

Examples:
```typescript
it('detects quiet shots after loud explosion', () => {
  // Setup: white noise + loud boom + quiet shots
  // Measure: recall on quiet shots (target 100%)
  // Tests: causal threshold adapts properly
})

it('rejects echo duplicates', () => {
  // Setup: shot + 100ms ricochet
  // Measure: only one detection
  // Tests: minSeparationSeconds works
})
```

**Your role:** Write tests that validate each hypothesis before testing on real data.

---

## Communication with Detection Agent

### You → Detection
```
"Eval complete on your changes:
F1: 60.0% → 62.1% ✓
Precision: 90% → 89%
No regression on baseline clips.
Safe to commit!"
```

### Detection → You
```
"F1 regressed 1.2% after my last change.
Can you run eval --verbose to see where it broke?"
```

**Your response:**
```
"Detailed results:
- Precision dropped (more FP on music)
- FN on fast auto-fire increased
Recommend: revert or adjust stereoWidthDb"
```

---

## Troubleshooting

### "eval command fails"

Common causes:
1. Clips not found: make sure labels/*.json exists
2. Audio cache missing: run pnpm dev to decode
3. Dependency issue: `pnpm install` and retry

### "F1 seems wrong (0%, 100%, etc.)"

Likely: ground truth mislabeled
```bash
pnpm eval --only "problem-clip" --verbose

# Check: FN/FP times match what you hear?
# If not: ask user to re-label via labeler.html
```

### "Regression spike"

Could be:
1. Real regression (test hypothesis earlier)
2. New clips are harder (expected)
3. Labeling error in new clips

**Debug:**
```bash
pnpm eval --verbose | grep "clip-name" | grep FP
# Show FP for new clip — is it really false or labeling error?
```

---

## Milestones (3 Months)

| Week | Clips | F1 Target | Tests | Activity |
|------|-------|-----------|-------|----------|
| 2 | 5 | 60% | Baseline set | Monitor |
| 4 | 10 | 61% | Errors analyzed | Help Detection hypothesize |
| 6 | 10 | 63% | Hyp 1 tested | Measure impact |
| 8 | 20 | 64% | Hyp 2-3 tested | New patterns? |
| 10 | 30 | 67% | Adapt params | Coordinate labeling |
| 12 | 30 | 71% | Final baseline | Regression check |

---

## Success = ?

### Per Measurement Cycle (typically 1-2 weeks)
- [ ] Ran `pnpm eval` on all clips
- [ ] Compared F1 to previous baseline
- [ ] Documented before/after metrics
- [ ] Shared detailed errors with Detection Agent
- [ ] Checked for regression (none > 1%)
- [ ] Updated baseline if appropriate

### By Week 12
- [ ] 30+ labeled clips in dataset
- [ ] F1 ≥ 70% on full set
- [ ] No regressions on baseline clips
- [ ] Error analysis drove 5-10 successful hypotheses
- [ ] Synthetic tests validate new features
- [ ] Ready for production measurement

---

## Reference

- Full eval docs: `eval/README.md` (part of codebase)
- CLAUDE.md: Coordination protocol
- AGENT_DETECTION.md: What Detection Agent commits to

When blocked: ask Main (Claude) for clarification.
