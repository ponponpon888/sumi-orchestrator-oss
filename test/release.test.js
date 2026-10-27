import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { addScopeCriterion, createProject } from "../src/domain.js";
import { reviewSession } from "../src/review.js";
import { ingestReviewerResult } from "../src/reviewer.js";
import { startSession } from "../src/sessions.js";
import { getReleaseQueue, getReleaseReadiness, normalizeReleasePr, recordReleaseGate, RELEASE_STATUSES, syncReleaseEvidence } from "../src/release.js";

const NOW = new Date("2026-09-11T10:00:00.000Z");
function git(args, cwd = null) { return execFileSync("git", args, { cwd: cwd || undefined, encoding: "utf8" }).trim(); }
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-release-repo-"));
  git(["init"], root);
  git(["config", "core.autocrlf", "false"], root); git(["config", "user.name", "SUMI Test"], root); git(["config", "user.email", "sumi-test@example.invalid"], root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", private: true, scripts: { test: "node -e \"process.exit(0)\"", check: "node --check target.js" } }, null, 2) + "\n");
  fs.writeFileSync(path.join(root, "target.js"), "export const target = true;\n");
  git(["add", "."], root); git(["commit", "-m", "initial"], root); return root;
}
function setup() {
  const local = repo();
  const p = createProject({ id: "app", name: "APP", repo: "example-org/app", local });
  p.observations = { inferredNext: [], local: { dirty: false, changedFiles: 0 } };
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSession(p, item.id, { worktreeRoot: fs.mkdtempSync(path.join(os.tmpdir(), "sumi-release-wt-")), now: NOW });
  const wt = started.session.workspace.path;
  fs.writeFileSync(path.join(wt, "auth.js"), "export const auth = true;\n");
  git(["-C", wt, "add", "auth.js"]); git(["-C", wt, "-c", "user.name=SUMI Test", "-c", "user.email=sumi-test@example.invalid", "commit", "-m", "implement auth"]);
  reviewSession(p, started.session.id, { runChecks: true, now: NOW });
  ingestReviewerResult(p, started.session.id, "VERDICT: MERGEABLE\nNo blocking findings. C001 stay open.", { now: NOW });
  return { p, started, wt, head: git(["-C", wt, "rev-parse", "HEAD"]) };
}
function evidence(session, head, patch = {}) {
  session.releaseEvidence = {
    observedAt: NOW.toISOString(),
    repo: "example-org/app",
    sessionId: session.id,
    branch: session.workspace.branch,
    expectedHead: head,
    source: "gh",
    ok: true,
    error: null,
    pr: {
      number: 17,
      title: "Implement auth",
      url: "https://github.example/pr/17",
      state: "OPEN",
      draft: false,
      headBranch: session.workspace.branch,
      baseBranch: "main",
      headSha: head,
      mergeable: "MERGEABLE",
      mergeState: "CLEAN",
      reviewDecision: "APPROVED",
      ci: "ready",
      checks: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS", url: null }],
      latestReviews: [],
      reviewRequests: [],
      ...patch
    }
  };
}

test("release gate requires session-specific GitHub evidence after MERGE_READY", () => {
  const { p, started } = setup();
  assert.equal(getReleaseReadiness(p, started.session.id, { now: NOW }).releaseStatus, RELEASE_STATUSES.SYNC_REQUIRED);
});

test("release gate becomes RELEASE_READY only when PR head, CI and GitHub merge state agree", () => {
  const { p, started, head } = setup();
  evidence(started.session, head);
  const row = getReleaseReadiness(p, started.session.id, { now: NOW });
  assert.equal(row.releaseStatus, RELEASE_STATUSES.READY);
  assert.equal(row.prNumber, 17);
  assert.equal(row.ci, "ready");
});

test("release gate invalidates stale external evidence", () => {
  const { p, started, head } = setup();
  evidence(started.session, head);
  const later = new Date(NOW.getTime() + 16 * 60 * 1000);
  assert.equal(getReleaseReadiness(p, started.session.id, { now: later, maxAgeMinutes: 15 }).releaseStatus, RELEASE_STATUSES.EVIDENCE_STALE);
});

test("release gate blocks a PR whose remote head differs from reviewed HEAD", () => {
  const { p, started, head } = setup();
  evidence(started.session, head, { headSha: "f".repeat(40) });
  assert.equal(getReleaseReadiness(p, started.session.id, { now: NOW }).releaseStatus, RELEASE_STATUSES.PR_HEAD_MISMATCH);
});

test("release gate preserves failing and pending CI as blockers", () => {
  const failed = setup(); evidence(failed.started.session, failed.head, { ci: "failed" });
  assert.equal(getReleaseReadiness(failed.p, failed.started.session.id, { now: NOW }).releaseStatus, RELEASE_STATUSES.CI_FAILED);
  const pending = setup(); evidence(pending.started.session, pending.head, { ci: "pending" });
  assert.equal(getReleaseReadiness(pending.p, pending.started.session.id, { now: NOW }).releaseStatus, RELEASE_STATUSES.CI_PENDING);
});

