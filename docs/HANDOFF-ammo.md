# Handoff: the ammo counter

A document for a new chat. Read it in full before the first code change.

Written 26 August 2026, extended through 3 September; the header and the summary below were
brought up to date on 21 September 2026. The previous handoff — `docs/HANDOFF-detection.md` —
describes the motion scheme WITHOUT the counter and remains correct for it.

**Current numbers (checked 21 September 2026).**

| what | value | source, date, corpus |
|---|---|---|
| counter, product reader, ±50 ms | **F1 82.0**, P 82.9, R 81.1; ±100 ms F1 91.1 | `eval/ammoScoreBrowser.ts`, 31 August, 45 clips (after the second labeling wave) |
| coverage | 19 of 45 clips (42%), 465 of 980 own shots (47%) | same run |
| shipped path as a whole (counter, else flash) | see `docs/HANDOFF-flash.md`, "Current numbers" | |

The counter numbers were not re-measured on the 50-clip corpus, nor after the 3 September
flash cross-check, which hands three clips (`ssg08`, `mag7`, `m0nesy-awp-flicks`) from the counter
to the flash. Re-measuring needs the browser: `pnpm exec tsx eval/ammoPrep.ts`,
`/eval/ammoBrowser.html`, then `pnpm exec tsx eval/ammoScoreBrowser.ts`.

F1 80.7, quoted in several places below, is the 27 August value, before the second labeling
wave (`g3sg1`, `ssg08`); comparisons against it stay valid as history.

**The main point in one sentence.** The CS2 ammo counter is a direct signal: it drops by
exactly one on every OWN shot and does not react to anyone else's. Where it can be read, it is
more accurate than anything the project had before.

---

## What ships

**Since 3 September: counter -> flash** (the flash replaced motion on 31 August, the counter ladder was added on 3 September). `detectByFlash`
(`src/domain/detection/flash/detectByFlash.ts`, called from `WizardApp.tsx`) reads the counter
on the same pass over the frames as the flash model. If the counter is found and the flash
does not contradict it, the marks come from the counter; otherwise from the flash. Audio
candidates pick the counter slot, and the final marks get one clip-wide shift towards the
audio. Details are in `docs/HANDOFF-flash.md`.

**As of 26 August (superseded):** three stages, in this order:

1. **Audio** — ShotNet produces candidates (unchanged).
2. **Ammo counter** — `src/domain/detection/ammo/`. If it is read, the marks come from it, and
   the second stage does not run at all.
3. **Motion** — the previous scheme, runs only when no counter is found.

The decision was made by `scoreShotsByMotion` in `src/domain/detection/motion/detectWithMotion.ts`,
which is no longer called from the wizard. What still holds: the counter rides on THE SAME pass
over the video as the video stage and receives frames at NATIVE resolution.
This is mandatory: in a 1080p frame the counter is about thirty pixels tall, and in a frame
downscaled to 384 only a few are left.

Counter marks have weight 1, so the confidence slider does not remove them and is disabled in
the UI. The mark's `source` field says which path produced it.

---

## Numbers as of 31 August. TWO DIFFERENT PIPELINES — do not mix them up

| | recall | precision | F1 | coverage |
|---|---|---|---|---|
| **product** (`eval/ammoScoreBrowser.ts`) | **81.1** | **82.9** | **82.0** | 19 clips, 465 of 980 shots |
| python (`eval/ammoScore.ts`) | 76.6 | 80.4 | 78.5 | 17 clips, 440 of 978 |
| previous scheme without the counter (`pnpm eval`, as of 24 August) | 76.4 | 52.2 | 62.0 | all 45 |

Product: sparse 74.6 / 69.4, dense 83.7 / 89.1. **With a 100 ms tolerance — 90.1 / 92.1, F1 91.1.**

