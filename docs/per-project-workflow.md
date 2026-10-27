# Per-project workflow

The per-project loop in detail: register a project, observe its state, declare completion, route work, ingest results, and hand off. See [README](../README.md) for the quick start.

## Register a project

```powershell
sumi project add musubu `
  --name "MUSUBU" `
  --repo "example-org/musubu" `
  --local "C:\Dev\musubu-example" `
  --vercel "musubu-example" `
  --supabase "abcdefghijklmnopqrst"
```

Omitting `--vercel` or `--supabase` means **not registered yet**, which SUMI reports as a setup gap. When a project genuinely does not use a service, record that explicitly with `none` so it stops being reported as missing:

```powershell
sumi project set atlas --vercel none
sumi project set atlas --supabase none
```

SUMI treats the two cases differently:

- **not registered** — SUMI cannot observe that service, so it does not invent work that depends on it
- **`none` (not used)** — SUMI never calls that CLI for the project and never asks for the registration again

A project with no completion Scope is reported as `UNSCOPED` rather than `IN DEVELOPMENT`, and `status` / `continue` / `queue` list the exact commands that close each gap under `SETUP REQUIRED`. Registration and Scope are never inferred automatically, and `DONE` still requires explicit Scope plus production evidence.

List registered projects:

```powershell
sumi project list
```

Set portfolio priority with `P1` as highest and `P5` as lowest. Existing projects default to `P3`:

```powershell
sumi project set musubu --priority 1
sumi project set hanami --priority 2
```

Priority is used by `project list`, `dashboard`, `queue`, and `batch`. Within the same priority, the first route item for each project is ranked before later items, which prevents one project from monopolizing the portfolio queue.

## Observe current state

```powershell
sumi sync musubu
sumi status musubu
```

`sync` is read-only toward GitHub, Vercel, and Supabase. It gathers evidence; it does not deploy or mutate infrastructure.

`PROGRESS` is calculated **only** from explicit Scope criteria. Git history, PR count, or managed tasks are never silently treated as the whole-project denominator.

## Define completion Scope

```powershell
sumi scope title musubu "MUSUBU current release gate"

sumi scope add musubu `
  "PR #42の変更内容を確認しマージ可能状態にする" `
  --status doing

sumi scope add musubu `
  "認証フローを実ブラウザで検証する" `
  --status todo

sumi scope list musubu
```

Scope statuses:

```text
todo | doing | blocked | done | cancelled
```

SUMI can suggest missing completion criteria without applying them automatically:

```powershell
sumi scope suggest musubu
```

It can also review existing Scope statuses against current evidence:

```powershell
sumi scope review musubu
```

## Route the next work

```powershell
sumi route musubu
```

SUMI currently distinguishes work such as:

- `claude-code / execute` — implementation, repository changes, CI diagnosis
- `codex / review` — independent PR/code review
- `browser / verify` — runtime/browser verification
- `human / action` — billing, permissions, account-owner actions

These agents are defined in one capability registry. Codex automatic dispatch remains restricted to read-only review mode. Claude Code is write-capable and still manual in direct dispatch; automatic execution is available only through an active SUMI session that owns an isolated worktree.

Dependency-gated work is shown as `WAITING` rather than repeatedly re-dispatched.

Generate an assignment prompt:

```powershell
sumi route musubu --prompt C001
```

## Ingest an AI/human result

Interactive mode:

```powershell
sumi result musubu C001 --agent codex --apply
```

Paste the result and finish with:

```text
.end
```

Or use a file/text argument:

```powershell
sumi result musubu C001 --agent codex --file .\result.txt --apply
```

SUMI extracts evidence, blockers, and conservative Scope transitions. Write verdicts with their full Scope IDs: `C001 can move to done. C002 stays blocked. C003 stays open.` Statements naming another Scope do not supply the target’s disposition. Unscoped warnings and explicit `BLOCKER:` declarations remain conservative overrides; qualify contextual status descriptions with the relevant ID. Explicit agent verdicts are preferred over weaker heuristics; for example, `mergeable` does not automatically close a gate if the reviewer explicitly says it must remain open.

## Explain why a gate has its status

```powershell
sumi result list musubu
sumi result show musubu R001
sumi evidence musubu C002
```

The Evidence Ledger answers questions such as:

> Why was C002 marked done?

without requiring the original chat to still exist.

## Generate a handoff

```powershell
sumi handoff musubu
```

The handoff contains:

- current repository/branch/PR state
- project progress basis
- current and blocked Scope items
- next actions ordered ready → claimed → waiting, with owner and waiting reason
- absolute state-file path and a reminder to resume with `--data`
- CI diagnostics
- recent merged PRs
- recent decisions/results
- instructions for the next AI/session
