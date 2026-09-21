# 0001. Feature-based code layout

Date: 2026-09-17
Status: accepted

## Context

`src/` is organized by file type: `components/`, `pages/`, `hooks/`, `store/`, `lib/`.
`lib/` holds about 30 files and four subfolders mixed together: detection, audio, video, export.
The first features are already built around a scenario (`feedback/`, `wizard/`), the rest are not.
The architect agent needs one target structure, otherwise the layout gets reinvented
in every task.

## Options

1. **FSD** (`app / pages / widgets / features / entities / shared`). Strict rules,
   checked by a linter. Heavy for a project of this size, and the bulk of the code —
   detection without UI — fits naturally into none of the layers.
2. **Feature-based layout**: `app / pages / features / domain / shared`. Continues what
   was already started in `feedback/` and `wizard/`; detection lives entirely in `domain/detection`.
3. **Leave it as is** and write down the rules. Doesn't fix the dumping ground in `lib/`.

## Decision

Option 2. The structure and the import rule are in `.claude/agents/architect.md`, section
"Architecture". In short: dependencies go only downward
(`app → pages → features → domain → shared`), features don't import each other and
are exposed to the outside through `index.ts`.

## Consequences

- New code goes straight into the target structure.
- Old code is moved in parts, one feature or domain at a time, each move with its own plan and ADR.
- Until the move is finished, the old and new layouts coexist in `src/`.
- The import rule is checked automatically — see ADR 0002.
