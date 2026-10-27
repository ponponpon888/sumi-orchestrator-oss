# SUMI Orchestrator

A local-first CLI that keeps the development state of AI-assisted software projects coherent across Git, GitHub/CI, Vercel, and Supabase.

It exists to answer three questions that AI-assisted work keeps re-asking:

- **"Where did this project stop?"** — the state lives in a ledger on disk, not in a chat log that has scrolled away.
- **"Is this actually done?"** — progress comes only from explicit completion criteria, and `done` requires evidence that can be re-checked later.
- **"Which project should I touch next?"** — one prioritized queue across every registered project, with human-owned blockers separated from agent-ready work.

SUMI does **not** replace Claude Code, Codex, GitHub, Vercel, or Supabase. Its job is the loop between them:

> observe → define completion → decide NEXT → route work → ingest result → preserve evidence → hand off

## Try it in one minute

There are no dependencies to install before seeing output — the repository ships a bundled example state:

```powershell
git clone https://github.com/ponponpon888/sumi-orchestrator-oss.git
cd sumi-orchestrator-oss
npm run demo
```

```text
SUMI DASHBOARD
========================================================================
PROJECT              PRI  PROG  STATE    NEXT
------------------------------------------------------------------------
musubu-doboku        P3     —   DOING    LINE通知のE2E検証
```

`PROG` is `—` because that example project has no explicit completion Scope yet, so no percentage can honestly exist. That refusal to guess is the point of the tool.

## Install

```powershell
npm link
sumi init
```

Run both from the directory you cloned into; SUMI does not care where that is. `npm link` puts the `sumi` command on your PATH, and `sumi init` creates the state file.

## Requirements

- Windows 11 recommended
- Node.js 20+
- Git
- GitHub CLI (`gh`) for GitHub observation
- Vercel CLI only for projects using Vercel
- Supabase CLI only for projects using Supabase

## Where state lives

SUMI stores project state outside the source repository:

```text
%USERPROFILE%\.sumi\state.json
```

Updating SUMI therefore does not erase registered project state.

State files are migrated under an exclusive lock. Before an older schema is replaced, SUMI preserves the previous valid file as `state.json.bak`. A state created by a newer unsupported SUMI version is rejected instead of being silently rolled back.

Schema migration is one-way: once any command has saved the state, the pre-migration file survives only as the single `state.json.bak`, which the next save overwrites. A migrated state can no longer be read by an older SUMI that does not know the newer schema, and that refusal is deliberate. Take a named copy before upgrading if you may need to go back, and point verification runs at a throwaway file with `--data` while a schema change is still unmerged.

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
Branch: fix/login-session-timeout
PR: 42
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
  - C001 PR #42... — C006 is blocking CI...
```

## What the v1 workflow covers

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
- `pattern` / `finding` / `findings` / `sweep` — keep a bug found in one project as a question asked of every project, run the mechanical questions across the portfolio, and apply fail-closed rules for when an answer may be called confirmed or fixed
- `pattern import` / `finding export` — load those questions in bulk from [ai-workforce](https://github.com/ponponpon888/ai-workforce) pitfall records or SUMI's built-in checks (all-or-nothing), and turn a confirmed or fixed finding back into a draft record
- `health` — one report, for every project, of whether CI still runs on the default branch and whether its latest commit reached production; what could not be observed is listed, never called fine
- `--source github` — keep a project whose code lives only on GitHub: SUMI syncs and sweeps its own mirror of the default branch
- project priority (`P1`–`P5`) — rank portfolio work before queue and batch assignment

Browser automation and direct agent dispatch remain advanced/experimental. They are not required for the v1 workflow.

## Documentation

- [Per-project workflow](docs/per-project-workflow.md) — register a project, observe, declare completion Scope, route, ingest results, explain a status, hand off
- [Portfolio view](docs/portfolio.md) — the cross-project queue, parallel batches, work leases, and the multi-project dashboard
- [Execution sessions](docs/execution-sessions.md) — worktree isolation, the Review / Merge / Release / Delivery gates, and release history
- [Cross-project bug hunt](docs/patterns-and-findings.md) — patterns, findings, `sweep`, importing and exporting pitfall records, and the rules for `confirmed` and `fixed`
- [GitHub-source projects and health](docs/github-and-health.md) — projects that live only on GitHub, REST-only GitHub reads, CI health, production deploy health and `sumi health`
- [Design notes](docs/DESIGN-v0.1.md) — the original design sketch
- [Changelog](CHANGELOG.md) — release notes

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
- A finding is `confirmed` only on reproduced or independently corroborated evidence; an agent's own report keeps it `suspected`.
- A finding is `fixed` only when delivery evidence says so; there is no command that marks one fixed by assertion.
- An unregistered service leaves a pattern `unknown` for that project. It is never reported as not applicable.
- A sweep refuses to run against a dirty worktree, and a sweep that could not run leaves the cell `unknown` rather than `clean`.
- A sweep that finds nothing records no confirmation, so it can never help confirm the finding it just contradicted.
- A dismissed finding is not re-filed by the next sweep; only a reproduction after `fixed` opens a new one.
- Pattern import writes all of a source or none of it, and never overwrites a pattern added or edited by hand.
- A bundled check that crashes or cannot read its target is an execution error, never a reproduction or a clean run.
- GitHub is read over REST only; a list read in part is `unknown`, never judged from the part that was read.
- A health signal that could not be read is `unknown` and listed as not observed; it never raises an alert or counts as healthy.
- An exported pitfall record is a draft: SUMI never publishes it, never copies a check's output into it, and refuses open high-severity holes.

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

The validation target is the full test suite plus the syntax checks, both green.

## Author

**Shingo Kumon** (公門 慎吾)

Builds web services and business tools with AI-assisted development, and runs several of them in production.

- More projects: [GitHub profile](https://github.com/ponponpon888)
- Web: [shingokumon.com](https://www.shingokumon.com) / X: [@shingo_kumon](https://x.com/shingo_kumon)
- Work enquiries (contract, fully remote): [contact](https://www.shingokumon.com/contact)

## License

[MIT](LICENSE)
