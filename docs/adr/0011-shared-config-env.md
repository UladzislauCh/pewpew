# 0011. The shared/config module for environment variables

Date: 2026-09-21
Status: accepted

## Context

The repository is being prepared to go public. Two identifiers are hardcoded:

- `WEB3FORMS_ACCESS_KEY` in `src/shared/feedback/web3forms.ts` — the feedback form;
- `G-EBPQ2GCRM5` in `index.html` — Google Analytics, the script loads unconditionally,
  so visits in `pnpm dev` are also recorded in the production statistics.

Both values are public by nature: Vite inlines `VITE_*` into the bundle, and the GA script
is visible on the live site anyway. Moving them into environment variables doesn't make them secret
and doesn't remove them from 232 commits of history. The goal is different: so that the public repository
doesn't contain personal identifiers, and so that a fork doesn't send email to someone else's address
or pollute someone else's analytics.

Paid Web3Forms protection (hCaptcha, domain binding) is unavailable: the subscription is free.
The worst-case damage from an exposed key is the quota of 250 emails a month, fixed by rotating the key.

## Options

1. **Read `import.meta.env` in place** — in `web3forms.ts` and in the entry point.
   Fewer files, but knowledge of the bundler spreads across layers: `eval/` and `scripts/`
   run outside Vite, and any such read trips there.
2. **Substitute `%VITE_GA_ID%` directly in `index.html`.** Vite can do this, but with an empty
   variable the literal stays in the markup, and the request to googletagmanager still goes out.
   "No key — no analytics" can't be expressed this way.
3. **A single module `src/shared/config/env.ts`** — the only place that reads
   `import.meta.env`, exposes ready values.

## Decision

Option 3. `src/shared/config/` is created with `env.ts`, which reads
`VITE_WEB3FORMS_KEY` and `VITE_GA_ID` and exports them as plain constants.
Nothing else in `src/` accesses `import.meta.env` for these values.

The module lives in `shared` because it's used both by a feature (`features/feedback`
via `shared/feedback`) and by the entry point (`app`). The import rule doesn't change:
`shared` still depends only on `shared`.

GA moves from `index.html` into `src/app` and is initialized only when the
identifier is non-empty.

Related, outside this ADR: `.env.example` in git with empty values,
`.env.local` outside git (`*.local` is already in `.gitignore`), `src/vite-env.d.ts`
with the `ImportMetaEnv` types — the project doesn't have it at all.

## Consequences

- The values remain visible in the bundle. This is deliberate: `.env.example` and the header of
  `env.ts` should state plainly that they are public and not a secret.
- Building on a server: `.env.local` must be there **before** `pnpm build` —
  substitution happens at build time, not at run time.
- An empty form key should produce an honest "didn't get through", not a silent failure:
  `isAccessKeyConfigured` is simplified to an emptiness check.
- Analytics stops recording visits from development.
- Content edits are not the architect zone:
  - `env.ts`, `.env.example`, `vite-env.d.ts` — `utils`;
  - `web3forms.ts`, GA initialization in `src/app`, the `botcheck` honeypot field
    in the form — `ui`.
