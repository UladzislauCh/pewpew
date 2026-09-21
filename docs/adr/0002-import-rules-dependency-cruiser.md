# 0002. The import rule is checked by dependency-cruiser

Date: 2026-09-17
Status: accepted

## Context

ADR 0001 introduced the dependency direction `app → pages → features → domain → shared`.
Checking by review doesn't work: there is no one to review. The architect sees only its own moves,
the other agents don't check themselves, and a violation is a single import line that is easy
to miss by eye.

## Options

1. **dependency-cruiser** — "from → to is forbidden" rules by path, understands TS,
   dynamic `import()`, cycles; a single dev dependency.
2. **oxlint `no-restricted-imports`** — already installed, but the rules match import
   string patterns, not direction; "not a neighboring feature" is awkward to express and
   is bypassed with relative paths.
3. **ESLint + eslint-plugin-boundaries** — precise, but a second linter alongside oxlint.

## Decision

Option 1. Config `.dependency-cruiser.cjs`, command `pnpm check:deps`, which is also part
of `pnpm build` before `vite build`: a violation breaks the build, no matter who introduced it.

Rules: `shared` imports only `shared`; `domain` doesn't import upper layers,
React or the store; a feature doesn't import another feature; from outside, a feature is
reachable only through `index.ts`; cycles are forbidden.

## Consequences

- Only the folders of the new layout are checked. Old files don't break the build until
  they are moved.
- Agents run `pnpm check:deps` before reporting "done"; the architect — after a move.
- Test files are excluded from the check.
