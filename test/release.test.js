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
import { getReleaseQueue, getReleaseReadiness, normalizeReleasePr, recordReleaseGate, RELEASE_STATUSES } from "../src/release.js";

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
