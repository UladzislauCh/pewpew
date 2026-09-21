# pewpew

A browser toy: it finds gunshots in CS2 clips and replaces their sounds with meme sounds.
Production is pewpew.baby only; there are no server functions — analysis and export run in the browser.
Stack: React 19 + TypeScript + Vite, react-router, zustand, i18next; Vitest; Python for
research and model training.

## Language

- **Talk to the user in Russian** — replies, questions, reports, lists of what to check by hand.
- **Everything in the repository is in English** (ADR 0012): code comments, test names,
  docs, ADRs, commit messages. Exceptions: the Russian locale `src/shared/i18n/locales/ru*`
  and the `notes` field in `labels/*.json`.

## Agents

Work is split into zones. Each zone is owned by an agent in `.claude/agents/` — its rules,
boundaries and workflow live there. Hand a zone's task to its agent; for a task spanning
several zones, the main session splits it and coordinates.

| agent | zone | model |
|---|---|---|
| `architect` | module structure, store slices, routes; file moves, ADRs | Opus |
| `detection` | detection: audio, flash, motion, ammo counter, fusion, models, Python | Opus |
| `eval` | metric, labels, by-ear verdicts, clip corpus, labeler | Opus |
| `tests` | unit tests (DOM-free logic only), build integrity | Sonnet |
| `ui` | components, styles, pages, wizard, i18n, accessibility | Opus |
| `utils` | audio, video, export, shared utilities, build scripts and configs | Sonnet |
| `design` | mockups, brand graphics, tokens, screen copy | Opus |

Key boundaries:

- Only `tests` writes tests.
- Only `eval` changes the metric and the labels, and only on the user's by-ear verdict.
- Only `architect` moves files, following an agreed plan.
- A new screen gets a mockup from `design` first, then code from `ui`.
- The main session publishes artifacts: subagents have no access.

## Architecture

Feature-based layout: `app → pages → features → domain → shared`, dependencies point
downward only, features don't import each other. Details: `docs/adr/0001-feature-based-layout.md`.
The rule is enforced by `pnpm check:deps` (ADR 0002), which is part of `pnpm build`.
The migration is complete (ADRs 0003–0009): `src/` contains only `app`, `pages`, `features`,
`domain`, `shared` — no files remain outside the layers.

Structural decisions live in `docs/adr/`.

## General rules

- **A question is not an assignment.** If the user is discussing, discuss first — don't run
  measurements or write code.
- **Answer briefly:** the conclusion or proposal first, then the reasoning.
- **A verdict by ear and by eye outranks the metric and the labels.** Anything that changes
  what is heard or seen is confirmed by the user.
- **The user checks the interface by hand.** Don't test in the browser.
- **Send nothing** to external services for the sake of checking (forms, media).
- **Commit and push only when asked.** Agents don't commit.

Before saying "done":

```bash
pnpm exec tsc -b --noEmit
pnpm check:deps
pnpm test
pnpm build
```

## Documentation

| file | contents |
|---|---|
| `docs/HANDOFF-flash.md` | **most recent on detection**: muzzle flash, the production video stage |
| `docs/HANDOFF-ammo.md` | ammo counter |
| `docs/HANDOFF-detection.md` | the counter-free pipeline: motion, audio |
| `python/README.md` | the Python track and the rules for porting to TS |
| `eval/README.md` | all measurements, including negative results and verdicts |
| `docs/RESEARCH-journal.md` | research journal, closed directions |
| `docs/HANDOFF-design.md` | interface mockups: what's decided and what must not be touched |
| `docs/DEMO-recording.md` | spec for recording demos |
| `docs/PYTHON-track.md` | the Python track and the protocol for cross-checking implementations |
| `docs/adr/` | architecture decisions |

Current detection quality numbers live in the handoffs and `eval/README.md`, not here.

## Commits

```
feat|fix|perf|docs|chore(zone): what was done

- what changed and where
- why
- before/after measurement, if detection or the metric was touched
```
