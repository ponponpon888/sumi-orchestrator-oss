# SUMI Orchestrator v1.15.0

SUMI is a local-first development-state orchestrator for AI-assisted software projects.

> **v1.14.3 reliability patch:** blocker-first result ingestion and routing now place actionable remediation/ready work ahead of blocked or waiting gates; sync now preserves stored Production verification, aggregates current-main baseline CI, and avoids non-actionable empty Preview warnings for completed releases.
>
> **v1.14.2 routing hotfix:** `GitHub Billing / spending limit` wording now classifies as the existing `ci-billing` gate even when the criterion text omits `Actions` or `CI`, so account-level blockers route to `human / action` instead of the default coding agent.
>
> **v1.14.1 Windows hotfix:** Review Gate now launches npm `.cmd` shims through `cmd.exe` safely on Windows, and cross-platform worktree path assertions are normalized. No state schema migration is required.

It does **not** replace Claude Code, Codex, GitHub, Vercel, or Supabase. Its job is to keep the development state coherent across them:

> observe → define completion → decide NEXT → route work → ingest result → preserve evidence → hand off

## v1 MVP

The v1 workflow is intentionally narrow:

- `sync` — observe local Git, GitHub/CI, Vercel, and Supabase state
- `scope` — define the project's explicit Definition of Done
- `status` — show current project state and evidence-backed progress
- `route` — decide who should handle each NEXT item
- `result` — ingest outcomes from Codex, Claude Code, browser checks, or humans
- `evidence` — explain why a Scope item has its current status
- `handoff` — generate a clean continuation brief for the next AI/session
- `continue` — sync, prioritize blockers, and recommend the next action
- `dashboard` — show all registered projects in one view
- `queue` — build one cross-project work queue for human blockers, agent-ready work, and waiting dependencies
- `batch` — turn ready portfolio work into conservative parallel batches without overlapping projects, and optionally reserve a whole batch as isolated sessions atomically
- `claim` / `release` / `claims` — lease scope gates to one worker and prevent duplicate assignment
- `session` — bind a lease to an execution session, isolate code agents in dedicated Git worktrees, ingest results, enforce review readiness, and require an independent verdict before merge readiness
- `merge-queue` — show cross-project sessions that need reviewer action, changes, revalidation, or an explicit merge decision
- `release-queue` — require fresh session-specific GitHub PR/CI/review/mergeability evidence before a release decision
- `delivery-queue` — track the certified PR after merge through the exact production deployment and explicit verification
- `releases` — preserve finalized delivery history across projects after scope/session lifecycle closure
- project priority (`P1`–`P5`) — rank portfolio work before queue and batch assignment

Browser automation and direct agent dispatch remain advanced/experimental. They are not required for the v1 workflow.

## Requirements

- Windows 11 recommended
- Node.js 20+
- Git
- GitHub CLI (`gh`) for GitHub observation
- Vercel CLI only for projects using Vercel
- Supabase CLI only for projects using Supabase

## Install

```powershell
Set-Location C:\Dev\sumi-orchestrator
npm link
sumi init
```

SUMI stores project state outside the source repository:

```text
%USERPROFILE%\.sumi\state.json
```

State files are migrated under an exclusive lock. Before an older schema is replaced, SUMI preserves the previous valid file as `state.json.bak`. A state created by a newer unsupported SUMI version is rejected instead of being silently rolled back.

Updating SUMI therefore does not erase registered project state.

## Daily entry point

Use `continue` when resuming a project:

```powershell
sumi continue musubu
```

Typical output:

```text
SUMI CONTINUE — MUSUBU
========================================================================
Progress: 33% (2/6 scope)
Branch: fix/auth-confirm-sensitive-logging
PR: 183
CI: failed
Worktree: clean

BLOCKERS
  ! C006 GitHub Billing / spending limit...

RECOMMENDED NEXT
  C006 GitHub Billing / spending limit...
  Owner: human / action
  State: ready

PARALLEL READY
  - C003 認証フローを実ブラウザで検証する -> browser

WAITING
  - C001 PR #183... — C006 is blocking CI...
```

