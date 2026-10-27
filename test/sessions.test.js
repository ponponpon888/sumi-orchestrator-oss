import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { addScopeCriterion, createProject, setScopeCriterionStatus } from "../src/domain.js";
import { getActiveClaim } from "../src/claims.js";
import {
  createSessionTestContext,
  cleanupSessionWorkspace,
  formatSessions,
  ingestSessionResult as ingestSessionResultProduction,
  inspectSessionWorkspace,
  listSessions,
  startSession as startSessionProduction,
} from "../src/sessions.js";

const NOW = new Date("2026-09-11T09:00:00.000Z");
const sessionTest = createSessionTestContext(() => new Date());
const {
  buildSessionPrompt,
  finishSession,
  ingestSessionResult,
  renewSession,
  startSession,
  validateSessionLease
} = sessionTest;

function project(id = "app", local = `C:\\Dev\\${id}`) {
  const p = createProject({ id, name: id.toUpperCase(), repo: `owner/${id}`, local });
  p.observations = { inferredNext: [], local: { dirty: false, changedFiles: 0 } };
  return p;
}

function git(args, cwd = null) {
  return execFileSync("git", args, { cwd: cwd || undefined, encoding: "utf8" }).trim();
}

function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-session-repo-"));
  git(["init"], root);
  git(["config", "core.autocrlf", "false"], root);
  git(["config", "user.name", "SUMI Test"], root);
  git(["config", "user.email", "sumi-test@example.invalid"], root);
  fs.writeFileSync(path.join(root, "README.md"), "# test\n", "utf8");
  git(["add", "README.md"], root);
  git(["commit", "-m", "initial"], root);
  return root;
}

test("session start owns a claim and prevents duplicate active sessions", () => {
  const p = project();
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const outcome = startSession(p, item.id, { agent: "claude-code", worktree: false, now: NOW });
  assert.equal(outcome.session.id, "S001");
  assert.equal(outcome.session.status, "active");
  assert.equal(outcome.session.workspace.mode, "shared");
  assert.equal(item.claim.sessionId, "S001");
  assert.throws(() => startSession(p, item.id, { agent: "claude-code", owner: "worker-2", worktree: false, now: NOW }), /active session S001/);
});

test("expired session lease is preserved as expired and can be taken over", () => {
  const p = project();
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const first = startSession(p, item.id, { agent: "claude-code", worktree: false, ttlMinutes: 1, now: NOW });
  const later = new Date("2026-09-11T09:02:00.000Z");
  const second = startSession(p, item.id, { agent: "claude-code", owner: "worker-2", worktree: false, now: later });
  assert.equal(first.session.status, "expired");
  assert.equal(second.session.id, "S002");
  assert.equal(item.claim.sessionId, "S002");
});

test("session renew extends its lease", () => {
  const p = project();
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSession(p, item.id, { agent: "claude-code", worktree: false, ttlMinutes: 30, now: NOW });
  const later = new Date("2026-09-11T09:10:00.000Z");
  const renewed = renewSession(p, started.session.id, { ttlMinutes: 60, now: later });
  assert.equal(renewed.session.claimExpiresAt, "2026-09-11T10:10:00.000Z");
  assert.equal(getActiveClaim(item, { now: later })?.sessionId, "S001");
});

test("expired session lease renews when the claim still exactly matches its session", () => {
  const p = project();
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSession(p, item.id, { agent: "claude-code", worktree: false, ttlMinutes: 1, now: NOW });
  const renewedAt = new Date("2026-09-11T09:02:00.000Z");

  const renewed = renewSession(p, started.session.id, { ttlMinutes: 30, now: renewedAt });

  assert.equal(renewed.claim.sessionId, started.session.id);
  assert.equal(renewed.claim.owner, started.session.owner);
  assert.equal(renewed.claim.agent, started.session.agent);
  assert.equal(renewed.claim.expiresAt, "2026-09-11T09:32:00.000Z");
});

test("session lease validation requires exact session, owner, and agent ownership", () => {
  const p = project();
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSession(p, item.id, { agent: "claude-code", worktree: false, now: NOW });

  item.claim.owner = "other-owner";
  assert.throws(() => validateSessionLease(p, started.session.id, { now: NOW }), /active lease/);

  item.claim.owner = started.session.owner;
  item.claim.agent = "browser";
  assert.throws(() => validateSessionLease(p, started.session.id, { now: NOW }), /active lease/);

  item.claim.agent = started.session.agent;
  item.claim.sessionId = "S999";
  assert.throws(() => validateSessionLease(p, started.session.id, { now: NOW }), /active lease/);

  delete item.claim;
  assert.throws(() => validateSessionLease(p, started.session.id, { now: NOW }), /active lease/);
});

