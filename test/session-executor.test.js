import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { addScopeCriterion, createProject } from "../src/domain.js";
import { createSessionTestContext } from "../src/sessions.js";
import { claudeArgsFromHelp, createSessionExecutorTestContext, parseClaudeJson, runSessionAgent as runSessionAgentProduction } from "../src/session-executor.js";

const NOW = new Date("2026-09-18T09:00:00.000Z");
const sessionTest = createSessionTestContext(() => new Date());
const executorTest = createSessionExecutorTestContext(() => new Date(), sessionTest);
const { runSessionAgent } = executorTest;
const { startSession } = sessionTest;
function git(args, cwd = null) { return execFileSync("git", args, { cwd: cwd || undefined, encoding: "utf8" }).trim(); }
function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-agent-repo-"));
  git(["init"], root); git(["config", "core.autocrlf", "false"], root);
  git(["config", "user.name", "SUMI Test"], root); git(["config", "user.email", "sumi-test@example.invalid"], root);
  fs.writeFileSync(path.join(root, "README.md"), "# primary\n", "utf8");
  git(["add", "README.md"], root); git(["commit", "-m", "initial"], root);
  return root;
}
function setup({ worktree = true, ttlMinutes = 120, now = NOW } = {}) {
  const repo = tempRepo();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-agent-worktrees-"));
  const project = createProject({ id: "app", name: "APP", repo: "owner/app", local: repo });
  project.observations = { inferredNext: [], local: { dirty: false, changedFiles: 0 } };
  const criterion = addScopeCriterion(project, "Implement authentication middleware", "todo");
  const started = startSession(project, criterion.id, { agent: "claude-code", worktree, worktreeRoot: root, ttlMinutes, now });
  return { repo, project, criterion, started };
}

test("Claude JSON output parser extracts the final result", () => {
  assert.equal(parseClaudeJson(JSON.stringify({ type: "result", result: "finished" })), "finished");
  assert.equal(parseClaudeJson("not json"), null);
});

test("Claude arguments enforce non-interactive isolated write policy", () => {
  const help = "--output-format --permission-mode --permission-prompts --setting-sources";
  assert.deepEqual(claudeArgsFromHelp(help, "do work"), [
    "-p", "do work", "--output-format", "json", "--permission-mode", "acceptEdits",
    "--permission-prompts", "none", "--setting-sources", "user"
  ]);
  assert.throws(() => claudeArgsFromHelp("--output-format", "do work"), /update Claude Code/);
});

test("session agent refuses shared primary-worktree execution", async () => {
  const { project, started } = setup({ worktree: false });
  await assert.rejects(() => runSessionAgent(project, started.session.id, {
    runner: async () => ({ ok: true, resultText: "done" }), now: NOW
  }), /must own a live SUMI-created worktree/);
});

test("session agent refuses an expired or missing lease", async () => {
  const { project, started } = setup({ ttlMinutes: 1 });
  await assert.rejects(() => runSessionAgent(project, started.session.id, {
    runner: async () => ({ ok: true, resultText: "done" }), now: new Date("2026-09-18T09:02:00.000Z")
  }), /does not own an active lease/);
});

test("Claude session execution runs only in the isolated worktree and links its result", async () => {
  const { repo, project, criterion, started } = setup();
  const workspace = started.session.workspace.path;
  const outcome = await runSessionAgent(project, started.session.id, {
    now: NOW,
    clock: () => NOW,
    runner: async ({ cwd, prompt, adapter }) => {
      assert.equal(path.normalize(cwd), path.normalize(workspace));
      assert.equal(adapter.id, "claude-code");
      assert.match(prompt, /Do not modify the primary worktree/);
      fs.writeFileSync(path.join(cwd, "agent-change.txt"), "isolated\n", "utf8");
      return { ok: true, status: 0, resultText: `Implemented isolated change. SUMI ${criterion.id} stays open pending review.` };
    }
  });
  assert.equal(outcome.execution.status, "completed");
  assert.equal(outcome.result.id, "R001");
  assert.equal(outcome.result.sessionId, started.session.id);
  assert.equal(started.session.executions[0].resultId, "R001");
  assert.equal(fs.existsSync(path.join(workspace, "agent-change.txt")), true);
  assert.equal(fs.existsSync(path.join(repo, "agent-change.txt")), false);
});