The goal is to eliminate the recurring question: **"Where did this project stop?"**

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
sumi project set ai-workforce --vercel none
sumi project set ai-workforce --supabase none
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
  "PR #183の変更内容を確認しマージ可能状態にする" `
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

SUMI extracts evidence, blockers, and conservative Scope transitions. Explicit agent verdicts are preferred over weaker heuristics; for example, `mergeable` does not automatically close a gate if the reviewer explicitly says it must remain open.

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
- next actions
- CI diagnostics
- recent merged PRs
- recent decisions/results
- instructions for the next AI/session

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

## Execution sessions and worktree isolation

Use a session when you are actually handing a scope gate to a worker. A session owns the claim and gives code agents (`claude-code` and `codex`) a dedicated Git worktree by default. If `--agent` is omitted, SUMI uses the Router decision; an explicit agent that conflicts with the Router is rejected:

```powershell
sumi session start musubu C003 --owner claude-1
sumi session prompt musubu S001
sumi session list
```

For code agents, the default workspace is created outside the primary repository under:

```text
%USERPROFILE%\.sumi\worktrees\<project>\<session>
```

Override the root when needed:

```powershell
sumi session start musubu C003 --agent codex --worktree-root "D:\SUMI-worktrees"
```

Browser and human sessions use the shared/no-write workspace by default. You can explicitly disable or request worktree creation with `--no-worktree` or `--worktree`.

The generated session prompt includes the exact workspace and branch and tells the worker not to modify the primary worktree:

```powershell
sumi session prompt musubu S001
```

Inspect what an AI has actually changed in that isolated workspace without modifying it:

```powershell
sumi session inspect musubu S001
```

The inspection reports the exact branch/HEAD, the base commit captured when the session started, commits ahead/behind that base, dirty files, and any unexpected branch switch. This gives the orchestrator concrete workspace evidence instead of relying only on chat status.

Run the Session Review Gate before handing code to independent review or merge:

```powershell
sumi session review musubu S001
sumi session review musubu S001 --run-checks
```

The gate returns one of `WORKING`, `CHECKS_REQUIRED`, `BLOCKED`, `REVIEW_READY`, or `UNSUPPORTED`. `REVIEW_READY` requires an isolated clean worktree on the expected branch, at least one commit beyond the captured base, no behind-base divergence, and successful discovered verification commands. `--run-checks` always runs `git diff --check` and also runs available project scripts such as `npm test` and `npm run check` (falling back to `lint`/`build` when needed). A ready review does **not** auto-close the Scope gate or merge anything.

Once a session is `REVIEW_READY`, generate an independent read-only reviewer assignment. By default SUMI uses Codex to review Claude Code work and Claude Code to review Codex work; it refuses self-review:

```powershell
sumi session reviewer-prompt musubu S001
```

The reviewer prompt is bound to the exact reviewed HEAD and includes the committed files and passed checks. If the branch, HEAD, or worktree changes after the Review Gate, SUMI refuses to generate or ingest the review until `session review --run-checks` is rerun. Ingest the reviewer outcome with:

```powershell
sumi session reviewer-result musubu S001 --agent codex --file .\review.txt
sumi session reviewer-result musubu S001 --agent codex --file .\review.txt --apply
```

Reviewer results are linked to the execution session and reviewed HEAD. `--apply` still uses SUMI's conservative Scope-transition rules; a `MERGEABLE` verdict alone does not silently mark the Scope gate done.

Check whether the exact reviewed HEAD is ready for an explicit merge decision:

```powershell
sumi session merge-status musubu S001
sumi merge-queue
```

`MERGE_READY` requires both a fresh `REVIEW_READY` gate and an independent `MERGEABLE` verdict for the same HEAD. Any later commit or dirty worktree makes the prior certification stale. SUMI does not merge, push, deploy, or close the Scope gate from this command; merge remains an explicit GitHub/human action.

Before acting on `MERGE_READY`, run the Release Gate against the **session branch**, not whichever branch happens to be checked out in the primary repository:

```powershell
sumi session release-status musubu S001 --sync
sumi release-queue --sync
```

The Release Gate stores session-specific GitHub evidence and requires all of the following before returning `RELEASE_READY`:

- the local Session Merge Gate is still `MERGE_READY`
- an open, non-draft PR exists for the exact session branch
- the GitHub PR HEAD SHA exactly matches the locally reviewed HEAD
- GitHub status checks are conclusively green
- GitHub does not report `CHANGES_REQUESTED` or an outstanding required review
- GitHub does not report conflicts, a blocked merge, or an out-of-date branch
- the external GitHub evidence is fresh (15 minutes by default)

Refresh older evidence explicitly instead of trusting stale CI/review state:

```powershell
sumi session release-status musubu S001 --sync --max-age-min 10
sumi release-queue --sync --max-age-min 10
```

`RELEASE_READY` is still a **decision gate**, not an execution command. SUMI v1.14 does not merge, push, deploy, or mutate GitHub from the Release Gate. Running `session release-status` records a certification snapshot bound to the exact PR and reviewed HEAD so post-merge delivery can be checked against the same artifact.

After the explicit GitHub merge, continue with the Delivery Gate:

```powershell
sumi session delivery-status musubu S001 --sync
sumi delivery-queue --sync
```

For Vercel projects, SUMI looks for a Production deployment whose `githubCommitSha` matches the exact GitHub merge commit. A Vercel `READY` result is intentionally **not** treated as final verification. The Delivery Gate remains at `PRODUCTION_VERIFICATION_REQUIRED` until the exact deployment is explicitly checked:

```powershell
sumi session delivery-verify musubu S001 `
  --url "https://example-production.vercel.app" `
  --note "production smoke test passed"
