# Demo recording: specification

The goal is to get labelled examples of ACTIONS (a shot, a burst, a reload, running, jumping)
that the real set does not have at all. Of 527 extra markers, 83% sit where there is no shot,
and the model does not know what was there instead: it has only seen "a candidate that is not
a shot".

**Pilot on one weapon first.** Recording the whole arsenal before checking the domain gap is
not allowed: the project has already lost work on this (`docs/RESEARCH-journal.md`, "Synthesis
of training data"), where mixing in cheap labels degraded quality monotonically with volume,
because the data carried its own signature — AUC "synthetic vs real" 0.974.

---

## Pilot: Glock, then Deagle. NOT AK-47

The first version of this file made AK-47 the pilot — it has the most labelled real data. That
was wrong, and here is the measurement that showed it.

The model's failure sits on SPARSE clips (recall 27% vs 83%), and sparse clips are pistols and
snipers, not rifles:

| weapon | own shots in sparse clips | of them isolated |
|---|---|---|
| glock | 33 | 5 |
| usp_s | 26 | 15 |
| deagle | 24 | **18** |
| ssg08 | 11 | **11** |
| awp | 8 | **8** |
| ak47 | 17 | 0 |

"Isolated" means the neighbour is more than 250 ms away, i.e. at 30 fps there are 8+ free
frames around the shot.

This settles everything, because the features the eye sees — slide travel, the open ejection
port, the weapon model lighting up — exist only if a shot gets several frames. And the
intervals between own shots are:

| | median to the neighbouring shot | isolated |
|---|---|---|
| sparse clips | **218 ms = 6.5 frames** at 30 fps | 38% |
| dense clips | 71 ms = 2.1 frames | 4% |

For the AK the median is 75 ms, i.e. 2.2 frames per shot: the bolt cycle physically does not
fit. For the MAC-10 it is 1.7 frames. **Per-frame shot cues are unresolvable in automatic fire
at 30 fps and resolvable on pistols.** And the model fails exactly on pistols.

Order: **Glock** (there is already a detailed description of its cues), then **Deagle**
(the largest slide travel, and 18 of its 24 shots in the set are isolated).
AK-47 is worth recording too, but third and as a CONTROL: it checks that the feature does not
break dense fire, where the model already works.

### Recording settings

| what | how | why |
|---|---|---|
| frame rate | **two runs: 30 and 60 fps** | 40 of the 49 real clips are shot at 30 fps. It was the frame rate that killed the flash feature — the flash is shorter than a frame. The casing and the slide must be checked at both. |
| resolution | 1920×1080 | as in most sources |
| HUD | **on, ammo counter visible** | the counter gives free per-frame ground truth: it decreases exactly on an own shot |
| `viewmodel_fov` | default (68), **plus one run with a different value** | it is a player setting, and authors of real clips have their own. The second run shows how sensitive the feature is to it. |
| crosshair | regular dynamic | it expands when firing — a possible feature |
| map | any, but **with varied backgrounds**: a bright wall, a dark corner, smoke | the weapon mask currently catches on smoke and walls; we need examples where the background gets in the way |
| lighting | **a segment in a dark place is required** | as observed with the glock, the weapon model itself lights up on a shot. On a bright background it is invisible, in the dark it shows well. |

### What to record — one segment per item, 20–40 seconds

Between items pause for 2–3 seconds **standing still** — the segments are cut automatically on
these pauses.

**Firing**
1. Single shots with a 2–3 s pause between them — at least 20.
   **This is the main segment.** Sparse fire is exactly the case where the model falls apart,
   and the only one where a shot gets enough frames to see the slide travel.
2. Doubles and triples.
3. A full magazine in one burst, standing.
4. A full magazine in one burst, moving.
5. Firing while jumping.
6. Firing while crouching.

**Non-firing — this is half the value of the recording**
7. Running forward, backward, sideways — no shots.
8. Jumps in place and while moving — no shots.
9. Reloading, several times, standing and running.
10. Switching weapons back and forth, several times.
11. **Mouse movement only, standing still, not a single action.**
    This segment is valuable on its own: the weapon is what does NOT move with the camera,
    and on a clean frame without a webcam and killfeed it can be found that way automatically.
12. Standing still, complete absence of actions — 20 seconds.
13. Someone shoots at you, you do not shoot back (a bot or a teammate).
    This is a direct example of "someone else's shot", which the set has little of: only 650
    of 4808 candidates.
14. You take damage — to show how the view jerks not from your own shot.
15. **Grenade explosions near you** — your own and others'.
16. **The weapon select and switch sound on its own**, not tied to a reload:
    the slide click when drawing a weapon sounds similar to a shot.
17. **Voice chat talking over silence** — if the recording captures shared audio.

Items 15–17 were added after reviewing the real `deagle` clip: there an extra marker with a
score of 0.847 sat exactly on the combination "voice in TeamSpeak + slide sound when selecting
a weapon + grenade explosion". These are concrete sources of false candidates, not
hypothetical ones.

### What NOT to do

- Do not overlay anything on the frame: no webcam, no overlays, no captions.
  There is a gap with real clips already, no need to add one of your own.
- Do not re-encode or upload to YouTube. Hand over the source as is.
- Do not cut into short files by hand — one file per item or one long one
  with pauses between items.

### How to hand over

The files plus a short text list: which segment starts at which second and what is in it.
Exact shot times are not needed — the ammo counter will provide them, it is unambiguous in
these recordings (in real clips it got confused with health and armor, but here there is no
damage).

---

## What will be done with the pilot

1. **Gap diagnosis.** A "demo vs real clip" discriminator on motion features.
   The reference is the same number that caught the synthesis: if AUC is around 0.97, the data
   carries its own signature and training on it will follow that signature, not the shot.
2. **Checking slide travel, the ejection port and weapon lighting at 30 fps.**
   The casing need not be checked: as observed on a real clip, its ejection is already "hard to
   catch, it is fast enough", and this agrees with the measurement — on rifles a shot gets
   2 frames. What lasts longer is the SLIDE TRAVEL, so that is what we measure.
3. **Finding the weapon region** on segment 11 — by the "does not move with the camera" cue.
   On a clean frame this should work; on real clips exactly this failed because of the
   killfeed and captions (`findViewmodel.mjs` in the journal).

The judge stays the same: **the 49 real clips, sparse and dense separately**.
No metric on demos counts as a result — the model can be arbitrarily good on them, just like
the network on synthetic data whose loss fell to 0.167 at 29.3% of shots found on real videos.
