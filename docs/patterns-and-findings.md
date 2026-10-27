# Cross-project bug hunt: patterns and findings

Keeping a bug found in one project as a question asked of every project, and the fail-closed rules for when an answer may be called confirmed or fixed. See [README](../README.md) for the quick start.


A bug found in one project is usually a question worth asking of every project. `pattern` and `finding` keep that question and its answers as a ledger instead of leaving them in a chat log.

A **pattern** is the reusable question. A **finding** is one project's answer to it. `sweep` runs the mechanical questions and files what it reproduces.

```powershell
sumi pattern add supabase-rls-off `
  --title "A public table has RLS disabled" `
  --question "Does every public table have row level security enabled?" `
  --origin "musubu:F014" `
  --severity high `
  --requires supabase `
  --check "node scripts/check-rls.mjs" --check-expect exit-zero --check-timeout-ms 30000

sumi pattern list
sumi pattern show supabase-rls-off
```

`--origin` records where the question came from and accepts only three forms, so every pattern stays traceable to something a reader can open: `<project>:<findingId>`, `record`, or `<path>#<anchor>`.

A pattern with a `--check` is `mechanical`; without one it is a `judgment` question that a reader has to answer by looking at the code. `--requires` limits a pattern to projects that use a given service (`supabase`, `vercel`).

Record what a given project turned out to be:

```powershell
sumi finding add northwind `
  --pattern supabase-rls-off `
  --title "public.orders has RLS off" `
  --source-kind agent --agent claude-code `
  --commit 0123456789abcdef0123456789abcdef01234567 `
  --files "supabase/migrations/0007_orders.sql" `
  --output "no ENABLE ROW LEVEL SECURITY for public.orders"

sumi finding list northwind
sumi finding show northwind F001
```

Every finding requires a commit: evidence that cannot be re-checked later is not evidence. Long output is truncated to 4096 characters and flagged with `truncated`, never silently dropped.

See the whole portfolio at once:

```powershell
sumi findings
sumi findings --pattern supabase-rls-off
```

```text
SUMI FINDINGS — 2 pattern(s) x 3 project(s)
============================================================================================
PATTERN                  SEV     hanami              northwind          musubu
--------------------------------------------------------------------------------------------
supabase-rls-off         high    n/a                 suspected (2)       unknown
unsigned-webhook         high    unknown             unknown             confirmed

unknown = not checked yet, or a required service is unregistered. n/a = a required service is recorded as unused.
clean = a sweep ran the pattern's check against a named commit here and did not reproduce it.
status (n) = n finding(s) recorded here; the status shown is the loudest one.
```

The table never leaves a cell blank. `unknown` means SUMI has no answer yet — including when a required service is merely **unregistered**, and including a sweep that could not run. `n/a` appears only when the project has explicitly recorded that service as `none`. An unregistered service is an open question, not an irrelevant one, and SUMI will not rewrite one as the other. `clean` is the one cell a sweep can write without a finding: a check that ran to completion against a named commit and did not reproduce the pattern. When several findings sit behind one cell, the loudest status is shown with the total count, so a `fixed` finding cannot hide a `suspected` one.

### Running the mechanical questions: `sweep`

```powershell
sumi sweep                                  # every mechanical pattern, every project
sumi sweep supabase-rls-off                 # one pattern
sumi sweep supabase-rls-off --project musubu
sumi sweep --dry-run                        # run the checks, write nothing
```

```text
SUMI SWEEP — 1 pattern(s) x 2 project(s)
========================================================================
PATTERN                  PROJECT        OUTCOME      FINDING   DETAIL
------------------------------------------------------------------------
service-role-in-client   clean          clean        —         @ 2922475d3bc8
service-role-in-client   leaky          reproduced   F001      confirmed @ 087231238d57

reproduced 1 | clean 1 | error 0 | skipped 0
```

`expect` describes what the check does on a project that does **not** have the problem. `exit-zero` (the default) suits an assertion script that exits 0 when all is well; `exit-nonzero` suits a `grep`-style detector that exits 0 when it finds the thing; `no-output` suits a linter that prints only its violations. A run that misses its expectation is the run that reproduced the finding.

