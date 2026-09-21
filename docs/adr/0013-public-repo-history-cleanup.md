# 0013. Public repository: the contents of `.claude/` and history from scratch

Date: 2026-09-21
Status: accepted

## Context

The repository goes public so that the author's level can be judged by it. No third-party
materials and nothing personal must leak out.

**Third-party skills.** `.claude/skills/` has eight skills, seven of them third-party, from `claudekit`:

| skill | size | license | used by |
|---|---|---|---|
| `video-analysis-optimizer` | 8 KB | own | `detection.md` |
| `ui-ux-pro-max` | 3.7 MB | none | `ui.md`, `design.md` |
| `design` | 316 KB | MIT | `design.md`, `ui.md` |
| `design-system` | 240 KB | MIT | nobody |
| `ui-styling` | 204 KB | MIT + LICENSE.txt | nobody |
| `brand` | 128 KB | none | nobody |
| `slides` | 32 KB | none | nobody |
| `banner-design` | 20 KB | MIT | nobody |

`brand`, `slides`, `ui-ux-pro-max` have no license — they can't be distributed,
neither in history nor in the current commit. Five of the eight aren't mentioned by any agent.

**History.** 187 MB in `.git`, 240 commits, 183 of them with `Co-Authored-By: Claude`.
History contains old model weights (~76 MB), third-party skills and the exposed Web3Forms key.
There's nothing secret in it — all blobs and every path ever added were checked:
no `.env`, no private keys, no personal media.

## Options

1. **`git filter-repo`**: scrub the skills and old weights from history, keeping the
   240 commits. History as proof of the process remains; size ~110 MB.
2. **Leave history as is**, clean only HEAD. Unlicensed third-party code
   remains published — unacceptable.
3. **History from scratch**: one commit, no past at all.

## Decision

Option 3, by the user's decision.

The price was named and accepted: 240 messages like
"fix(eval): event metric corrected against 40 by-ear verdicts" are lost — that is, the visible
part of the engineering process — `git blame` stops working, and the activity graph
on GitHub shrinks to a single point. In return — a guarantee by construction: nothing can leak
from the past, because there is no past.

The order is the reverse of the usual one: **first the contents of the working tree, then wiping history.**
A squash by itself doesn't fix the contents of HEAD.

1. Only our own `video-analysis-optimizer` stays in `.claude/skills/`; the seven third-party ones
   go into `.gitignore` and live on disk — Claude Code reads `.claude/` from disk,
   the agents keep working.
2. Heavy artifacts the product doesn't need are removed from HEAD: `model/` (105 MB,
   weights of four generations) and `public/models/flashNet640.onnx` (44 MB, not
   mentioned in `src/` — the product loads `flashNet416.onnx`, see
   `src/domain/detection/flash/warmup.ts`). `flashNet416.onnx` stays: the app
   doesn't work without it.
3. `.gitignore` is extended before history is dropped, otherwise the junk returns with the very first commit.
4. `rm -rf .git && git init && git add . && git commit` — a single commit.
5. Publication to a **new** GitHub repository; the old private one stays as is.

## Consequences

- The mirror backup `~/Projects/pewpew-backup-20260921.git` (187 MB) is the only
  place where the former 240 commits live afterwards. It must not be deleted.
- Copies outside the repository: `~/Projects/pewpew-assets/claude-skills` (4.6 MB),
  `~/Projects/pewpew-assets/model` (105 MB).
- The `model/**/best.pt` weights are no longer stored anywhere in git. If they're needed publicly —
  as a separate GitHub Release; artifacts are published by the main session.
- The commit is made by the user or the main session: agents don't commit.
- `.gitignore` is the `utils` zone. A line "external skills are not part of the repository"
  is needed in `README.md` and `CLAUDE.md`.
- `git filter-repo` won't be needed, there's no need to install it.