**MEASURE ONLY BEFORE SOUND REPLACEMENT.** In the product the replacement is placed 100 ms
before the found moment (`REPLACEMENT_LEAD_SECONDS`), and if the offset leaks into the marks,
the metric drops from 80.7 to 58.2 by construction (27 August numbers). That is exactly why the offset lives in
the replacement.

The product and Python numbers are DIFFERENT and must not be combined in one table. The
reason: the browser decoder and OpenCV produce different pixels, the reading series diverge
slightly, and the decisions diverge after them. The product number is what the user sees;
the Python one is only a guide during development.

Measured on 45 clips, not 49: four clips (`negev`, `p90`, `sg553`, `Torzsi`) had the "fully
labeled" flag removed — their labeling is not finished.

---

## Coverage: 42% of clips (47% of shots) is a property of the CORPUS, not of the product

Out of 45 clips the counter is found on 19 (42%); they hold 465 of 980 own shots (47%). The remaining 26 were checked one by one: **not a
single region of the frame behaves like ammo**. It is the player's webcam over the bottom of
the frame, sponsor banners, third-person view.

The corpus is other people's YouTube highlights. A product user records their own gameplay
with the ordinary HUD, and they will almost always have a counter. **How often exactly is not
measured, and that is the next step.**

### Checked by eye on 31 August: the HUD is not small, it is ABSENT (hypothesis test, hypothesis wrong)

There was a guess that some of the unreadable clips hit the glyph-size limit (26 unreadable
out of 45; the original note said 17 — apparently the subset with slots in the lower part of
the frame, a count not traceable to a script): they do have
slots in the lower part of the frame, but zero reads, which looks like the readability
boundary (works from 14 px, falls apart at 9-11). The guess was NOT CONFIRMED.

Frames at labeled shot moments, nine clips (`mp9`, `tec9`, `galil`, `usp-0`, `p250`, `ump45`,
`p2000`, `deagle`, `glock`) — one and the same layout: a banner with the player's name and
weapon at the top, the gameplay window in the middle, a cut-out figure of the player on a
blurred background at the bottom. **The gameplay window has no ammo, no health, no radar** —
the editor shows only the middle band of the frame. The slots in the lower part that the
reader found are the player's figure and the banner text, not the HUD.

Hence: there is NO POINT lowering the glyph-height threshold; there is nothing to unlock on
these clips.

A measurement of glyph heights across the whole corpus was also done and turned out USELESS:
stable bright spots in the bottom band give the same 5-9 px on readable and unreadable clips
alike, because the counter does not stand out among them. The tool was deleted so that no one
comes back to it. The working way to tell "small" from "not there at all" is to look at the
frame.

---

## How the reader works

```
src/domain/detection/ammo/glyphs.ts     threshold, connected components, joining glyphs into numbers
src/domain/detection/ammo/scan.ts       pass over the clip, stable number positions ("slots")
src/domain/detection/ammo/reader.ts     glyph -> digit by prototypes, median, stable state
src/domain/detection/ammo/identify.ts   which slot is the ammo — by the behaviour of the values
src/domain/detection/ammo/events.ts     drops -> shot moments
src/domain/detection/ammo/align.ts      alignment to audio candidates
public/models/ammoPrototypes.json   digit prototypes
```

The Python original is `python/ammo/`; it also remains the playground for experiments.
Read `python/README.md`.

**Identification goes by the BEHAVIOUR of the series, not by position and not by appearance.**
This is fundamental: health and armour are drawn in the same font at the same size, and an
earlier attempt in the project's history failed exactly here — it counted CHANGES, and a
change looks the same for ammo and for health. Here VALUES are read:

| | behaviour |
|---|---|
| ammo | −1 per shot, jump up to the magazine size |
| health, armour | −5…−40, do not return to the maximum |
| timer | −1, but exactly once per second |

The slot is chosen **by agreement with the audio**: an own shot always makes a sound, so the
real counter is the one whose drops the audio confirmed more. Choosing by the heuristic score
is not allowed — a short noisy series easily takes the maximum.

---

## Eight bugs found in one session. None of them showed up as a crash

