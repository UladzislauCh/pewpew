# 0012. English as the repository language

Date: 2026-09-21
Status: accepted

## Context

The repository is being prepared to go public: it will be read by employers, including
those who don't read Russian. Right now almost everything except the code is written in Russian:

| area | lines with Cyrillic | what it is |
|---|---|---|
| `src/` (excluding locales) | 2781 in 97 files | reasoning comments |
| `eval/` | 2975 in 91 files | research scripts |
| `python/` | 967 | model training |
| `docs/` | 3607 | handoffs, research journal, ADRs |
| `.claude/agents/` | 441 | agent rules |
| `README.md` | — | still the Vite template |

The comments here aren't labels on variables but a connected line of reasoning: why a request is sent
as a form rather than JSON; why the ACME check comes before the redirect. The value is in the reasoning,
and it's lost in a literal translation.

## Options

1. **Only `README.md` in English**, the rest as is, with an honest line
   "research notes are in Russian". Cheap, but opening any file in `src/`
   the reader runs into Cyrillic.
2. **Translate `src/`**, leave the lab (`eval/`, `python/`) and `docs/`.
   The showcase is readable, the amount of work is manageable — about 2800 lines.
3. **Translate everything.** Maximum consistency, but it's ~10,700 lines, of which
   6500 are experiment records that one person rereads.

## Decision

Option 3, by the user's choice: English becomes the language of the whole repository.

The translation is done **by hand, file by file, by the owning zone** — not by bulk replacement
and not by a machine run. Order of stages, each with its own run of
`tsc` / `check:deps` / `test`:

1. `README.md` in English — `design` writes the text, the architect provides the repository map
   and the architecture section.
2. `ui` moves the Russian strings hardcoded outside i18n into the locales: "Another clip"
   (`VideoPreview.tsx`), "Replace meme" (`AudioPreview.tsx`), the KB/MB units there as well,
   error messages in `WizardApp.tsx`. **This is done before translating comments**,
   otherwise user-facing text gets mixed up with technical text.
3. Comments in `src/` layer by layer, in separate passes: `shared` → `domain` →
   `features` → `app`/`pages`.
4. `eval/` — the `eval` zone; `python/` — the `detection` zone; `scripts/` — the `utils` zone.
5. `docs/` — handoffs and the research journal, each by its own zone.

## What is NOT translated

- `src/shared/i18n/locales/ru*` — this is the product's Russian interface, not comments.
- The `notes` field in `labels/*.json` — labeling data. Only `eval` may change it,
  and only on the user's verdict.
- Commit messages and the contents of earlier ADRs, as historical records, are not
  rewritten retroactively; new ADRs are written in English starting from the number
  following this one.
- `CLAUDE.md` and `.claude/agents/` — an open question, see below.

## Consequences

- The work is spread over many passes and will touch almost every file. There's no need to merge it
  into one branch as a whole: a stage = a separate commit, a zone = a separate task.
- Risk of bulk replacement: `src/` has Cyrillic outside comments (item 2 above).
  No `sed` over Cyrillic character ranges — only targeted edits with checks.
- `CLAUDE.md` and `.claude/agents/` are working instructions for the agents, and working with them
  happens in Russian. Translating them changes agent behavior and brings the reader almost
  no benefit. The decision on them is postponed: either keep them in Russian or exclude them
  from publication.

## Update 2026-09-21

Facts decided after this ADR was accepted; the text above is left as originally decided.

- `CLAUDE.md`, `.claude/agents/*.md` and the project's own skill were translated into English.
  Agents keep talking to the user in Russian (the "Language" section of `CLAUDE.md`).
- The earlier ADRs were translated too, at the user's request: the git history is being wiped
  (ADR 0013), so the ADRs become the only record. The translation keeps the original content,
  decisions, dates and statuses.
- Test names were translated. String literals (console output, error texts, the labeler UI)
  stay as they are.
