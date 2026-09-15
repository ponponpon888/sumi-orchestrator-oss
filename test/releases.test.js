import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { addScopeCriterion, createProject, ensureProjectShape, getCompletion } from "../src/domain.js";
import { startSession } from "../src/sessions.js";
import { finalizeDeliveredSession, getReleaseHistory } from "../src/releases.js";

const NOW = new Date("2026-09-12T01:00:00.000Z");
const MERGE = "a".repeat(40);
function git(args, cwd = null) { return execFileSync("git", args, { cwd: cwd || undefined, encoding: "utf8" }).trim(); }
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-release-history-repo-"));
  git(["init"], root);
  git(["config", "core.autocrlf", "false"], root);
  git(["config", "user.name", "SUMI Test"], root);
  git(["config", "user.email", "sumi-test@example.invalid"], root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }, null, 2) + "\n");
  fs.writeFileSync(path.join(root, "target.js"), "export const target = true;\n");
  git(["add", "."], root);
  git(["commit", "-m", "initial"], root);
  return root;
}

function setup() {
  const local = repo();
  const p = createProject({ id: "app", name: "APP", repo: "example-org/app", local, vercel: "app", priority: 2 });
  p.observations = { inferredNext: [], local: { dirty: false, changedFiles: 0 } };
  const item = addScopeCriterion(p, "Ship authentication middleware", "todo");
  const started = startSession(p, item.id, { worktreeRoot: fs.mkdtempSync(path.join(os.tmpdir(), "sumi-release-history-wt-")), now: NOW });
  const head = git(["-C", started.session.workspace.path, "rev-parse", "HEAD"]);
  started.session.lastReview = {
    checks: [{ id: "test", label: "npm test", ok: true }],
    workspace: { head }
  };
  started.session.lastReviewerResult = { resultId: "AR001", agent: "codex", verdict: "MERGEABLE", reviewedHead: head, createdAt: NOW.toISOString() };
  started.session.releaseCertification = {
    certifiedAt: NOW.toISOString(), repo: p.repo, prNumber: 17, prUrl: "https://example.test/pr/17",
    branch: started.session.workspace.branch, head, releaseStatus: "RELEASE_READY"
  };
  started.session.lastReleaseGate = {
    evaluatedAt: NOW.toISOString(), ci: "ready", reviewDecision: "APPROVED"
  };
  started.session.deliveryEvidence = {
    observedAt: NOW.toISOString(), sessionId: started.session.id, repo: p.repo,
    source: { github: true, production: true }, ok: true, error: null,
    pr: { number: 17, state: "MERGED", mergedAt: NOW.toISOString(), headSha: head, mergeCommit: MERGE, url: "https://example.test/pr/17" },
    production: { status: "ready", rawStatus: "READY", url: "https://app-prod.vercel.app", environment: "Production" }
  };
  started.session.deliveryVerification = { verifiedAt: NOW.toISOString(), mergeCommit: MERGE, url: "https://app-prod.vercel.app", note: "smoke passed" };
  return { p, item, started, head };
}

test("legacy project shape gains an empty release history", () => {
  const p = createProject({ id: "legacy", name: "Legacy" });
  delete p.releases;
  ensureProjectShape(p);
  assert.deepEqual(p.releases, []);
});

test("finalizing a delivered session closes scope, session and claim and records release history", () => {
  const { p, item, started, head } = setup();
  assert.ok(item.claim);
  const outcome = finalizeDeliveredSession(p, started.session.id, { now: NOW });
  assert.equal(item.status, "done");
  assert.equal(item.claim, undefined);
  assert.equal(started.session.status, "completed");
  assert.equal(started.session.releaseRecordId, "R001");
  assert.equal(p.releases.length, 1);
  assert.equal(outcome.release.certifiedHead, head);
  assert.equal(outcome.release.mergeCommit, MERGE);
  assert.equal(outcome.release.prNumber, 17);
  assert.equal(outcome.release.reviewer, "codex");
  assert.equal(outcome.release.verificationChecks[0].ok, true);
  assert.equal(outcome.release.productionVerificationNote, "smoke passed");
  assert.equal(p.deployment.commit, MERGE);
  assert.equal(p.deployment.pr, 17);
  assert.equal(p.deployment.ci, "ready");
  assert.equal(p.deployment.production, "verified");
  assert.equal(p.deployment.productionCheckedAt, NOW.toISOString());
  assert.equal(getCompletion(p).complete, true);
  assert.equal(outcome.cleanup.status, "retained");
});