```

`DELIVERED` therefore means all of the following refer to the same certified change:

- the `RELEASE_READY` snapshot identified PR and reviewed HEAD
- GitHub reports that PR as merged with the same head SHA
- GitHub exposes the resulting merge commit
- Production evidence points to that exact merge commit
- the exact Production deployment is READY
- an explicit production verification is stored against that merge commit/deployment

Delivery evidence also expires by default after 15 minutes so an old deployment state is not reused indefinitely. SUMI observes and certifies this chain; it still does not perform the merge or deployment itself.

Once a session is `DELIVERED`, finalize its lifecycle and write an immutable-by-convention release snapshot:

```powershell
sumi session delivery-finalize musubu S001
```

Finalization is deliberately separate from production verification. It:

- records a project release entry with PR, certified HEAD, merge commit, reviewer, verification checks, Production URL, and verification timestamp
- moves the associated Scope criterion to `done`
- closes the execution session as `completed` and releases its claim
- remains idempotent, so repeating the command does not create duplicate release records
- retains the worktree by default

If the session worktree is known to be disposable, request safe cleanup at the same time:

```powershell
sumi session delivery-finalize musubu S001 --cleanup
```

A clean SUMI-created worktree is removed. A dirty worktree is **retained**, while the release finalization still succeeds, so uncommitted local work is never destroyed as a side effect of lifecycle closure.

Inspect release history across the portfolio or one project:

```powershell
sumi releases
sumi releases musubu --limit 20
```

Release history remains available even after the execution session is closed and is intended as the compact audit trail for what actually reached Production.

Return an AI result directly through the session so SUMI automatically uses the session's scope ID and agent identity:

```powershell
sumi session result musubu S001 --file .\result.txt
sumi session result musubu S001 --file .\result.txt --apply
```

`--apply` keeps the same conservative high-confidence transition rules as `sumi result`. If the applied result closes the scope gate, the session closes automatically. Use `--finish` when the worker is done but the scope gate should remain open for another pass:

```powershell
sumi session result musubu S001 --file .\result.txt --finish
```

Keep the lease alive during long work:

```powershell
sumi session renew musubu S001 --ttl-min 120
```

Close the orchestration session when work ends:

```powershell
sumi session finish musubu S001
# or, if the work is intentionally stopped
sumi session abandon musubu S001
```

Finishing or abandoning releases only that session's own claim. The worktree is deliberately retained so uncommitted or unpushed work cannot be lost. Cleanup is a separate operation:

```powershell
sumi session cleanup musubu S001
```

Worktree creation also refuses a dirty primary repository, because an isolated worktree starts from a committed Git ref and would otherwise silently omit the primary worktree's uncommitted changes. The worktree root must be outside the primary repository. Cleanup refuses to remove an active or dirty worktree. It removes only a SUMI-created, ended, clean worktree and leaves the Git branch intact. If a lease expires, the old session is preserved as `expired`; a new session may then take over the scope gate while keeping the old workspace/history available for inspection.

When a scope criterion moves to `done` or `cancelled`, any active execution session for that criterion is closed automatically.

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
SHARENAIL       78%   ACTIVE    ZERO chat
HANAMI          61%   ACTIVE    matching flow
AI WORKFORCE    72%   WAITING   Windows approval
```