Under `no-output`, output decides, because a linter usually exits non-zero when it has violations to report. Silence *and* a non-zero exit is the one case output cannot speak for, so it is treated as a check that died rather than a project that came back clean.

By default, `exit-nonzero` reads **every** non-zero exit as healthy. For a detector that uses a separate error code, register it explicitly. For example, `grep` exits 0 on a match, 1 on no match, and 2 on an execution error:

```powershell
sumi pattern add leaked-token --title "Token found in source" `
  --question "Does the source contain a token?" --origin record `
  --check "grep -R TOKEN src" --check-expect exit-nonzero `
  --check-error-exit-codes 2
```

`--check-error-exit-codes` accepts comma-separated integers from 1 to 255. These codes are evaluated before **all** expectation modes and produce `error`, never `clean` or a new confirmation. On an existing pattern, use `sumi pattern set leaked-token --check-error-exit-codes 2,3` to change only this policy or `--check-error-exit-codes none` to clear it. The check snapshot on a new confirmation includes the configured error codes. Existing patterns without this optional field retain their original meaning; the state schema remains 3.

A reproduction is filed as a `sweep`-sourced confirmation, which is the one route to R1(a). If an open finding for that pattern already exists it gains a confirmation.

What happens to a closed finding depends on what the closure was a judgment *about*:

- **`dismissed` / `not_applicable`** are judgments about the reproduction — usually that the check is wrong here. The code reproducing it again is exactly what the judgment anticipated, so the run is recorded as `suppressed` and the ledger is left alone. Without this, one imprecise check hands back a fresh `confirmed` finding on every single sweep, and dismissing it never sticks.
- **`fixed`** is a judgment about the code. A reproduction contradicts it, so a new finding is filed and the regression is visible rather than silently folded into the old record.

An open finding always takes precedence over a dismissed one for the same pattern.

The sweep is fail-closed at every point where it could invent an answer:

| Situation | Outcome | What is written |
|---|---|---|
| Required service unregistered | `skipped` | nothing — the check is not run at all |
| Required service recorded as unused | `skipped` | nothing — the cell is already `n/a` |
| No local path, not a Git worktree, or a **dirty worktree** | `error` | a sweep record only; the cell stays `unknown` |
| Check timed out, could not start, or died on a signal | `error` | a sweep record only; the cell stays `unknown` |
| Check ran, did not reproduce | `clean` | a sweep record; **no confirmation** |
| Check exited with a configured execution error code | `error` | a sweep record only; no finding or confirmation |
| Check reproduced, but a `dismissed` / `not_applicable` finding already answers the cell | `suppressed` | a sweep record only; the ledger is left alone |
| Check ran and reproduced | `reproduced` | a finding or a new confirmation, plus the sweep record |

A dirty worktree is refused because evidence is bound to a commit: a result produced from uncommitted edits is not reproducible from the commit that would be recorded beside it.

If a required service becomes unregistered after a clean sweep, the matrix returns to `unknown` and reports the setup gap. It retains the historical sweep record without using it to answer the now-unknown applicability. Recording the service as `none` still produces `n/a`; existing findings keep their normal priority in the matrix.

A sweep also records the identity of the check definition and required services it evaluated. Changing the command, working directory, timeout, expectation, error exit codes or required services makes the old answer `unknown`. `findings` lists it under `RECHECK REQUIRED` with the exact command to run again. Display-label changes do not invalidate the result. Older sweep records without a recorded check identity remain readable but require one rerun before they can assert `clean`; no state schema migration is needed. If the pattern was changed into a judgment question, the instructions point to that question for review instead of suggesting a sweep that cannot run.

**A clean run records no confirmation.** Confirmations are counted by `source.kind`, so filing one for a check that found nothing would hand R1 the second source kind it needs and confirm a finding the sweep had just contradicted.

A pattern's `check` is operator-authored code that `sweep` executes with the operator's own privileges, in the project's worktree. `pattern add --check` is therefore a trusted operation; the argv is run directly, without a shell.

### Importing patterns

Patterns do not have to be typed in one at a time. `pattern import` reads the records of the [ai-workforce](https://github.com/ponponpon888/ai-workforce) pitfall database, where each record is one hole that was found in one real project, and asks each of them of every project SUMI knows.

```powershell
sumi pattern import C:\Dev\ai-workforce\data\app-pitfalls --dry-run
sumi pattern import C:\Dev\ai-workforce\data\app-pitfalls
sumi pattern import --builtin
sumi findings
```

How a record maps:

| Record (schema_version 1) | Pattern |
|---|---|
| `id` | `key`, and `source.id` |
| `title`, `summary`, `severity`, `origin` | the same fields; `question` is generated from the id and title |
| `confidence`, file name | kept under `source` and shown by `pattern show` |
| `tags` containing `supabase` / `vercel` | `--requires` for that service; other tags stay in the record |
| `detection.checkable: true`, `kind: file-content` | a mechanical check on the bundled `checks/file-content.mjs` |
| any other detection | a judgment question |

Records are validated against a copy of the upstream `_schema.json` (enums, unknown fields, title length, kind/status and measured rules). A typo such as `layer: "App"` or `kind: "behavior"` is refused, not quietly re-classified.

Only `layer: app` records describe application code, so other layers (permissions, hooks, shells) are skipped with a reason, as are `kind: behaviour` records. Skipping is reported, never silent.

`--builtin` imports the checks that ship with SUMI. Today that is `service-role-in-client`: can the Supabase service role key reach the browser, through a `NEXT_PUBLIC_`/`VITE_`/`PUBLIC_`-style variable or a `"use client"` module? It prints file, line and variable name only. It never prints the line, because in a `.env` file the value sits on the same line and sweep evidence is kept.

It reads the files git lists — every tracked file, including those of checked-out submodules, plus git-ignored `.env*` files — so no directory is skipped by name. Test files (`*.test.*`, `*.spec.*`, `__tests__/`, `__mocks__/`) are not read. Every occurrence is a hit, including one on a line that looks like a comment. Such hits are labelled "on a line that looks like a comment", never dropped: whether a line really is a comment depends on parser state — a template literal, a one-line generator method or a Vue template can put code on a line that starts with `*` or `//` — and every rule tried for dropping them hid a real leak in review. A false hit is dismissed once (`finding set-status --status dismissed --reason ...`) and stays dismissed through later sweeps; a dropped one would never be seen. A file it cannot read — too large, a symlink leading out of the worktree, a submodule that is not checked out — makes the run "could not check" unless another file already reproduced the leak. A project with no JavaScript, TypeScript or `.env` files is "could not check" too. At most 50 hits are printed, so a file with thousands of them still comes back as a reproduction. Known limit: a `.env*` file inside a git-ignored directory is not listed.