1. **The brightness threshold hid coloured digits.** At low ammo CS2 paints the counter orange
   and red; red ink has a Rec.601 luma of 155 against a threshold of 190, so the digits
   disappeared ENTIRELY. The threshold was switched to the maximum of R, G, B. Readability:
   `scar20` 48% → 100%, `g3sg1` 77% → 99%.
2. **The moment was placed between frames.** The flash and the counter change are visible on
   the SAME frame, so the shot happened at the moment the frame shows. Measured on 323 pairs:
   the offset was +15 ms against a half-frame of 16.7 ms.
3. **The frame rate was computed as "frames divided by duration".** The duration is taken from
   the audio track and does not match the video track — by the end of a video the error grew
   to half a frame. Now it comes from the container. This was the biggest porting bug:
   agreement of decisions with Python rose from 40–90% to 88.6%.
4. **The slot was chosen by the heuristic score.** See above.
5. **The offset estimator spoiled correct marks.** On `five_seven` the raw times matched the
   labels to within 17 ms, and it moved them by 210 ms. Rule: do not shift a clip that already
   matches (threshold 0.65).
6. **A parsing optimisation hung the tab.** Parsing "only the neighbourhoods of found places"
   on a changing scene spawned a hundred slots per search frame. Dropped entirely.
7. **The magazine size on tied frequencies** was chosen differently in Python and TypeScript.
   Caught by cross-checking on `sg553`: 19 versus 30.
8. **The scorer counted marks of uncovered clips**, i.e. it measured what the product would
   not show.

---

## Checked and REJECTED by measurement

Do not go there a second time.

| what | result |
|---|---|
| offset search over the probability curve instead of candidates | 65.8 versus 68.7 recall |
| candidates narrow the choice, the curve picks within | won on average by shifting clips that provably must not be shifted |
| offset from the first shots of bursts | on the `m4a4` anchor gave +215 ms against a proven +70 |
| strict one-to-one counting when fitting the offset | 2 clips better, 3 worse |
| limiting the offset to the inter-shot interval | 1 clip better, 3 worse |
| filtering out "jittery" series (up-down by one) | 2 clips worse, none better |
| "returning to an abandoned level is a weapon switch" | 74.5 versus 78.4; `xm1014` from 100% to 10% |
| reserve ammo as a weapon-switch cue | NOT rejected: our reader picks it up on 3 clips out of 19, but it is in the frame on 8 out of 10 — a reading shortfall, not a lack of material |
| dropping the global offset altogether | 73.6 versus 78.4 |
| systematic offset of ShotNet candidates | there is none: over 457 pairs the median is +2 ms |

---

## A method limit you need to know

**Reserve ammo: the material is there, the reader does not reach it.** The idea is good: the
"magazine + reserve" pair distinguishes all three events by itself — on a shot the reserve does
not change, on a reload it decreases, on a weapon switch both change. That is exactly the
external cue the weapon-switch rule lacks, and it needs neither OCR nor a new region.

The measurement went in two steps, and the first gave the right number for the WRONG reason.

Step one, by slot lists: a right-hand neighbour resembling the reserve exists on `m249`
(200..208), `sawedoff` (30..90) and `xm1014` (6..32) — three clips out of nineteen. That
suggested the conclusion "there is no material".

Step two, by the frames themselves, refuted it: the reserve IS PRESENT in the frame on eight
of the ten clips viewed. It is our parsing that does not pick it up. Glyph heights on the HUD
row: on `m249` the magazine is 31 px, the reserve 14 px, and it is found; on `m4a4` and `ak47`
the magazine is 24 px and the reserve is not found at all. Our lower bound for glyph height
is 0.010 of the frame height, i.e. 12.8 px at 1280 — the reserve digits clear it by only ten
percent. On top of that the reserve is drawn grey, not white, and does not always reach the
brightness threshold of 190.

So the direction is NOT closed: this is work on reading (the height lower bound, the threshold
for this region), not an absence of signal. The price is more junk places and slower parsing.

