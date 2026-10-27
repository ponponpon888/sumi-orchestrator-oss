# Changelog

Notable changes to SUMI Orchestrator. The 1.14.x entries were previously carried at the top of the README.

## 1.24.0 — finding export

`sumi finding export` turns a confirmed or fixed finding back into a draft ai-workforce pitfall record (`data/app-pitfalls/<id>.json`, schema_version 1) — the other half of `pattern import`. `confidence: measured` only when a sweep reproduced the check; environment fields are `"unrecorded"`; the check's output is never copied; an open hole needs `--open-ok` and `--why-not-closed` and is refused at high severity. See [docs/patterns-and-findings.md](docs/patterns-and-findings.md#exporting-a-finding-as-a-pitfall-record).

## 1.23.0 — Release and Delivery Gates over REST

The session Release and Delivery Gates read GitHub over REST (`gh api`) instead of `gh pr` (GraphQL), so they work in environments where GraphQL is unavailable. The review decision is derived from each reviewer's latest decisive review; a required review still outstanding shows as a blocked merge. Without the Vercel CLI, the Delivery Gate takes production evidence from the Vercel status on the exact merge commit. See [docs/execution-sessions.md](docs/execution-sessions.md#release-gate-over-rest).

## 1.22.0 — `sumi health`

One report of CI health and production deploy health for every project, with projects that could not be observed listed separately. `--json` for machines, `--fail-on high|medium` (exit code 3) for a scheduled check. See [docs/github-and-health.md](docs/github-and-health.md#health-report).

## 1.21.0 — production deploy health

`sync` reads the commit statuses Vercel's Git integration posts on GitHub and tells whether the default branch's latest commit reached production, with alerts when the latest deploy failed, was canceled, is stuck, or left production behind — including a failure hidden behind a later commit skipped by Ignored Build Step. No Vercel CLI or token is needed.

## 1.20.0 — CI health

`sync` tells whether CI still runs on the default branch at all (`current`, `unverified`, `stale`, `disabled`, `never`, `none`, `unknown`), and `queue`, `dashboard`, `continue`, `status` and `handoff` raise alerts when it was switched off or stopped — for every project, with or without a Scope. Alerts are not work items and never shift queue numbering.

## 1.19.0 — projects that live on GitHub

`--source github` makes SUMI keep its own mirror of the default branch and sync and sweep that. The mirror is SUMI's alone, git is pinned to it, a failed refresh clears the verdicts about the current commit instead of falling back, and the checkout is byte-exact on Windows. GitHub is read over REST only.

## 1.18.0 — pattern import

`pattern import` fills the cross-project bug hunt from the ai-workforce pitfall database and from SUMI's built-in checks, all-or-nothing. Built-in checks ship with SUMI and use a fixed exit contract (0 clean, 3 reproduced, anything else an error).

## 1.17.0

Scope-specific verdicts no longer inherit another criterion's status, and PR suggestions are matched to Scope items by number and status. Handoffs include effective blockers, ready-first routing and the state-file path. Session lease expiry and ownership were hardened. A sweep no longer reports `clean` from stale evidence or from a check's execution error; `--check-error-exit-codes` names a detector's own error codes.

## 1.14.3 — reliability patch

Blocker-first result ingestion and routing now place actionable remediation/ready work ahead of blocked or waiting gates; sync now preserves stored Production verification, aggregates current-main baseline CI, and avoids non-actionable empty Preview warnings for completed releases.

## 1.14.2 — routing hotfix

`GitHub Billing / spending limit` wording now classifies as the existing `ci-billing` gate even when the criterion text omits `Actions` or `CI`, so account-level blockers route to `human / action` instead of the default coding agent.

## 1.14.1 — Windows hotfix

Review Gate now launches npm `.cmd` shims through `cmd.exe` safely on Windows, and cross-platform worktree path assertions are normalized. No state schema migration is required.
