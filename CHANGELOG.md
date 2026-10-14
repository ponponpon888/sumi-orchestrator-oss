# Changelog

Notable changes to SUMI Orchestrator. The entries below were previously carried at the top of the README.

## 1.14.3 — reliability patch

Blocker-first result ingestion and routing now place actionable remediation/ready work ahead of blocked or waiting gates; sync now preserves stored Production verification, aggregates current-main baseline CI, and avoids non-actionable empty Preview warnings for completed releases.

## 1.14.2 — routing hotfix

`GitHub Billing / spending limit` wording now classifies as the existing `ci-billing` gate even when the criterion text omits `Actions` or `CI`, so account-level blockers route to `human / action` instead of the default coding agent.

## 1.14.1 — Windows hotfix

Review Gate now launches npm `.cmd` shims through `cmd.exe` safely on Windows, and cross-platform worktree path assertions are normalized. No state schema migration is required.