Bundled checks are stored as `{sumi-node} {sumi-checks}/<name>.mjs ...` and resolved only when a sweep runs them: `{sumi-node}` is the Node binary running SUMI itself, spawned directly. The project's own `.nvmrc`, version-manager shims or a `node.bat` in its worktree never decide what runs, and moving the SUMI install changes neither the import digest nor the sweep fingerprint. The bundled script calls git from its own directory, not from the worktree, so a `git.exe` committed to a project is not what runs on Windows. A bundled script named by its absolute path (`node <install>/checks/<name>.mjs`) is rewritten to that form too. A bundled check's exit contract is fixed — `reproducedExitCodes: [3]`, no `errorExitCodes`, `expect: exit-zero` — even when the pattern is typed by hand, and a sweep evaluates every check in its normalized form, so a pattern stored before a rule existed still gets it. The sweep fingerprint includes the script's content, so upgrading SUMI with a changed check turns earlier answers into `RECHECK REQUIRED`.

Hand-authored checks can use the same allow-list: `--check-reproduced-exit-codes 3` makes exit `0` clean, `3` reproduced, and every other exit an execution error.

The import is fail-closed:

- **All-or-nothing.** Every record is validated and every conflict is resolved before anything is written. One malformed record, an `issue:<n>` origin SUMI cannot trace, or one refused update aborts the import with the full list, and the state is untouched.
- **A changed record needs `--update`.** Re-importing an identical record is `unchanged`. A changed one is refused until `--update` is passed. A changed check gets a new fingerprint, so earlier sweeps of it become `RECHECK REQUIRED`.
- **Local edits are never overwritten.** A pattern added by hand with the same key is refused even with `--update`. A pattern edited with `pattern set` since import keeps its edits, and an import that would change it is refused until it is reconciled by hand.
- **A broken check is never a reproduction.** Bundled checks carry `reproducedExitCodes: [3]`, an allow-list of verdicts: `0` is clean, `3` is reproduced, and every other exit — `2` for "could not check", `1` for a Node failure, `126` from a shim, a Windows crash code — is an execution error that leaves the cell `unknown`. A missing bundled script is an error before anything runs.
- **A local edit that already matches the new record** becomes the new baseline instead of blocking the import.