**The weapon name** is in the frame on five clips out of ten ("AK-47 / Fire Serpent",
"StatTrak™ M4A4", "Glock-18", "Dual Berettas", "Souvenir AK-47"), while `bizon`, `five_seven`,
`m249` and `mag7` do not have it — the layout lacks it. Reading the text is not needed: it is
enough to notice that the region's mask changed. But the coverage is half that of the reserve.

**A weapon switch is indistinguishable from shooting on a single series.** On `ssg08` the
player takes out the pistol after almost every shot: the sniper rifle goes 10-9-8, and between
shots the value jumps to 12 and back, and every return reads as a burst of three. The rule
"returning to an abandoned level is a weapon switch" was written and rejected by measurement:
a shotgun reloads ONE SHELL AT A TIME (3-4-5-6-7), so every level is abandoned for it, and
real shots going down through them get swallowed. They can only be told apart by an external
cue — the weapon-switch sound or reading the weapon NAME from the HUD.

**The clip's global offset is reliably determined only for sparse fire.** In a burst with a
90–100 ms step the offset is NOT IDENTIFIABLE from audio in principle: both series are periodic
with the same period, and an offset of one shot is indistinguishable from the truth.

Proven on `g3sg1`: the series there is nearly perfect (20-19-18-17-16, then down to 9, reload),
but the offset sweep over candidates peaks at +220 ms, while the true offset from the labels
is +94 ms. At zero offset 13 events out of 17 already hit some candidate — but not their own.
Hence 7% recall, and audio cannot fix it.

---

## Labels: 22 clips relabeled by a human

The trigger was the cross-check against the counter (`python/tools/audit_labels.py`): it
compares the labels with the game's readings BY SHOOTING EPISODE rather than by individual
marks, because the counter reliably knows the NUMBER of shots, but the moment only to within
a frame.

Own shots went 761 → 710. The biggest correction was `kyousuke`, 74 → 43: in three consecutive
episodes about twice as many shots were labeled as the game deducted (checked pixel by pixel,
frame by frame).

**Corrections went both ways**, i.e. the labels were not fitted to the counter. On `ak47` the
count did not change at all, but 15 marks were moved in time — and the report says nothing
about timing, there was no hint there. This is also the best evidence that the counter works:
recall on `ak47` rose from 67% to 100% from one relabeling.

The labeler was changed along the way: **mark snapping was removed** (it pulled towards the
loudest sample, which in a burst is the tail of the previous shot), and 0.1x speed and a fine
seek step on `Alt`+arrows were added.

### Second wave, 31 August: nine clips the first one missed

The first wave covered 22 clips, but **the sets "relabeled" and "counter readable" do not
coincide**, and they must not be confused: 18 readable plus 4 unreadable were relabeled, and
nine readable ones kept their manual marks. The consequence for any split of the corpus into
"clean labels versus dirty": splitting by the `covered` flag is WRONG.

The second-wave tool is `pnpm exec tsx eval/ammoAudit.ts`, the same per-episode report, but on
the PRODUCT reader. The Python `audit_labels.py` must not be used: it reads
`python/out/clips.json`, which is six changes behind, including the `ssg08` slot fix.

Of the nine, two needed corrections. The main one is `g3sg1`: the marks were late, the median
"counter minus mark" was −94 ms, it became −3 ms, counter recall **7% → 50%**. With a 50 ms
tolerance a 94 ms lateness is a miss by construction, i.e. the detector was penalised for
working correctly. The direction of the correction is confirmed independently: marks are
placed by the audio waveform, and the counter knows nothing about it.

**Two holes in the report itself**, both visible in its header:

1. A shot whose counter drop fell into a pause between episodes goes to no one. Because of
   this `my-skills`, `scar20` and `donk` looked like "extra marks", although the sum of the
   series' drops over the clip matches the labels exactly. **Check the per-clip sum, not only
   the episodes.**
