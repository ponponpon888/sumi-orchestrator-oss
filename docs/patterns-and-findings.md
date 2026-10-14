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

`exit-nonzero` cannot make that distinction: it reads **every** non-zero exit as healthy, so a detector that uses a separate error code — `grep` exits 2 on a bad pattern or an unreadable file — will report that error as a clean project. Prefer `exit-zero` or `no-output` for a check that can fail in more than one way.

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
| Check reproduced, but a `dismissed` / `not_applicable` finding already answers the cell | `suppressed` | a sweep record only; the ledger is left alone |
| Check ran and reproduced | `reproduced` | a finding or a new confirmation, plus the sweep record |

A dirty worktree is refused because evidence is bound to a commit: a result produced from uncommitted edits is not reproducible from the commit that would be recorded beside it.

**A clean run records no confirmation.** Confirmations are counted by `source.kind`, so filing one for a check that found nothing would hand R1 the second source kind it needs and confirm a finding the sweep had just contradicted.

A pattern's `check` is operator-authored code that `sweep` executes with the operator's own privileges, in the project's worktree. `pattern add --check` is therefore a trusted operation; the argv is run directly, without a shell.

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