test("session agent rejects a stale completion even when the AI reports a past completion time", async () => {
  const { project, criterion, started } = setup({ ttlMinutes: 1 });
  const claimBefore = structuredClone(criterion.claim);
  const outcome = await runSessionAgent(project, started.session.id, {
    now: NOW,
    clock: () => new Date("2026-09-18T09:02:00.000Z"),
    runner: async () => ({
      ok: true,
      status: 0,
      resultText: `Verification complete. ${criterion.id} can move to done.`,
      completedAt: "2026-09-18T09:00:00.000Z"
    }),
    apply: true,
    finish: true
  });

  assert.equal(outcome.execution.status, "failed");
  assert.match(outcome.execution.reason, /active lease/);
  assert.equal(outcome.result, null);
  assert.equal(project.agentResults.length, 0);
  assert.equal(criterion.status, "todo");
  assert.deepEqual(criterion.claim, claimBefore);
  assert.equal(started.session.status, "active");
});

test("session agent rejects a lease when the clock rolls back after execution completes", async () => {
  const { project, criterion, started } = setup({ ttlMinutes: 1 });
  const completedAt = new Date("2026-09-18T09:02:00.000Z");
  const rollbackSessionApi = {
    ...sessionTest,
    ingestSessionResult: (currentProject, sessionId, text, options = {}) => sessionTest.ingestSessionResult(
      currentProject,
      sessionId,
      text,
      { ...options, now: new Date("2026-09-18T08:59:00.000Z") }
    )
  };
  const rollbackExecutor = createSessionExecutorTestContext(() => completedAt, rollbackSessionApi);

  const outcome = await rollbackExecutor.runSessionAgent(project, started.session.id, {
    now: NOW,
    runner: async () => ({
      ok: true,
      status: 0,
      resultText: `Verification complete. ${criterion.id} can move to done.`
    }),
    apply: true,
    finish: true
  });

  assert.equal(outcome.execution.status, "failed");
  assert.match(outcome.execution.reason, /active lease/);
  assert.equal(outcome.result, null);
  assert.equal(project.agentResults.length, 0);
  assert.equal(criterion.status, "todo");
  assert.equal(started.session.status, "active");
});

test("a clock rollback does not hide a crashed agent's exit status or reason", async () => {
  let current = Date.now();
  const clock = () => new Date(current);
  const sessions = createSessionTestContext(clock);
  const executor = createSessionExecutorTestContext(clock, sessions);
  const repo = tempRepo();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-agent-worktrees-"));
  const project = createProject({ id: "app", name: "APP", repo: "owner/app", local: repo });
  project.observations = { inferredNext: [], local: { dirty: false, changedFiles: 0 } };
  const criterion = addScopeCriterion(project, "Implement authentication middleware", "todo");
  const started = sessions.startSession(project, criterion.id, { agent: "claude-code", worktree: true, worktreeRoot: root });

  const outcome = await executor.runSessionAgent(project, started.session.id, {
    runner: async () => {
      current -= 60_000;
      return { ok: false, status: null, stdout: "", stderr: "", error: "agent crashed" };
    }
  });

  assert.equal(outcome.execution.status, "failed");
  assert.equal(outcome.execution.exitStatus, null, "a crash with no exit status must not be recorded as exit 0");
  assert.match(outcome.execution.reason, /clock rollback/);
  assert.match(outcome.execution.reason, /agent crashed/);
  assert.equal(outcome.result, null);
});

