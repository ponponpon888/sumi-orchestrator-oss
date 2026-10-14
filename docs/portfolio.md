# Portfolio view: queue, batch, claims, dashboard

Running several projects at once: one prioritized cross-project work list, conservative parallel batches, leases that stop duplicate assignment, and the multi-project dashboard. See [README](../README.md) for the quick start.

## Global work queue

Use `queue` when several projects are active and you want one prioritized work list across all of them:

```powershell
sumi queue
```

Refresh every registered project before building the queue when you need current external evidence:

```powershell
sumi queue --sync
```

The queue separates:

- `HUMAN BLOCKERS` — account, billing, permission, or other human-owned gates that block progress
- `AGENT READY` — work that can be dispatched now to Claude Code, Codex, or browser verification
- `WAITING` — dependency-gated work that should not be repeatedly re-dispatched

Filter the queue when assigning one type of worker:

```powershell
sumi queue --agent claude-code --state ready
sumi queue --agent browser --state ready --limit 5
```

Turn a global queue item directly into the same evidence-backed assignment prompt used by the per-project Router:

```powershell
sumi queue --prompt 1
sumi queue --prompt musubu:C003
```

The numeric selector follows the currently displayed/filtered queue order. `project:scopeId` is stable across display changes.

This turns the per-project Router into a portfolio-level work queue without changing project state.

## Parallel execution plan

Use `batch` when you want to split ready work across several AI sessions without assigning two tasks from the same project at the same time:

```powershell
sumi batch
sumi batch --max-concurrency 4
sumi batch --agent browser
```

The planner is intentionally conservative:

- only `ready` routes are scheduled; waiting dependencies are not dispatched
- human/platform actions are shown separately and do not consume AI slots
- each batch contains at most one assignment from a project, preventing concurrent agents from racing on the same repository state
- `--max-concurrency` controls the number of different projects that may run in parallel (default `3`, maximum `16`)

Generate copy-ready evidence-backed prompts for every assignment in a batch:

```powershell
sumi batch --prompts 1
```

Reserve an entire batch as execution sessions in one operation:

```powershell
sumi batch --start-sessions 1
sumi batch --start-sessions 1 --worktree-root "D:\SUMI-worktrees" --ttl-min 180
```

For code-agent assignments this creates one isolated worktree per project; browser assignments receive leases without a code worktree. If any session/worktree fails to start, SUMI rolls back every session already created by that batch attempt, including the SUMI-created branch/worktree, so the batch does not remain half-reserved.

Emit the session-bound prompts immediately after successful reservation:

```powershell
sumi batch --start-sessions 1 --emit-prompts
```

SUMI still does not launch the external AI processes itself. The batch operation reserves isolated execution contexts and produces prompts; Claude Code/Codex/browser execution remains explicit.

## Work claims and leases

Before handing a ready scope gate to an AI session, reserve it so the global queue and batch planner do not assign the same work twice:

```powershell
sumi claim musubu C003 --agent browser --owner browser-1 --ttl-min 120
sumi claims
sumi release musubu C003
```

Claims are time-limited leases. Active claims appear in the global queue as `CLAIMED` and are excluded from `sumi batch`. Expired leases stop blocking scheduling automatically and can be replaced without `--force`. Use `--force` only when deliberately taking over an unexpired lease.

```powershell
sumi claims --all
sumi claim musubu C003 --agent browser --owner browser-2 --force
```

Moving a scope criterion to `done` or `cancelled` clears its lease. Claims do not mark work complete and do not change the completion percentage.

## Multi-project dashboard

```powershell
sumi dashboard
```

Refresh registered projects first, then display them:

```powershell
sumi dashboard --sync
```

Example goal:

```text
SUMI DEV OS
────────────────────────────────────────
MUSUBU          33%   BLOCKED   GitHub Billing
ORCHARD         78%   ACTIVE    chat relay
HANAMI          61%   ACTIVE    matching flow
ATLAS           72%   WAITING   Windows approval
```

Percentages appear only where an explicit completion Scope exists.

The `STATE` column separates a project that is genuinely being worked on from one that has never declared its Definition of Done:

```text
ORCHARD         100%  DONE      —
NORTHWIND         —   UNSCOPED  setup: scope, vercel
LEDGERLY          —   UNSCOPED  CIの失敗原因を特定して修正する
```

`UNSCOPED` means the completion Scope is empty, so no percentage can exist. Projects with configuration gaps are listed under `SETUP REQUIRED` in `sumi queue`, separately from dispatchable work, and they are never numbered, so `queue --prompt <number>` keeps pointing at the same item.