2. The read rate per episode is unknown — the browser run does not save the read segments.

### A drop of exactly 3 — swallowed frames, not a burst

Found on `donk` during the analysis above. The series goes `4.93:9 → 5.13:6 → 5.27:7 → 5.43:6`,
and `MAX_STEP = 3` lets such a drop through: it is not "more than three". The real sequence was
9→8→7→6, the reader swallowed two frames. Three events landed at 5.11, 5.12, 5.13 — three shots
in twenty milliseconds, which no weapon can do.

The threshold lives in two places: `python/tools/audit_labels.py` and the product
`src/domain/detection/ammo/events.ts`. How many such places there are in the corpus is not
measured.

---

## How to run all of this

```bash
# python pipeline
pnpm exec tsx eval/frameTimes.ts            # frame timestamps (one-off)
pnpm exec tsx eval/audioCandidates.ts       # audio candidates (one-off)
python3 python/tools/run_clips.py     # -> python/out/clips.json
pnpm exec tsx eval/ammoScore.ts

# product pipeline
pnpm exec tsx eval/ammoPrep.ts
pnpm dev                           # then /eval/ammoBrowser.html, ~9 minutes
pnpm exec tsx eval/ammoScoreBrowser.ts
pnpm exec tsx eval/ammoCompare.ts           # cross-check of the two implementations

# alignment fitting — seconds instead of nine minutes
pnpm exec tsx eval/ammoRealign.ts --sweep

# cross-check of the ported logic on shared series
pnpm exec tsx eval/ammoPortCheck.ts         # currently 20 of 20

# cross-check of labels against the counter
python3 python/tools/audit_labels.py
```

The `ammoBrowser.html` page restarts on vite hot reload — if you edit code during a run, the
result will be partial. Check the number of records in `eval/.cache/ammoBrowser.json`.

---

## Rules whose violation breaks the work

Everything in `docs/HANDOFF-detection.md` still holds. Plus three new ones:

**Cross-check two implementations by DECISIONS, not by the number of marks.** I once compared
only list lengths, saw a match and missed that the times diverged. Because of that the
frame-rate bug survived an extra round.

**Analyse a rejection from data, not from a guess.** `AmmoResult` and `AmmoRejection` carry the
list of found places with position, frame share, read share, range and score, as well as the
reading series itself and the moments BEFORE alignment. Without this every analysis came down
to guesswork.

**Do not fit the labels to the counter.** The counter makes mistakes too. If you correct marks
from the cross-check report, verify by ear, and treat the counter's number as evidence, not a
verdict.

---

## What to do next

1. **Clusters and lateness on `ssg08`.** The slot is now correct, but the marks are not: three
   marks instead of one shot and 40-70 ms lateness. This is the last thing standing in the way
   of the clip with weapon switches.
2. **Show the user which path produced the marks.** The quality difference between the paths
   is large (82.0 versus 62.0 F1 against the motion scheme, as of 31 August), and right now all that is visible is that the slider has
   somehow become disabled.
3. **A labeling factory.** The only approach to the 26 clips without a counter: use it to label
   other people's recordings in batches and train the audio stage on that — it is the only
   stage that transfers between videos. A big job.

What NOT to do: measure coverage on 16:9 recordings. The user confirmed that the target input
is vertical shorts, and in them the bottom HUD row is cropped by someone else's edit. 42%
coverage is the ceiling set by the cropping, and there is nothing more to gain there.

What NOT to do: chew on `g3sg1` — it hits the method limit above.

---

## Reserve ammo: how it ended (27 August 2026)

