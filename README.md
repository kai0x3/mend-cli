[![bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/kai0x3/mend-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/kai0x3/mend-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend

One patch tool for every edit format an AI model writes.

Models hand back their changes in four different shapes, and until now each
one wanted its own applier. mend is a single command-line tool that reads all
four and lands them on a tree of text files the same way:

- **unified diffs** — including the ones whose hunk headers point at the
  wrong lines; the hunk is placed at the occurrence nearest to where the
  header claims it belongs;
- **SEARCH/REPLACE blocks** — the `<<<<<<< SEARCH` / `=======` /
  `>>>>>>> REPLACE` form, with the file named on the line above the block;
- **V4A patches** — `*** Begin Patch` documents with Add, Delete and Update
  sections, anchored chunks, moves and end-of-file chunks;
- **JSON edit lists** — `create`, `str_replace` and `insert` tool calls, as
  one JSON array or as JSON Lines.

## How it decides where an edit goes

Each edit names some lines of the file it changes. mend looks for those lines
at the first of three matching tiers that finds them:

0. **exact** — every line identical;
1. **trailing whitespace ignored** — lines equal once trailing spaces and
   tabs are dropped;
2. **indent-blind** — lines equal once leading and trailing spaces and tabs
   are dropped, with the replacement re-indented onto the file's own indent.

Context lines are always written back as the file's own lines, never the
patch's spelling of them. `--strict` turns tiers 1 and 2 off.

## All or nothing

Edits run in the patch's order, each against the tree the earlier ones left.
A failed edit changes nothing itself, the edits after it still run, and every
failure is reported — but if anything failed, no file is written at all.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file; omit it (or pass `-`) to read the patch from
  standard input.
- `--format` is one of `unified`, `search-replace`, `v4a`, `json`; the
  default, `auto`, detects the format from the patch text.
- `--check` prints exactly what a real run would print and writes nothing.
- `--strict` matches lines exactly (tier 0 only).

On success mend prints one line per changed path (`A`, `D`, `M`, or
`R old -> new` for a move) in path byte order, then `ok: <n> files`. On
failure it prints one `error: <code> <path>` line per failed edit and a
`failed: <k> of <n> edits` summary. Usage, unreadable-patch, format and parse
problems print a single `error:` line of their own. The full contract is
[SPEC.md](SPEC.md).

## Layout

- `main.ts` — the tool itself; Node 22, standard library only.
- `runner.ts` — the make.fun kit's trial runner; `main.ts` hands over to it
  when `MAKEFUN_ENV_URL` is set.
- `check.ts` — runs the kit's public practice checks against `main.ts`.
- `SPEC.md` — the specification mend implements, from the kit.