test("session renew rejects a claim owned by another session, owner, or agent", () => {
  const mutations = [
    ["sessionId", "S999"],
    ["owner", "other-owner"],
    ["agent", "browser"]
  ];

  for (const [field, value] of mutations) {
    const p = project();
    const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
    const started = startSession(p, item.id, { agent: "claude-code", worktree: false, now: NOW });
    item.claim[field] = value;

    assert.throws(
      () => renewSession(p, started.session.id, { ttlMinutes: 30, now: NOW }),
      /not owned by session/
    );
  }

  const missingClaimProject = project();
  const missingClaimItem = addScopeCriterion(missingClaimProject, "Implement authentication middleware", "todo");
  const missingClaimSession = startSession(missingClaimProject, missingClaimItem.id, {
    agent: "claude-code", worktree: false, now: NOW
  });
  delete missingClaimItem.claim;
  assert.throws(
    () => renewSession(missingClaimProject, missingClaimSession.session.id, { ttlMinutes: 30, now: NOW }),
    /not owned by session/
  );
});

test("expired session lease is rejected before prompt generation", () => {
  const p = project();
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSession(p, item.id, { agent: "claude-code", worktree: false, ttlMinutes: 1, now: NOW });

  assert.throws(() => buildSessionPrompt(p, started.session.id, {
    now: new Date("2026-09-11T09:02:00.000Z")
  }), /active lease/);
});

test("prompt generation is rejected when the session loses ownership", () => {
  const p = project();
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSession(p, item.id, { agent: "claude-code", worktree: false, now: NOW });
  item.claim.sessionId = "S999";

  assert.throws(() => buildSessionPrompt(p, started.session.id, { now: NOW }), /active lease/);
});

test("prompt generation is rejected when the lease expiry is invalid", () => {
  const p = project();
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSession(p, item.id, { agent: "claude-code", worktree: false, now: NOW });
  item.claim.expiresAt = "not-a-date";

  assert.throws(() => buildSessionPrompt(p, started.session.id, { now: NOW }), /active lease/);
});

test("prompt generation succeeds while the session lease is valid", () => {
  const p = project();
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSession(p, item.id, { agent: "claude-code", worktree: false, now: NOW });

  const prompt = buildSessionPrompt(p, started.session.id, { now: NOW });
  assert.match(prompt, /Execution session/);
  assert.match(prompt, /S001/);
});

test("finishing a session releases only its own claim", () => {
  const p = project();
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSession(p, item.id, { agent: "claude-code", worktree: false, now: NOW });
  const outcome = finishSession(p, started.session.id, { now: NOW });
  assert.equal(outcome.session.status, "completed");
  assert.equal(outcome.session.claimReleased, true);
  assert.equal(item.claim, undefined);
});

test("code-agent session creates an isolated git worktree and cleanup removes it only after finish", () => {
  const repo = tempRepo();
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-session-worktrees-"));
  const p = project("app", repo);
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");

  const started = startSession(p, item.id, { agent: "claude-code", worktreeRoot, now: NOW });
  const workspace = started.session.workspace;
  assert.equal(workspace.mode, "worktree");
  assert.ok(fs.existsSync(workspace.path));
  assert.equal(path.normalize(git(["-C", workspace.path, "rev-parse", "--show-toplevel"])), path.normalize(workspace.path));
  assert.match(workspace.branch, /^sumi\/app\/c001-s001$/);
  assert.throws(() => cleanupSessionWorkspace(p, started.session.id, { now: NOW }), /is active/);

  const prompt = buildSessionPrompt(p, started.session.id, { now: NOW });
  assert.match(prompt, /Execution session/);
  assert.match(prompt, /Do not modify the primary worktree/);
  assert.match(prompt, /S001/);

  finishSession(p, started.session.id, { now: NOW });
  const cleaned = cleanupSessionWorkspace(p, started.session.id, { now: NOW });
  assert.equal(cleaned.removed, true);
  assert.equal(fs.existsSync(workspace.path), false);
  assert.ok(git(["-C", repo, "branch", "--list", workspace.branch]));
});

test("cleanup refuses to delete a dirty session worktree", () => {
  const repo = tempRepo();
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-session-worktrees-"));
  const p = project("app", repo);
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSession(p, item.id, { agent: "claude-code", worktreeRoot, now: NOW });
  fs.writeFileSync(path.join(started.session.workspace.path, "dirty.txt"), "unsaved\n", "utf8");
  finishSession(p, started.session.id, { now: NOW });
  assert.throws(() => cleanupSessionWorkspace(p, started.session.id, { now: NOW }), /Refusing to remove dirty/);
  assert.equal(fs.existsSync(started.session.workspace.path), true);
});