test("an invalid completion clock keeps a crashed agent's non-zero exit status", async () => {
  let reads = 0;
  const clock = () => (reads++ === 0 ? new Date() : "not-a-date");
  const sessions = createSessionTestContext(() => new Date());
  const executor = createSessionExecutorTestContext(clock, sessions);
  const { project, started } = setup({ now: new Date() });

  const outcome = await executor.runSessionAgent(project, started.session.id, {
    runner: async () => ({ ok: false, status: 3, stdout: "", stderr: "boom", error: null })
  });

  assert.equal(outcome.execution.status, "failed");
  assert.equal(outcome.execution.exitStatus, 3);
  assert.match(outcome.execution.reason, /invalid completion timestamp/);
  assert.match(outcome.execution.reason, /boom/);
});

test("session agent cannot use fixed now to bypass lease expiry during execution", async () => {
  const startNow = new Date(Date.now() - 2 * 60_000);
  const { project, criterion, started } = setup({ ttlMinutes: 1, now: startNow });
  const outcome = await runSessionAgent(project, started.session.id, {
    now: startNow,
    runner: async () => ({
      ok: true,
      status: 0,
      resultText: `Verification complete. ${criterion.id} stays open pending review.`
    })
  });

  assert.equal(outcome.execution.status, "failed");
  assert.match(outcome.execution.reason, /active lease/);
  assert.equal(outcome.result, null);
  assert.equal(project.agentResults.length, 0);
  assert.equal(criterion.status, "todo");
  assert.equal(started.session.status, "active");
});

test("production session agent ignores caller-supplied past time for lease authentication", async () => {
  const expiredAt = new Date(Date.now() - 2 * 60_000);
  const { project, criterion, started } = setup({ ttlMinutes: 1, now: expiredAt });
  await assert.rejects(() => runSessionAgentProduction(project, started.session.id, {
    now: expiredAt,
    runner: async () => ({
      ok: true,
      status: 0,
      resultText: `Verification complete. ${criterion.id} can move to done.`
    }),
    apply: true,
    finish: true
  }), /does not own an active lease/);

  assert.equal(project.agentResults.length, 0);
  assert.equal(criterion.status, "todo");
  assert.equal(started.session.status, "active");
});

test("session agent records completion using the injected trusted clock", async () => {
  const { project, criterion, started } = setup();
  const trustedCompletedAt = new Date("2026-09-18T09:00:03.000Z");
  const outcome = await runSessionAgent(project, started.session.id, {
    now: NOW,
    clock: () => trustedCompletedAt,
    runner: async () => ({
      ok: true,
      status: 0,
      resultText: `Verification complete. ${criterion.id} stays open pending review.`,
      completedAt: "2000-01-01T00:00:00.000Z"
    })
  });

  assert.equal(outcome.execution.status, "completed");
  assert.equal(outcome.execution.completedAt, trustedCompletedAt.toISOString());
});

test("session agent rejects a completion timestamp before the start timestamp", async () => {
  const { project, criterion, started } = setup();
  const outcome = await runSessionAgent(project, started.session.id, {
    now: NOW,
    clock: () => new Date("2026-09-18T08:59:59.000Z"),
    runner: async () => ({
      ok: true,
      status: 0,
      resultText: `Verification complete. ${criterion.id} stays open pending review.`
    })
  });

  assert.equal(outcome.execution.status, "failed");
  assert.match(outcome.execution.reason, /before it started/);
  assert.equal(outcome.result, null);
  assert.equal(project.agentResults.length, 0);
  assert.equal(criterion.status, "todo");
  assert.equal(started.session.status, "active");
});

test("failed Claude session execution is recorded without creating an agent result", async () => {
  const { project, started } = setup();
  const outcome = await runSessionAgent(project, started.session.id, {
    now: NOW,
    clock: () => NOW,
    runner: async () => ({ ok: false, status: 2, stderr: "permission denied" })
  });
  assert.equal(outcome.execution.status, "failed");
  assert.equal(outcome.execution.exitStatus, 2);
  assert.match(outcome.execution.reason, /permission denied/);
  assert.equal(outcome.result, null);
  assert.equal(project.agentResults.length, 0);
});
