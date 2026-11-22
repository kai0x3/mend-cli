# mend — one patch tool for every AI edit format

[![make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/kai0x3/mend-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/kai0x3/mend-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

My entry for the make.fun bounty
[hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122),
"Build mend, one patch tool for every AI edit format".

## What it does

AI coding tools write their edits in four different formats, and each tool's
output is only as good as the program that applies it. `mend` is a single
command-line tool that reads a patch in any of the four and applies it to a
tree of text files, exactly as `SPEC.md` (version 1) specifies:

- **unified diffs**, including hunks whose line numbers are wrong — the hunk
  is placed by content, nearest to where its header claims it belongs;
- **SEARCH/REPLACE blocks** (the `<<<<<<< SEARCH` / `=======` /
  `>>>>>>> REPLACE` form);
- **V4A patches** (`*** Begin Patch` … `*** End Patch`, with Add / Delete /
  Update File sections, `@@` anchors, `*** Move to:` and `*** End of File`);
- **JSON edit lists**, as one array or as JSON Lines: `create`,
  `str_replace` and `insert` tool calls.

Every edit in a patch applies, or none of them does: mend works on an
in-memory copy of the tree, reports each failed edit with its reason, and
only writes to disk when the whole patch succeeds.

## How it matches

Formats that name old lines look them up at the first of three tiers that
matches: exact lines, then lines equal up to trailing blanks, then lines
equal up to surrounding blanks — with replacements re-indented to the file's
own indentation at the loosest tier. `--strict` turns the fuzzy tiers off.
Context lines are always written back as the file's own lines, never as the
patch spelled them.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is a patch file, or standard input when it is absent or `-`.
`--format` is one of `unified`, `search-replace`, `v4a`, `json` or `auto`
(the default, which detects the format). `--check` reports what would change
without writing anything.

Exit codes: `0` with one line per changed file (`A`/`M`/`D`/`R old -> new`)
and an `ok: <n> files` summary; `1` with one `error: <code> <path>` line per
failed edit and a `failed: <k> of <n> edits` summary; `2` with a single
`error: usage` / `error: no-patch` / `error: format` / `error: parse <N>`
line. The full contract is `SPEC.md`.

## Files

- `main.ts` — the tool itself (Node 22, standard library only). With
  `MAKEFUN_ENV_URL` set it hands over to the trial runner, as the kit's
  starter does.
- `runner.ts`, `check.ts`, `SPEC.md` — the kit's runner, practice checker
  and specification, kept as the kit ships them.

## License

MIT — see `LICENSE`.
