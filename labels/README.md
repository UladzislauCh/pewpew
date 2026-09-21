# Reference shot labels

One `<slug>.json` file per clip from `examples/`. It holds only numbers and tags, so the folder
is committed — unlike the clips themselves and the decoded audio in `examples/.cache/`.

The files are created by the labeling tool: `pnpm dev`, then `http://localhost:5173/labeler.html`.
There is no need to edit them by hand, but the format is readable:

```json
{
  "version": 1,
  "clip": "donk 5100 ELO AIM.mp4",
  "slug": "donk-5100-elo-aim-429d5b23",
  "duration": 8.95,
  "sampleRate": 44100,
  "numberOfChannels": 2,
  "labeledAt": "2026-07-28T09:12:00.000Z",
  "notes": "музыка на фоне весь клип, ближе к концу взрыв гранаты",
  "complete": true,
  "shots": [
    { "time": 1.234, "source": "own", "weapon": "ak47", "hard": false }
  ]
}
```

- `source` — `own` (the player's own shot: loud, centred) or `enemy` (someone else's: quieter, panned).
- `weapon` — an id from `src/domain/detection/weapons.ts`, or `null` if it can't be told by ear.
- `hard` — the shot is buried under noise, music, an explosion or overlapping gunfire. A separate
  recall is computed over this tag, so the overall score can't hide a regression on the cases
  that matter most.
- `complete` — while `false`, the clip takes no part in evaluation: to the scorer, a partly
  labeled clip looks like a solid run of false positives.

The `notes` field is free text written while labeling ("background music throughout, a grenade
explosion near the end" in the example above) and is kept in the language it was written in:
it is labeling data, not documentation.

The schema and its parsing are in `src/domain/detection/labels.ts`; the whole pipeline is
described in `eval/README.md`.