test("release gate respects GitHub required review state", () => {
  const { p, started, head } = setup();
  evidence(started.session, head, { reviewDecision: "REVIEW_REQUIRED" });
  assert.equal(getReleaseReadiness(p, started.session.id, { now: NOW }).releaseStatus, RELEASE_STATUSES.GITHUB_REVIEW_REQUIRED);
});

test("release gate blocks merge conflicts even after independent AI review", () => {
  const { p, started, head } = setup();
  evidence(started.session, head, { mergeable: "CONFLICTING", mergeState: "DIRTY" });
  assert.equal(getReleaseReadiness(p, started.session.id, { now: NOW }).releaseStatus, RELEASE_STATUSES.MERGE_CONFLICT);
});

test("normalizeReleasePr summarizes GitHub checks and review metadata", () => {
  const pr = normalizeReleasePr({
    number: 9, state: "OPEN", isDraft: false, headRefName: "feature/x", headRefOid: "abc", baseRefName: "main",
    mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED",
    statusCheckRollup: [{ name: "CI", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://example.test/check" }],
    latestReviews: [{ state: "APPROVED", author: { login: "reviewer" }, submittedAt: NOW.toISOString() }],
    reviewRequests: [{ login: "another-reviewer" }]
  });
  assert.equal(pr.ci, "ready");
  assert.equal(pr.checks[0].name, "CI");
  assert.equal(pr.latestReviews[0].author, "reviewer");
  assert.equal(pr.reviewRequests[0].login, "another-reviewer");
});

test("release queue prioritizes blocking release work before release-ready sessions", () => {
  const ready = setup(); ready.p.id = "ready"; ready.p.name = "READY"; evidence(ready.started.session, ready.head);
  const blocked = setup(); blocked.p.id = "blocked"; blocked.p.name = "BLOCKED"; evidence(blocked.started.session, blocked.head, { ci: "failed" });
  const rows = getReleaseQueue({ ready: ready.p, blocked: blocked.p }, { now: NOW });
  assert.equal(rows[0].releaseStatus, RELEASE_STATUSES.CI_FAILED);
  assert.equal(rows[1].releaseStatus, RELEASE_STATUSES.READY);
});


test("recordReleaseGate stores a HEAD-bound certification only for RELEASE_READY", () => {
  const { p, started, head } = setup();
  evidence(started.session, head);
  const row = getReleaseReadiness(p, started.session.id, { now: NOW });
  recordReleaseGate(p, started.session.id, row, { now: NOW });
  assert.equal(started.session.releaseCertification.head, head);
  assert.equal(started.session.releaseCertification.prNumber, 17);
});

// --- syncReleaseEvidence over REST ---------------------------------------

function restApi(routes) {
  const calls = [];
  const api = (route, params = {}) => {
    calls.push({ route, params });
    if (route.includes("graphql")) throw new Error("GraphQL must not be used");
    const hit = routes[route];
    if (hit === undefined) return { ok: false, error: `unrouted: ${route}` };
    return typeof hit === "function" ? hit(params) : { ok: true, data: hit };
  };
  api.calls = calls;
  return api;
}

function restPull(session, head, patch = {}) {
  return {
    number: 17, title: "Implement auth", html_url: "https://github.example/pr/17", state: "open", draft: false, merged_at: null,
    head: { ref: session.workspace.branch, sha: head, repo: { full_name: "example-org/app" } }, base: { ref: "main" },
    requested_reviewers: [], requested_teams: [], ...patch
  };
}

function releaseRoutes(session, head, { detail = {}, reviews = [], checkRuns = null, list = null } = {}) {
  const pull = restPull(session, head);
  return {
    "repos/example-org/app/pulls": list ?? [pull],
    "repos/example-org/app/pulls/17": { ...pull, mergeable: true, mergeable_state: "clean", ...detail },
    "repos/example-org/app/pulls/17/reviews": reviews,
    [`repos/example-org/app/commits/${head}/check-runs`]: { total_count: 1, check_runs: checkRuns ?? [{ name: "test", status: "completed", conclusion: "success" }] },
    [`repos/example-org/app/commits/${head}/status`]: { total_count: 0, statuses: [] }
  };
}

test("release evidence is read over REST and reaches RELEASE_READY without GraphQL", () => {
  const { p, started, head } = setup();
  const api = restApi(releaseRoutes(started.session, head, { reviews: [{ id: 1, user: { login: "rev" }, state: "APPROVED", submitted_at: "2026-09-11T09:00:00Z" }] }));
  const evidence = syncReleaseEvidence(p, started.session.id, { now: NOW, githubApi: api });
  assert.equal(evidence.ok, true, evidence.error);
  assert.equal(evidence.source, "gh-api");
  assert.equal(evidence.pr.reviewDecision, "APPROVED");
  assert.deepEqual(evidence.pr.latestReviews, [{ state: "APPROVED", author: "rev", submittedAt: "2026-09-11T09:00:00Z" }]);
  assert.equal(getReleaseReadiness(p, started.session.id, { now: NOW }).releaseStatus, RELEASE_STATUSES.READY);
  const list = api.calls.find((call) => call.route === "repos/example-org/app/pulls");
  assert.equal(list.params.head, `example-org:${started.session.workspace.branch}`, "only this repository's branch, never a fork's");
  assert.equal(list.params.state, "all");
});

test("REST review decision: a reviewer's latest decisive review counts, and changes requested wins", () => {
  const { p, started, head } = setup();
  const reviews = [
    { id: 1, user: { login: "a" }, state: "CHANGES_REQUESTED", submitted_at: "2026-09-11T08:00:00Z" },
    { id: 2, user: { login: "a" }, state: "COMMENTED", submitted_at: "2026-09-11T08:30:00Z" },
    { id: 3, user: { login: "b" }, state: "APPROVED", submitted_at: "2026-09-11T09:00:00Z" }
  ];
  syncReleaseEvidence(p, started.session.id, { now: NOW, githubApi: restApi(releaseRoutes(started.session, head, { reviews })) });
  assert.equal(getReleaseReadiness(p, started.session.id, { now: NOW }).releaseStatus, RELEASE_STATUSES.GITHUB_CHANGES_REQUESTED);

  reviews.push({ id: 4, user: { login: "a" }, state: "APPROVED", submitted_at: "2026-09-11T09:30:00Z" });
  syncReleaseEvidence(p, started.session.id, { now: NOW, githubApi: restApi(releaseRoutes(started.session, head, { reviews })) });
  assert.equal(getReleaseReadiness(p, started.session.id, { now: NOW }).releaseStatus, RELEASE_STATUSES.READY);
});

test("REST mergeability maps to the same gate decisions", () => {
  const { p, started, head } = setup();
  const decide = (detail) => {
    syncReleaseEvidence(p, started.session.id, { now: NOW, githubApi: restApi(releaseRoutes(started.session, head, { detail })) });
    return getReleaseReadiness(p, started.session.id, { now: NOW }).releaseStatus;
  };
  assert.equal(decide({ mergeable: false, mergeable_state: "dirty" }), RELEASE_STATUSES.MERGE_CONFLICT);
  assert.equal(decide({ mergeable_state: "behind" }), RELEASE_STATUSES.BRANCH_BEHIND);
  assert.equal(decide({ mergeable_state: "blocked" }), RELEASE_STATUSES.GITHUB_BLOCKED, "required review shows up here over REST");
  assert.equal(decide({ mergeable: null, mergeable_state: "unknown" }), RELEASE_STATUSES.MERGEABILITY_UNKNOWN);
  assert.equal(decide({ draft: true, mergeable_state: "draft" }), RELEASE_STATUSES.PR_DRAFT);
  assert.equal(decide({ state: "closed", merged_at: "2026-09-11T09:00:00Z" }), RELEASE_STATUSES.PR_NOT_OPEN);
});

test("REST CI: failing or missing checks keep the gate closed", () => {
  const { p, started, head } = setup();
  syncReleaseEvidence(p, started.session.id, { now: NOW, githubApi: restApi(releaseRoutes(started.session, head, { checkRuns: [{ name: "test", status: "completed", conclusion: "failure" }] })) });
  assert.equal(getReleaseReadiness(p, started.session.id, { now: NOW }).releaseStatus, RELEASE_STATUSES.CI_FAILED);
  syncReleaseEvidence(p, started.session.id, { now: NOW, githubApi: restApi(releaseRoutes(started.session, head, { checkRuns: [] })) });
  assert.notEqual(getReleaseReadiness(p, started.session.id, { now: NOW }).releaseStatus, RELEASE_STATUSES.READY);
});

test("any unreadable part of the REST evidence fails the sync; no PR is PR_REQUIRED", () => {
  const { p, started, head } = setup();
  const routes = releaseRoutes(started.session, head);
  delete routes["repos/example-org/app/pulls/17/reviews"];
  const evidence = syncReleaseEvidence(p, started.session.id, { now: NOW, githubApi: restApi(routes) });
  assert.equal(evidence.ok, false);
  assert.equal(getReleaseReadiness(p, started.session.id, { now: NOW }).releaseStatus, RELEASE_STATUSES.SYNC_FAILED);

  const moved = releaseRoutes(started.session, head, { detail: { head: { ref: started.session.workspace.branch, sha: "e".repeat(40) } } });
  assert.match(syncReleaseEvidence(p, started.session.id, { now: NOW, githubApi: restApi(moved) }).error, /moved while it was being read/);

  syncReleaseEvidence(p, started.session.id, { now: NOW, githubApi: restApi(releaseRoutes(started.session, head, { list: [] })) });
  assert.equal(getReleaseReadiness(p, started.session.id, { now: NOW }).releaseStatus, RELEASE_STATUSES.PR_REQUIRED);
});
