import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { addScopeCriterion, createProject } from "../src/domain.js";
import { startSession } from "../src/sessions.js";
import { claudeArgsFromHelp, parseClaudeJson, runSessionAgent } from "../src/session-executor.js";

const NOW = new Date("2026-09-18T09:00:00.000Z");
function git(args, cwd = null) { return execFileSync("git", args, { cwd: cwd || undefined, encoding: "utf8" }).trim(); }
function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-agent-repo-"));
  git(["init"], root); git(["config", "core.autocrlf", "false"], root);
  git(["config", "user.name", "SUMI Test"], root); git(["config", "user.email", "sumi-test@example.invalid"], root);
  fs.writeFileSync(path.join(root, "README.md"), "# primary\n", "utf8");
  git(["add", "README.md"], root); git(["commit", "-m", "initial"], root);
  return root;
}
function setup({ worktree = true, ttlMinutes = 120 } = {}) {
  const repo = tempRepo();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-agent-worktrees-"));
  const project = createProject({ id: "app", name: "APP", repo: "owner/app", local: repo });
  project.observations = { inferredNext: [], local: { dirty: false, changedFiles: 0 } };
  const criterion = addScopeCriterion(project, "Implement authentication middleware", "todo");
  const started = startSession(project, criterion.id, { agent: "claude-code", worktree, worktreeRoot: root, ttlMinutes, now: NOW });
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

test("failed Claude session execution is recorded without creating an agent result", async () => {
  const { project, started } = setup();
  const outcome = await runSessionAgent(project, started.session.id, {
    now: NOW, runner: async () => ({ ok: false, status: 2, stderr: "permission denied" })
  });
  assert.equal(outcome.execution.status, "failed");
  assert.equal(outcome.execution.exitStatus, 2);
  assert.match(outcome.execution.reason, /permission denied/);
  assert.equal(outcome.result, null);
  assert.equal(project.agentResults.length, 0);
});