Percentages appear only where an explicit completion Scope exists.

The `STATE` column separates a project that is genuinely being worked on from one that has never declared its Definition of Done:

```text
SHARENAIL       100%  DONE      —
client INTL      —   UNSCOPED  setup: scope, vercel
SUMI TRADE        —   UNSCOPED  GitHub ActionsのCI失敗原因を確認して修正する
```

`UNSCOPED` means the completion Scope is empty, so no percentage can exist. Projects with configuration gaps are listed under `SETUP REQUIRED` in `sumi queue`, separately from dispatchable work, and they are never numbered, so `queue --prompt <number>` keeps pointing at the same item.

## Safety principles

- Observation is read-only by default.
- Production `READY` is not the same as human/browser `verified`.
- Blockers are not cleared just because `unblock` was requested; fresh evidence must support recovery.
- PR body text can require browser verification, but it cannot complete the Browser Gate; stored browser/human evidence is required.
- Browser evidence is bound to the project commit, final URL, check time and interactive snapshot SHA-256.
- Account/billing blockers route to humans, not coding agents.
- Scope is the authoritative source for whole-project progress.
- AI result ingestion applies only high-confidence changes when `--apply` is used.
- Write-capable AI sessions use isolated worktrees by default; primary worktrees are not shared across concurrent code sessions.
- Session cleanup never deletes a dirty worktree.
- Session Review Gate never marks a Scope gate done or merges code; it only certifies workspace readiness from Git and verification evidence.
- Release Gate uses session-specific PR/HEAD evidence and expires external GitHub evidence instead of trusting old CI/review state.
- Delivery Gate binds post-merge production evidence and explicit verification to the exact certified PR head and merge commit.
- Delivery finalization never deletes a dirty worktree and preserves a release-history snapshot before closing the lifecycle.

## Advanced / experimental commands

These capabilities exist in the codebase but are **not required for v1 MVP**:

```powershell
sumi dispatch ...
sumi browser ...
sumi unblock ...
```

They may be developed further after the core project-state workflow is stable across multiple real projects.

## Development

```powershell
npm test
npm run check
```

Current v1 validation target:

```text
245 tests passing
syntax checks passing
```

## Repository strategy

Use a single working directory going forward:

```text
C:\Dev\sumi-orchestrator
```

Do not create a new local folder for every version. Once the GitHub repository exists, normal updates should be:

```powershell
git pull
npm link
```

instead of downloading and expanding versioned ZIPs.
