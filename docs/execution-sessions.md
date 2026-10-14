# Execution sessions: worktree isolation through delivery

Handing a scope gate to a worker and following it through isolated execution, independent review, merge, release, and verified production delivery. Every gate is a decision gate: SUMI observes and certifies, it never merges or deploys. See [README](../README.md) for the quick start.

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
