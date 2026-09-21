# Detection Agent: Ready to Start?

Checklist before diving into the project.

---

## Phase 0: Knowledge (4–5 days, 8–10 hours)

### Reading Order (Start here)

```
Day 1 (2–3h):
  ✅ CLAUDE.md (how we work together)
  ✅ This file (you are here)
  ✅ AGENT_DETECTION.md (your job)
  ✅ DETECTION_SKILLSET.md (required knowledge)

Day 2 (2–3h):
  ✅ eval/README.md (why each optimization worked)
  ✅ docs/shot-detection/shot_detection_mechanics.md (deep dive)
  
Day 3 (1–2h):
  ✅ skim src/domain/detection/shotDetection.ts (find parameters)
  ✅ skim src/domain/detection/audioFingerprint.ts (fingerprint structure)

Day 4–5 (2–3h hands-on):
  ✅ pnpm eval (understand output)
  ✅ look at labels/ak47-dbf13655.json (ground truth example)
  ✅ pnpm test (synthetic tests work)
```

### Knowledge Checkpoints

After Day 1, you should understand:
- [ ] 4 stages of detection (onset → picking → gating → video)
- [ ] What HFC Rise is and why it matters (recall +11%)
- [ ] The 3 main gates (Prominence 6dB, Stereo −15dB, Self-Sim 0.97)
- [ ] Why fingerprints cluster similar shots

After Day 2–3, you should know:
- [ ] How to read `pnpm eval` output
- [ ] What each parameter does (hint: DETECTION_SKILLSET.md has table)
- [ ] How to identify FN vs FP patterns from error table
- [ ] Why some hypotheses failed (ML, templates, etc.)

After Day 4–5, you should be able to:
- [ ] Run `pnpm eval --verbose` and understand errors
- [ ] Propose 2–3 hypotheses with reasoning
- [ ] Locate which file/line to change for each hypothesis
- [ ] Predict F1 impact (rough: ±2%)

---

## Sanity Check: Test Your Knowledge

**Before starting any labeling, answer these:**

1. **Q:** Why is `minThreshold = 0.02` needed?
   **A:** ___________________
   
2. **Q:** What's the difference between Spectral Flux and HFC Rise?
   **A:** ___________________
   
3. **Q:** Why does stereo-width gate fail on mono audio?
   **A:** ___________________
   
4. **Q:** If you lower `localProminenceDb` from 6 to 4, what happens to F1?
   **A:** ___________________ (give direction + tradeoff)

5. **Q:** What's the "largestCluster" mode for?
   **A:** ___________________

**Answers in DETECTION_SKILLSET.md → "Questions to Test Your Understanding"**

If you get 4/5 correct → proceed. Otherwise → re-read SKILLSET.

---

## Phase 1: Environment (1 day)

### ✅ Setup

```bash
# 1. Clone/navigate to project
cd ~/Projects/pewpew

# 2. Verify build works
pnpm build
# ✅ Should complete in ~5–10s

# 3. Verify tests pass
pnpm test
# ✅ Should show all synthetic tests pass

# 4. Verify eval baseline
pnpm eval
# ✅ Should show:
#    F1: 60.0%
#    Precision: 90%
#    Recall: 49%

# 5. Verify labeler UI works
pnpm dev
# ✅ Open http://localhost:5173/labeler.html
#    Should load, show interface (no video yet)
```

**If anything fails:** Fix it before continuing (ask Main if stuck).

---

## Phase 2: First Labeling (2–3 days)

### ✅ Get Videos

Download 5–10 CS2 videos (30–60 sec each):
- YouTube Shorts/Highlights search "CS2 gunshots"
- Twitch VODs (nrz them via youtube-dl if needed)
- Professional matches (ESL, BLAST on YouTube)

**Quality criteria:**
- Clear gunshot audio (not muffled)
- Visible action (for video verification later)
- Mix of: auto-fire bursts, single shots, player perspectives

**Put them in:**
```bash
examples/
├─ clip1.mp4
├─ clip2.mp4
└─ ... (5 total)
```

### ✅ Labeling Process

For each clip (10–15 min per clip):

```bash
# Start dev server (keep running)
pnpm dev
# Open http://localhost:5173/labeler.html

# Load clip from list
# Press Space to play, listen for gunshots

# For each shot:
#   Press A (mark lands exactly at the playhead, no snapping)
#   Press E if it's enemy fire (toggle own ↔ enemy)
#   Press H if it's "hard" (noisy, buried in music/explosion)

# After all shots:
#   Tick "Clip fully labeled"
#   Press ⌘S (save)

# Verify files created:
#   labels/clip-name.json       ← Ground truth
#   examples/.cache/clip-name.wav ← Decoded audio
```

**Tips:**
- Don't worry about exact timing; it snaps to nearest peak
- Mark ALL shots, including enemy fire (eval needs it)
- If unsure if it's a shot → mark as H (hard)
- Save frequently

**After 5 clips:** Proceed to Analysis

---

## Phase 3: First Analysis (1–2 days)

### ✅ Evaluate

```bash
# Run on all labeled clips
pnpm eval

# Record output:
# F1: _____ (should be ~60% if labels are good)
# Precision: _____
# Recall: _____

# Get detailed errors
pnpm eval --verbose > eval-results.txt
```