Most records today are judgment questions: their holes live in policies, grants and handlers that a reader has to look at. Sweep does not run those. Answer them per project with `sumi finding add`, and the matrix shows which projects have not been asked yet.

### Exporting a finding as a pitfall record

`pattern import` brings pitfall records in; `finding export` sends what a sweep found back out, as a **draft** record for `data/app-pitfalls/` in ai-workforce. SUMI writes the draft; a person reads it, edits it, validates it there and submits it. SUMI never publishes anything.

```powershell
sumi finding export musubu F003 --id rls-005 --out C:\Dev\ai-workforce\data\app-pitfalls
sumi finding export musubu F004 --id time-001 --open-ok --why-not-closed "display only; fixed with the next release"
```

Without `--out` the record is printed on stdout and the notes on stderr. `--out` takes a directory (the file is `<id>.json`) or a `<id>.json` path, writes BOM-free UTF-8, and never overwrites.

| From the finding | In the record |
|---|---|
| `fixed` (delivery evidence) | `status: closed`, `fix` naming the PR and merge commit — say what the change did |
| `confirmed` | `status: open_recorded` with `--why-not-closed`; only with `--open-ok`, and never at `high` severity |
| `suspected`, `dismissed`, `not_applicable` | refused |
| a sweep reproduced the check (R1 mechanical) | `confidence: measured`, `measured_on` = the day the check ran, `repro` = the check, exit code, commit and files; every `environment` field `"unrecorded"` |
| confirmed by two kinds of source | `confidence: unverified` — corroboration is not a measurement |
| the pattern came from a record | `related: [<that record>]` |

Always: `layer: app`, `kind: trap`, `origin: record`, `detection` manual, `tags` with `sumi` and the pattern's services. Title (100 characters at most) and summary come from the finding unless `--title` / `--summary` are given.

**The check's output is never copied.** A check that looks for a leaked key prints the line that holds it. **Open holes need `--open-ok`**, which says the hole touches neither personal data nor permissions — those are published after they are closed — and a high-severity open finding is refused outright.

Every draft is run through the same validation `pattern import` uses before it is written, and drafts were checked against ai-workforce's own `validate-pitfalls.mjs`.

### The rules

A finding's status is not a free-text field. Each transition is refused unless the evidence exists:

- **suspected → confirmed** requires either a mechanical check that the sweep itself reproduced, or confirmations from two different `source.kind`s. An agent reporting its own conclusion — however many times — stays `suspected`. `sweep` is the only thing that can produce the first kind; there is still no flag for typing a check result in by hand.
- **not_applicable / dismissed** require a non-empty reason. An empty string is refused.
- **not_applicable** is additionally refused while a required service is unregistered, because that state is unknown rather than irrelevant.
- **promote** accepts only a `confirmed` finding. It creates one ordinary scope criterion and links it back through `finding.scopeId`; it opens no new execution path, so promoted work flows through the existing route/queue/session pipeline.
- **fixed** is derived, never asserted: the promoted scope criterion must be `done` and a session on that criterion must carry a delivery merge commit. `fixedBy` is read out of that session's delivery evidence, not from a command-line flag.

```powershell
sumi finding set-status northwind F001 --status confirmed `
  --source-kind human --commit 0123456789abcdef0123456789abcdef01234567
sumi finding promote northwind F001
```

Passing a source and commit to `set-status` records one more confirmation before the rule is applied. There is deliberately no flag for recording a check result by hand — see below.

### Not closed

The independence of two confirmations is judged **only** by the difference in `source.kind`. One operator who reports the same finding twice under two different kinds will pass the rule. This is not closed.