test("finalization is idempotent and does not duplicate release records", () => {
  const { p, started } = setup();
  const first = finalizeDeliveredSession(p, started.session.id, { now: NOW });
  const second = finalizeDeliveredSession(p, started.session.id, { now: new Date(NOW.getTime() + 1000) });
  assert.equal(first.release.id, second.release.id);
  assert.equal(second.alreadyFinalized, true);
  assert.equal(p.releases.length, 1);
});

test("finalization refuses a session that is not DELIVERED", () => {
  const { p, started } = setup();
  delete started.session.deliveryVerification;
  assert.throws(() => finalizeDeliveredSession(p, started.session.id, { now: NOW }), /PRODUCTION_VERIFICATION_REQUIRED/);
  assert.equal(p.releases.length, 0);
});

test("finalization refuses to close a scope that has a newer active session", () => {
  const { p, item, started } = setup();
  delete item.claim;
  started.session.status = "expired";
  p.sessions.push({ id: "S999", scopeId: item.id, task: item.text, agent: "codex", owner: "new", status: "active", startedAt: NOW.toISOString(), workspace: { mode: "shared" } });
  assert.throws(() => finalizeDeliveredSession(p, started.session.id, { now: NOW }), /newer active session S999/);
  assert.equal(item.status, "todo");
});

test("finalization refuses to erase a manual claim owned by another worker", () => {
  const { p, item, started } = setup();
  started.session.status = "expired";
  item.claim = { agent: "human", owner: "release-manager", claimedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 60000).toISOString() };
  assert.throws(() => finalizeDeliveredSession(p, started.session.id, { now: NOW }), /claimed by release-manager/);
  assert.equal(item.status, "todo");
  assert.equal(item.claim.owner, "release-manager");
});

test("--cleanup semantics remove a clean SUMI worktree after lifecycle closure", () => {
  const { p, started } = setup();
  const wt = started.session.workspace.path;
  assert.equal(fs.existsSync(wt), true);
  const outcome = finalizeDeliveredSession(p, started.session.id, { now: NOW, cleanup: true });
  assert.equal(outcome.cleanup.status, "removed");
  assert.equal(fs.existsSync(wt), false);
  assert.ok(started.session.workspace.removedAt);
  assert.equal(outcome.release.workspaceCleanup.status, "removed");
});

test("dirty worktree is retained without rolling back release finalization", () => {
  const { p, item, started } = setup();
  fs.writeFileSync(path.join(started.session.workspace.path, "uncommitted.txt"), "keep me\n");
  const outcome = finalizeDeliveredSession(p, started.session.id, { now: NOW, cleanup: true });
  assert.equal(outcome.cleanup.status, "retained");
  assert.match(outcome.cleanup.reason, /Refusing to remove dirty session worktree/);
  assert.equal(item.status, "done");
  assert.equal(started.session.status, "completed");
  assert.equal(p.releases.length, 1);
  assert.equal(fs.existsSync(started.session.workspace.path), true);
});

test("release history spans projects and sorts newest delivery first", () => {
  const older = setup(); older.p.id = "older"; older.p.name = "OLDER";
  const newer = setup(); newer.p.id = "newer"; newer.p.name = "NEWER";
  finalizeDeliveredSession(older.p, older.started.session.id, { now: NOW });
  finalizeDeliveredSession(newer.p, newer.started.session.id, { now: new Date(NOW.getTime() + 60000) });
  const rows = getReleaseHistory({ older: older.p, newer: newer.p });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].projectId, "newer");
  assert.equal(rows[1].projectId, "older");
  assert.equal(getReleaseHistory({ older: older.p, newer: newer.p }, { projectId: "older" }).length, 1);
});

test("release history validates its display limit", () => {
  assert.throws(() => getReleaseHistory({}, { limit: 0 }), /between 1 and 1000/);
  assert.throws(() => getReleaseHistory({}, { limit: "x" }), /between 1 and 1000/);
});