### ✅ Create Error Table

Open spreadsheet (Google Sheets or Excel):

```
Epoch | Clip | Time | Type | dB Abv Bg | Format | Gate | Notes
------|------|------|------|-----------|--------|------|----------
  1   | c1   | 2.3s | FN   | +4dB      | Stereo | Prom | Quiet shot, below 6dB
  1   | c1   | 1.2s | FP   | −22dB     | Mono   | Stereo | Voice, monoaural
  1   | c2   | 7.1s | FN   | +2dB      | Stereo | Prom | Tiny transient
```

**Populate from:**
- `pnpm eval --verbose` output (shows times + types)
- Listen to clips at those times (confirm what it was)
- Infer which gate rejected it

### ✅ Spot Patterns

From 10–20 errors, look for:
- "Most FN are quiet (< 5 dB)"
- "Most FP are on monoaural signals"
- "Some FP are ~100ms echoes"
- "FP pattern: high-frequency content (voice, music)"

**Top 3 patterns become hypotheses for Phase 4**

---

## Phase 4: First Code Change (2–3 days)

### ✅ Pick Hypothesis

From error patterns, choose the most common:

| Most Common Problem | Hypothesis | File & Line |
|-------------------|-----------|-----------|
| FN on quiet shots | Lower `localProminenceDb` 6 → 4 | shotDetection.ts:110 |
| FP on mono audio | Add spectral gate (complex) | shotDetection.ts:394+ |
| FP on echoes | Enable `minSeparationSeconds` 0 → 0.05 | shotDetection.ts:118 |

**Start with:** Prominence (simplest, high impact)

### ✅ Implement

```bash
# Edit file
nano src/domain/detection/shotDetection.ts

# Find line ~110:
# localProminenceDb: 6,

# Change to:
# localProminenceDb: 4,

# Save (Ctrl+X, Y, Enter)
```

### ✅ Measure

```bash
# Run eval
pnpm eval

# Compare:
# Before: F1 60.0%, Precision 90%, Recall 49%
# After:  F1 ____._ %, Precision ___%, Recall ____%
#         Δ = ____%

# If improved:
#   Good! Proceed to commit

# If regressed:
#   No problem. Revert and try next hypothesis.
#   git checkout src/domain/detection/shotDetection.ts
```

### ✅ Commit (If F1 Improved)

```bash
git commit -m "fix: lower prominence threshold for quiet shots

- Reduced localProminenceDb from 6 to 4 dB
- Improves detection of quiet shots on low-noise background
- F1: 60.0% → 62.1% (+2.1%) on 5-clip set
- Precision: 90% → 89% (−1%, acceptable tradeoff)
- Recall: 49% → 52% (+3%)
- Eval: All baseline clips pass, no regression"
```

---

## Completion Checklist

### Knowledge Phase
- [ ] Read CLAUDE.md
- [ ] Read DETECTION_SKILLSET.md
- [ ] Read AGENT_DETECTION.md
- [ ] Read eval/README.md ("What worked" in the "What has already been measured" section)
- [ ] Understand 4-stage detection
- [ ] Understand 3 main gates
- [ ] Can answer 4/5 knowledge questions

### Environment Phase
- [ ] `pnpm build` works
- [ ] `pnpm test` passes
- [ ] `pnpm eval` shows F1 60%
- [ ] `pnpm dev` opens labeler.html

### Labeling Phase
- [ ] 5+ clips downloaded
- [ ] 5+ clips labeled (all shots marked)
- [ ] `labels/*.json` files exist
- [ ] `examples/.cache/*.wav` files exist

### Analysis Phase
- [ ] `pnpm eval` runs on labeled clips
- [ ] F1 is ~60% (confirms labels are sensible)
- [ ] Error table created (10+ errors)
- [ ] 2–3 hypotheses identified

### Code Phase (First Hypothesis)
- [ ] Hypothesis chosen
- [ ] Code changed (1 parameter)
- [ ] `pnpm eval` re-run
- [ ] F1 improved OR reverted
- [ ] Commit made with metrics

---

## Success = You Can Do This

After completing the checklist, you should be able to:

✅ Run eval and understand why F1 is X%  
✅ Read error table and spot patterns  
✅ Predict which hypothesis will help  
✅ Change a parameter and measure impact  
✅ Commit with before/after metrics  

---

## Still Stuck?

**Ask Main (Claude) for help on:**
- Knowledge questions (DETECTION_SKILLSET.md tests)
- Setup issues (build, eval, labeler)
- Interpreting confusing eval output
- Hypothesis design (is this a good idea?)

**Don't ask about:**
- "Is DSP hard?" (yes, but you'll learn by doing)
- "Can I skip the knowledge phase?" (no)
- "Why do I need to understand parameters?" (because you're tuning them)

---

## Ready?

When you've completed the checklist:
1. Reply: "I'm ready to start"
2. I'll help guide you through Phases 1–4
3. We'll measure each change together
4. After first successful hypothesis, you'll understand the flow

**Estimate:** 2–3 weeks to first successful improvement.

Go to `DETECTION_SKILLSET.md` and start reading. 📚