**The weapon-switch cue shipped to `main`** (`MIN_RESERVE_READ_RATE` in
`src/domain/detection/ammo/detectWithAmmo.ts`). The slot-selection use lived on the
`ammo-reserve` branch, which was NOT merged (see below and the journal note "Reserve ammo as a
slot-selection feature — closed"). The reserve is read and used for exactly one thing: telling
a weapon switch from a burst. As a slot SELECTION cue it was checked and rejected — see below.

### What works and is in production

On a shot the reserve STAYS PUT, on a weapon switch it changes together with the magazine: on
`ssg08` the sniper rifle is `9 | 90`, the pistol `12 | 24` — checked on frames.

Three conditions, without each of which the change broke other clips, and all three were found
by measurement:

1. **Slot selection uses UNFILTERED events.** The winner is determined by the number of drops
   confirmed by audio; if weapon switches are removed before selection, the slot loses the
   contest to one that never had them — and `ssg08` again picked the tournament scoreboard.
   The cleanup is applied to the WINNER.
2. **Cleanup only with an independent weapon-switch cue** — a low share of small drops
   (`switchLike`) plus a reliably readable reserve. Without this, reading noise ate real shots
   where the weapon was not switched: `ak47` 20 -> 18, `bizon` 60 -> 56, `m249` 90 -> 88.
3. **The reserve must hold for three reads on both sides of the transition.** A single
   classifier miss must not look like a weapon switch.

Result: exactly one clip out of 45 changed. `ssg08` moved from the scoreboard (0.48, 0.19) to
the real counter (0.83, 0.81); with a 100 ms tolerance its recall went 25% -> 75%, across the
corpus 89.6 -> 90.0.

### Checked and REJECTED

- **The pair invariant in slot selection** (`ammo-reserve`, not merged into `main`). Confirmed
  on 3 clips out of 20, and none of them needs it: confirmation is only possible through
  conservation of the sum on reload, while "the reserve holds on a shot" distinguishes
  nothing — a constant number on the right holds trivially; real slots get 16/16 and 34/34,
  but the scoreboard gets 8/8 too. On `ssg08` there is no reload at all. The price, meanwhile,
  is real: the pass is 1.72 times more expensive.
- **The penalty "the neighbour did not respond to a rise"**: knocked `m249`, `m4a4`, `scar20`
  out of coverage entirely, F1 80.7 -> 70.0 (27 August baseline). The reserve is read on only 38% of frames, and
  "did not respond" more often means "was not read".
- **The clue "on an implausible jump the reserve changed too"**: for real slots it is almost
  always 0, for impostors it can be 2 and 8.
- **The weapon name from the HUD.** To the eye the signal is unambiguous (`SSG 08` <-> `USP-S`
  exactly on the counter jumps), but a cheap pixel signature of the box does not isolate it:
  the HUD is semi-transparent, the noise of the passing scene outweighs the text. On clips
  WITHOUT weapon switches there are just as many false triggers — `m4a4` 20, `xm1014` 15.
  Thresholds 190/215/235 and temporal smoothing were swept. The letters need to be read, and
  that is days of work. Tool: `python/tools/weapon_name_probe.py`.
- **Forbidding a burst that does not fit the weapon's physical fire rate** (75 ms per shot).
  Breaks real bursts: on dense clips the readings stick, several shots collapse into one
  transition, and a drop of 3 between neighbouring frames is legitimate there.

### The readability limit: digit height

Whether the counter is read depends not on where the image came from but on SIZE. The height
of the magazine digit on all clips where it works:

| px | clips |
|---|---|
| 14 | `ssg08` |
| 17-18 | `scar20`, `magixx` |
| 23-26 | `kyousuke`, `mag7`, `ak47`, `m4a4`, `donk-5100`, `dual-berettas`, `g3sg1`, `xm1014` |
| 31-37 | `five-seven`, `sawedoff`, `m249`, `my-skills`, `nova`, `mp5sd`, `r8` |

And where it does not: ESL Katowice 9-11 px, BLAST 6-9 px.

**The threshold lies between 11 and 14 pixels.** Below it SEGMENTATION falls apart: gaps
between characters become 1-3 px and stop being distinguishable. Measured on `3-kill`,
frame 117: glyphs `1@7 3@12 /@20 1@27 15@31`, gaps `1, 2, 2, 1` — the gap inside a number
(1 px) and the gap before the separator (2 px) are indistinguishable. There is nothing to tell
where the magazine ends.

The second consequence of size: a digit is 4-6 px wide, and one edge pixel is 15-25% of its
mass. The panel is semi-transparent, a webcam moves behind it, edge pixels flip from frame to
frame — one and the same "13" gives a distance to the prototype from 0.19 to 0.40 against a
threshold of 0.22, median 0.366.

**Averaging the mask over time does NOT help** — checked on `3-kill` with a median over a
window of 1, 3, 5, 9, 15 and 21 frames: exactly 37 read frames out of 389 for any window, and
only SINGLE-DIGIT values are read. The jitter is not random but tied to the content behind
the panel.

The coincidence "the native HUD is readable, broadcast graphics are not" is not a definition
but a consequence: the game draws the HUD large, for the player, while the broadcast inserts
the counter into a card the size of a postage stamp. `ssg08` and `kyousuke` are broadcasts
too, but in them the native counter survived the cropping, and it is readable.

---

### Tournament layouts: why the counter is not readable there

Three clips in the corpus show the counter not in the native HUD but in a tournament overlay:
ESL draws `13 / 115` in a card with a webcam (`3-kill`), BLAST draws `11/90` in a backdrop
under the player (`aug`).

**BLAST does not and will not give in.** Digits are 6-9 px, about twenty filled pixels per
character. "1", "7" and the slash are nearly indistinguishable at this size: this is not a
threshold question but an absence of information in the glyph.

**ESL hits three things in a row**, and the first two can be removed:

1. The separator is a SLASH. In the native HUD it is a thin bar with an aspect ratio of about
   0.1; it fails the shape check and drops out, leaving a gap. The slash (5x9, ratio 0.56,
   fill 0.33) passes as a digit and joins `9 / 115` into a chain of five glyphs, and such a
   chain is thrown away entirely.
2. Digits of 9-11 px cannot give rise to a frame place: the `SLOT_MIN_GLYPH_HEIGHT` threshold
   is 12.8 px.
3. Even with the first two removed, the series is read on 17% of frames.

**Checked and REJECTED by measurement** (the branch was not kept, everything is in commit `1b4d0d5`,
"a leaky counter is clearly worse than the previous scheme" — the message is in Russian):

- splitting a long chain at the widest gap;
- separate frame places for small numbers, apart from large ones;
- relaxing the classifier threshold for small glyphs.

Together they raised coverage from 19 clips -> 22. But all three new clips do WORSE with the
counter than with the previous scheme: `mp7` 15.4 versus 74.6, `biguzera-backstabs` 32.6
versus 41.7 (`biguzera-stops` 52.2 versus 44.2 — the only one where the counter is better).
On top of that `g3sg1` gained an extra place that won selection, F1 6.5 -> 4.8, and the pass
became 1.2 times longer. Corpus total 80.7 -> 79.7 (27 August baseline).

The conclusion worth remembering: **a leaky counter is not "better than nothing", it is worse
than the previous scheme.** Hence `MIN_READ_RATE = 0.9` in `detectWithAmmo.ts` — a counter
read on less than 90% of frames clearly loses to motion (the video stage of the time). The split across the corpus is
perfect: all working counters have a rate of 0.97..1.00, broken ones 0.57..0.80. On the
current corpus the gate is neutral and costs one comparison per slot; it insures against
unfamiliar videos.

---

### What the reserve did NOT fix

The clusters of three marks on `ssg08` remain: 1.40/1.41/1.42 and 3.07/3.08/3.08 against labels
1.00 / 3.03 / 5.35 / 8.12. Plus the marks there are 40-70 ms late — they fall within 100 ms
and miss 50. That is the next question.

### Reserve reading thresholds

The reserve is drawn half the size of the magazine: 11-15 px versus 24-37 px.

- Glyph height 0.010 -> **0.006** of the frame. Detection of the right-hand group 22% -> 38%
  of frames.
- Classifier distance for the NEIGHBOUR 0.22 -> **0.28**. Reserve digits give 0.208-0.284,
  i.e. they were recognised correctly and rejected by the threshold: a 7x12 glyph is stretched
  to a 16x24 cell and gets stair-stepped edges. `ssg08` 37 -> 152 frames out of 186.
- **Separate joining.** When the small glyphs were let into the common joining, they got in
  between the digits of large numbers and broke them apart: coverage 19 -> 17 clips,
  F1 79.2 -> 61.4.
- Checked and rejected: comparing a small glyph in a SMALL cell. More frames are accepted, but
  the WRONG digits are read — 38, 56, 98 instead of 90.

Reach: the reserve is in the frame on 14 clips out of 19. On `nova`, `r8`, `mp5sd` the counter
is pressed against the right edge (x ~ 0.96-0.98), and the reserve, which sits to the right of
the magazine, has gone out of frame.

Exploration tools: `python/tools/reserve_probe.py`, `python/tools/reserve_invariant.py`.

### Old state of the branch (for history)

Branch **`ammo-reserve`**, three commits, NOT merged into `main`, and there is no need to merge it.

**Why it is needed.** Not for the digits themselves, but for an invariant that neither the
scoreboard, nor the timer, nor health can fake:

    shot           magazine −1..−3, reserve STAYS PUT
    reload         magazine up, reserve down BY EXACTLY THE SAME AMOUNT
    weapon switch  both change, nothing is conserved

Confirmation must go by CONSERVATION on reload, not by holding on a shot: a constant number on
the right holds trivially on every shot, and that is exactly how the scoreboard on `ssg08`
scored 8 out of 8, beating the real counter.

**What it fixes.** On `ssg08` the real counter sits at the bottom right, is read on 100% of
frames, range [0,12] — and is REJECTED by the `MIN_SMALL_STEP_RATIO` rule, because the player
jumps between the sniper rifle (10) and the pistol (12) and 45% of the drops come out large.
The scoreboard at the top of the frame wins with a score of 0.91. This is the only clip out of
19 where a slot in the upper half of the frame is chosen.

**Two thresholds that prevented reading the reserve were found and measured.**

- Glyph height: the reserve is 11–15 px versus 24–37 px for the magazine, the threshold was
  0.010 of the frame height. Lowering it to 0.006 doubles detection of the right-hand group
  (22% of frames → 38%).
- Classifier distance: reserve digits give 0.208–0.284 against a threshold of 0.22, i.e. they
  were recognised CORRECTLY and rejected by the threshold. The reason is that a 7×12 glyph is
  stretched to a 16×24 cell and gets stair-stepped edges. With 0.28 for the neighbour only:
  `ssg08` 37 → 152 frames out of 186, stable 90 on 78%; `ak47` 145 → 159 of 160; `m4a4`
  203 → 213 of 213.

**Checked and rejected:** comparing a small glyph in a SMALL cell. More frames are accepted,
but the WRONG digits are read — 38, 56, 98 instead of 90.

**A rake already stepped on.** The lowered threshold let small glyphs into the common joining,
they got in between the digits of large numbers and broke them apart — coverage 19 → 17 clips,
F1 79.2 → 61.4. Fixed by separate joining (`af774a0`): frame places are collected only from
large glyphs, neighbours are searched in a separate pass. **This fix is NOT VERIFIED BY
MEASUREMENT — the run was interrupted.** The first thing to do when returning to the branch.

**Reach.** The reserve is in the frame on 14 clips out of 19. On `nova`, `r8`, `mp5sd` the
counter is pressed against the right edge (x ≈ 0.96–0.98), and the reserve, which sits to the
right of the magazine, has gone out of frame.

Exploration tools: `python/tools/reserve_probe.py` (reserve readability per clip),
`python/tools/reserve_invariant.py` (whether the pair tells the real counter from impostors).