test("completing scope automatically closes its active execution session", () => {
  const p = project();
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSession(p, item.id, { agent: "claude-code", worktree: false, now: NOW });
  setScopeCriterionStatus(p, item.id, "done");
  assert.equal(started.session.status, "completed");
  assert.equal(started.session.claimReleased, true);
  assert.equal(item.claim, undefined);
});

test("session listing surfaces stale leases", () => {
  const p = project();
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  startSession(p, item.id, { agent: "claude-code", worktree: false, ttlMinutes: 1, now: NOW });
  const later = new Date("2026-09-11T09:02:00.000Z");
  const rows = listSessions({ app: p }, { now: later });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].leaseActive, false);
  assert.match(formatSessions(rows), /LEASE-STALE/);
});

test("session start uses Router agent when agent is omitted", () => {
  const p = project();
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSession(p, item.id, { worktree: false, now: NOW });
  assert.equal(started.session.agent, "claude-code");
});

test("session start rejects an explicit agent that conflicts with Router", () => {
  const p = project();
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  assert.throws(() => startSession(p, item.id, { agent: "codex", worktree: false, now: NOW }), /routes to claude-code, not codex/);
});

test("worktree session refuses a dirty primary repository", () => {
  const repo = tempRepo();
  fs.writeFileSync(path.join(repo, "uncommitted.txt"), "dirty\n", "utf8");
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-session-worktrees-"));
  const p = project("app", repo);
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  assert.throws(() => startSession(p, item.id, { worktreeRoot, now: NOW }), /Primary worktree is dirty/);
  assert.equal(item.claim, undefined);
});

test("worktree session refuses a workspace root inside the primary repository", () => {
  const repo = tempRepo();
  const p = project("app", repo);
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  assert.throws(() => startSession(p, item.id, { worktreeRoot: path.join(repo, ".sumi-worktrees"), now: NOW }), /must be outside the primary repository/);
  assert.equal(item.claim, undefined);
});

test("session result inherits session agent/scope and links result to the session", () => {
  const p = project();
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSession(p, item.id, { worktree: false, now: NOW });
  const outcome = ingestSessionResult(p, started.session.id, "Inspected auth middleware. C001 stay open pending an additional edge-case test.", { now: NOW });
  assert.equal(outcome.result.scopeId, item.id);
  assert.equal(outcome.result.agent, "claude-code");
  assert.equal(outcome.result.sessionId, "S001");
  assert.equal(outcome.session.status, "active");
});

test("expired session result is rejected before changing scope or result history", () => {
  const p = project();
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSession(p, item.id, { worktree: false, ttlMinutes: 1, now: NOW });
  const claimBefore = structuredClone(item.claim);

  assert.throws(() => ingestSessionResult(p, started.session.id, "C001 can move to done.", {
    apply: true,
    finish: true,
    now: new Date("2026-09-11T09:02:00.000Z")
  }), /active lease/);
  assert.equal(item.status, "todo");
  assert.deepEqual(item.claim, claimBefore);
  assert.equal(p.agentResults.length, 0);
  assert.equal(started.session.status, "active");
});

test("session result is rejected when the claim belongs to another session", () => {
  const p = project();
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSession(p, item.id, { worktree: false, now: NOW });
  item.claim.sessionId = "S999";

  assert.throws(() => ingestSessionResult(p, started.session.id, "C001 can move to done.", {
    apply: true,
    now: NOW
  }), /active lease/);
  assert.equal(item.status, "todo");
  assert.equal(p.agentResults.length, 0);
});

test("session result is rejected when the claim expiry is invalid", () => {
  const p = project();
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSession(p, item.id, { worktree: false, now: NOW });
  item.claim.expiresAt = "not-a-date";

  assert.throws(() => ingestSessionResult(p, started.session.id, "C001 can move to done.", { now: NOW }), /active lease/);
  assert.equal(item.status, "todo");
  assert.equal(p.agentResults.length, 0);
});

test("renewed session can ingest a result after its original lease expired", () => {
  const p = project();
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSession(p, item.id, { worktree: false, ttlMinutes: 1, now: NOW });
  const renewedAt = new Date("2026-09-11T09:02:00.000Z");
  renewSession(p, started.session.id, { ttlMinutes: 30, now: renewedAt });

  const outcome = ingestSessionResult(p, started.session.id, "C001 can move to done.", {
    apply: true,
    now: renewedAt
  });
  assert.equal(outcome.result.sessionId, started.session.id);
  assert.equal(item.status, "done");
  assert.equal(p.agentResults.length, 1);
});

