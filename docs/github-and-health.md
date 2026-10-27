# GitHub-source projects and health

Projects whose code lives only on GitHub, how GitHub is read, and the health signals SUMI raises for every project: CI that stopped, and a default branch that did not reach production. See [README](../README.md) for the quick start.

## Projects that live on GitHub

When the code lives on GitHub and a local clone is stale or absent, register the project as GitHub-source:

```powershell
sumi project add orchard --name ORCHARD --repo owner/orchard --source github
sumi project set musubu --source github
sumi sync orchard
sumi sweep
```

SUMI then keeps its own mirror of the repository's default branch in `mirrors/<project>` next to the state file (by default `%USERPROFILE%\.sumi\mirrors\<project>`). Every `sync` and every `sweep` refreshes it from GitHub first and observes or checks the exact commit the remote holds. `status` and `handoff` show it as `SOURCE GitHub main @ <commit>`.

- **The mirror is SUMI's alone.** SUMI marks it when it clones it. It resets it to the remote head on every refresh — edits, stray files and ignored files such as `.env.local` do not survive. It will not reset a directory it did not create, including a real clone of the same repository, and it refuses a mirror path that overlaps the project's `--local` clone (judged on real paths, through symlinks).
- **Git is pinned to the mirror.** Every git command names the mirror with `--git-dir` / `--work-tree`, the inherited variables that point git at a repository (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, ... as set inside hooks or `rebase --exec`) are dropped — credentials, CA bundles, askpass and your own `GIT_SSH_COMMAND` are kept — and `GIT_CEILING_DIRECTORIES` stops git from walking up. The same location variables are dropped for sweep checks and worktree inspection, so a `git grep` check answers for the swept worktree. Before any reset git must confirm the repository it would touch is the mirror's own `.git`. A damaged mirror inside an enclosing repository (a dotfiles repo holding `~/.sumi`) is reported as damaged; the enclosing repository is never touched.
- **A failed refresh is a failure, not a fallback.** If GitHub cannot be reached, `sync` clears the current commit (other gates read it as "current") together with the PR, CI and preview verdicts about it, keeps the last commit it saw under the source, and `sweep` reports an error for that project. Neither reports the mirror's older state as current.
- **One fetch per sweep, checked before every pattern.** A sweep fetches each project once and evaluates every pattern against that commit; before each pattern the mirror is put back at that commit offline, so a check that rewrites a tracked file cannot change what the next check sees. A `--local` worktree is never reset: a check that dirties it makes the next pattern an error.
- **No PR stands in for the default branch.** A GitHub-source project's current work is its default branch, so CI comes from that branch's own runs, never from an open PR (including a fork's PR from a branch also named `main`). For local projects, a fork's PR from a same-named branch is not selected either.
- **Credentials** are whatever `git` already uses for `https://github.com` (Git Credential Manager on Windows, `gh auth setup-git`). Git never waits for a prompt: an unattended run fails instead of hanging.
- **Sessions stay local.** Code-agent sessions still need a `--local` clone to create worktrees in.

GitHub itself is read through REST (`gh api`) only — open PRs, check runs and status contexts, workflow runs, failed jobs and logs, recently merged PRs and the default branch — because GraphQL-backed `gh pr` / `gh run` commands are unavailable in some environments. Query parameters are passed as `-f` fields, so no argument contains `&` (which a Windows `gh.cmd` shim would refuse). Check runs and status contexts are read across pages; if GitHub reports more than SUMI could read, CI is `unknown` rather than judged from part of them. The session Release and Delivery Gates read the same way (see [Release Gate over REST](execution-sessions.md#release-gate-over-rest)).

## CI health

A CI that silently stopped looks exactly like a CI that is not failing. A workflow disabled by hand, exhausted Actions minutes or a workflow that never triggers all leave every later merge unverified, and nothing turns red.

On every `sync`, SUMI reads from GitHub (never from the local or mirrored checkout) the repository's workflows and their state, the default branch's latest commit, and the default branch's recent runs, and decides:

| Status | Meaning | Alert |
|---|---|---|
| `current` | a run exists for the default branch's latest commit | — |
| `unverified` | no run for that commit yet, but the last run is recent (under 7 days and 20 commits), or the commit is under 15 minutes old | — |
| `stale` | no run for the latest commit, and the last run is 7+ days or 20+ commits behind | high |
| `disabled` | every workflow is disabled (`disabled_manually`, `disabled_inactivity`, ...) | high |
| `never` | workflows are active but have never run on the default branch | medium |
| `none` | the repository has no workflow | — |
| `unknown` | GitHub could not be read; a warning says why | — |

The summary names the disabled workflows, the last run's date and commit, and how many commits and days the default branch has moved since:

```text
HEALTH ALERTS (human; not work items)
  ! P3 LEDGERLY [ledgerly] [high] CI is switched off — every workflow is disabled: Test (disabled_manually); last run 2026-09-18 @ 4f1c2a9e7b30, 112 commit(s) / 39 day(s) since
```

Alerts appear in `queue`, `dashboard`, `continue`, `status` (`CI HEALTH` line and `HEALTH ALERTS`) and `handoff`, for every project, including those without a Scope. They are not work items: they carry no Scope ID and are never numbered, so `queue --prompt <n>` keeps its meaning. An old success is never reported as the current commit's CI.

## Production deploy health

Merged is not shipped. A failed or canceled Vercel build leaves production on an older commit while `main` looks done, and a later docs-only commit skipped by Ignored Build Step can hide that the change before it never shipped.

On every `sync`, SUMI reads the commit statuses Vercel's Git integration posts on the default branch's commits (GitHub REST; no Vercel CLI or token), walking back from the latest commit only until the last completed deploy (at most 30 commits):

| Vercel status | Read as |
|---|---|
| `success` "Deployment has completed" | deployed |
| `success` "Canceled by Ignored Build Step" | skipped on purpose |
| `pending` | deploying |
| `failure` / `error` "Deployment has failed" | failed |
| `failure` "Canceled ..." | canceled |

| Status | Meaning | Alert |
|---|---|---|
| `current` | the latest commit is deployed, or was skipped by Ignored Build Step with nothing failed since the last deploy | — |
| `deploying` | the latest commit's deploy is pending (under 30 minutes) | — |
| `unverified` | no Vercel status on the latest commit yet | — |
| `failed` | the latest commit's deploy failed | high |
| `behind` | a commit since the last deploy failed or was canceled and nothing later deployed, or no completed deploy in the window | high |
| `canceled` | the latest commit's deploy was canceled | medium |
| `stuck` | the latest commit's deploy has been pending for 30+ minutes | medium |
| `stale` | Vercel posted nothing for the latest commit, and the last deploy is 7+ days or 20+ commits back | medium |
| `none` | no Vercel status on the scanned commits (not deployed through Vercel's Git integration) | — |
| `unknown` | GitHub could not be read, or the scan stopped before the last deploy; a warning says why | — |

Every summary says where production is: `production is at 9a8b7c6d5e4f (2026-10-25), 2 commit(s) behind main`. When one repository has several Vercel projects (`Vercel – <project>` contexts), each is assessed and the worst decides. A project registered with `--vercel none` is not scanned.

When CI is switched off or stale and production serves the latest commit, the CI alert adds `production is serving these unverified commits`.

What it cannot see: a rollback or promotion done inside Vercel leaves no status on GitHub, so production may differ from what the statuses say after one. It assumes the default branch is the Vercel production branch.

## Health report

`sumi health` gathers [CI health](#ci-health) and [production deploy health](#production-deploy-health) for every project into one report — the thing to read first in the morning:

```powershell
sumi health --sync
```

```text
SUMI HEALTH — 2026-10-28T00:00:00.000Z
========================================================================
4 project(s): 1 high, 0 medium alert(s); 1 not fully observed

PROJECT               CI HEALTH    PROD DEPLOY  ALERTS
------------------------------------------------------------------------
ledgerly              disabled     current      high
orchard               current      current      —
atlas                 —            —            ? (not observed)
...

ALERTS (human; not work items)
  ! ledgerly [high] CI is switched off — every workflow is disabled: Test (disabled_manually); last run 2026-09-18 @ 4f1c2a9e7b30, 112 commit(s) / 39 day(s) since; production is serving these unverified commits

NOT OBSERVED (absence of alerts here means nothing)
  ? atlas: CI health not observed; production deploy not observed
      - Default branch lookup skipped: gh: ... (HTTP 404)
```

A project is under NOT OBSERVED when its sync failed, it has no repository, or its CI or deploy health is missing or `unknown`; a project registered with `--vercel none` is not expected to have a deploy. "No alerts" is printed only when every project was fully observed and nothing alerts.

| Option | Effect |
|---|---|
| `--sync` | sync every project first (GitHub-source projects refresh from GitHub) |
| `--json` | the same report as JSON: `generatedAt`, `totals`, and per project `ciHealth`, `deployHealth`, `alerts`, `notObserved`, `notes` |
| `--fail-on high\|medium` | exit with code 3 when an alert at or above that severity exists (1 stays "error") |