test("session result apply automatically closes session when the scope gate becomes done", () => {
  const p = project();
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSession(p, item.id, { worktree: false, now: NOW });
  const outcome = ingestSessionResult(p, started.session.id, "Verification complete. C001 can move to done.", { apply: true, now: NOW });
  assert.equal(item.status, "done");
  assert.equal(outcome.session.status, "completed");
  assert.equal(item.claim, undefined);
  assert.equal(outcome.result.appliedChanges[0].to, "done");
});

test("session result --finish semantics release the lease while leaving an open gate", () => {
  const p = project();
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSession(p, item.id, { worktree: false, now: NOW });
  const outcome = ingestSessionResult(p, started.session.id, "Reviewed the current implementation. More work remains.", { finish: true, now: NOW });
  assert.equal(item.status, "todo");
  assert.equal(outcome.session.status, "completed");
  assert.equal(item.claim, undefined);
});

test("future minimumNow cannot move public session audit timestamps forward", () => {
  const p = project();
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSessionProduction(p, item.id, { agent: "claude-code", worktree: false, ttlMinutes: 10 });
  const before = Date.now();
  const future = new Date(before + 5 * 60_000);
  const outcome = ingestSessionResultProduction(p, started.session.id, "Reviewed the current implementation. More work remains.", {
    apply: true,
    finish: true,
    minimumNow: future
  });

  const after = Date.now();
  for (const [label, value] of [
    ["appliedAt", outcome.result.appliedAt],
    ["endedAt", outcome.session.endedAt],
    ["claim updatedAt", item.updatedAt]
  ]) {
    const timestamp = Date.parse(value);
    assert.ok(timestamp >= before && timestamp <= after, `${label} must come from the production clock`);
    assert.ok(timestamp < future.getTime(), `${label} must not use minimumNow`);
  }
});

test("ended session rejects duplicate result ingestion", () => {
  const p = project();
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSession(p, item.id, { worktree: false, now: NOW });
  finishSession(p, started.session.id, { now: NOW });
  assert.throws(() => ingestSessionResult(p, started.session.id, "late duplicate result", { now: NOW }), /only be ingested into an active session/);
});

test("session workspace inspection reports clean base state", () => {
  const repo = tempRepo();
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-session-worktrees-"));
  const p = project("app", repo);
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSession(p, item.id, { worktreeRoot, now: NOW });
  const inspection = inspectSessionWorkspace(p, started.session.id);
  assert.equal(inspection.exists, true);
  assert.equal(inspection.dirty, false);
  assert.equal(inspection.commitsAhead, 0);
  assert.equal(inspection.commitsBehind, 0);
  assert.equal(inspection.head, started.session.workspace.baseCommit);
});

test("session workspace inspection reports dirty files and committed progress", () => {
  const repo = tempRepo();
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-session-worktrees-"));
  const p = project("app", repo);
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSession(p, item.id, { worktreeRoot, now: NOW });
  const wt = started.session.workspace.path;

  fs.writeFileSync(path.join(wt, "auth.js"), "export const auth = true;\n", "utf8");
  let inspection = inspectSessionWorkspace(p, started.session.id);
  assert.equal(inspection.dirty, true);
  assert.equal(inspection.changedFiles.length, 1);
  assert.match(inspection.changedFiles[0].path, /auth\.js/);

  git(["-C", wt, "add", "auth.js"]);
  git(["-C", wt, "-c", "user.name=SUMI Test", "-c", "user.email=sumi-test@example.invalid", "commit", "-m", "auth"]);
  inspection = inspectSessionWorkspace(p, started.session.id);
  assert.equal(inspection.dirty, false);
  assert.equal(inspection.commitsAhead, 1);
});

test("session workspace inspection warns when worker switched branches", () => {
  const repo = tempRepo();
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-session-worktrees-"));
  const p = project("app", repo);
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSession(p, item.id, { worktreeRoot, now: NOW });
  const wt = started.session.workspace.path;
  git(["-C", wt, "switch", "-c", "unexpected-branch"]);
  const inspection = inspectSessionWorkspace(p, started.session.id);
  assert.equal(inspection.branch, "unexpected-branch");
  assert.match(inspection.warnings[0], /Expected branch/);
});

test("session workspace inspection reports removed workspace after cleanup", () => {
  const repo = tempRepo();
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-session-worktrees-"));
  const p = project("app", repo);
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSession(p, item.id, { worktreeRoot, now: NOW });
  finishSession(p, started.session.id, { now: NOW });
  cleanupSessionWorkspace(p, started.session.id, { now: NOW });
  const inspection = inspectSessionWorkspace(p, started.session.id);
  assert.equal(inspection.exists, false);
  assert.equal(inspection.removed, true);
});
