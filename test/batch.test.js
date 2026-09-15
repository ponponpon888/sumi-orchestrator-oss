import test from "node:test";
import assert from "node:assert/strict";
import { addScopeCriterion, createProject } from "../src/domain.js";
import { claimScopeCriterion } from "../src/claims.js";
import { buildBatchPlan, buildBatchPromptBundle, formatBatchPlan, selectBatch } from "../src/batch.js";

function project(id, name) {
  const p = createProject({ id, name, repo: `owner/${id}`, local: `C:\\Dev\\${id}` });
  p.observations = { inferredNext: [], local: { dirty: false, changedFiles: 0 } };
  return p;
}

test("batch plan parallelizes across projects but serializes work within one project", () => {
  const alpha = project("alpha", "Alpha");
  addScopeCriterion(alpha, "Implement authentication middleware", "todo");
  addScopeCriterion(alpha, "Implement account settings page", "todo");
  const beta = project("beta", "Beta");
  addScopeCriterion(beta, "Implement webhook validation", "todo");

  const plan = buildBatchPlan({ alpha, beta }, { maxConcurrency: 2 });
  assert.equal(plan.batches.length, 2);
  assert.equal(plan.batches[0].length, 2);
  assert.deepEqual(new Set(plan.batches[0].map((item) => item.projectId)), new Set(["alpha", "beta"]));
  assert.equal(plan.batches[1].length, 1);
  assert.equal(plan.batches[1][0].projectId, "alpha");
});

test("batch plan keeps human blockers outside AI concurrency and excludes waiting work", () => {
  const musubu = project("musubu", "MUSUBU");
  musubu.deployment.pr = 183;
  musubu.deployment.ci = "failed";
  addScopeCriterion(musubu, "GitHub Billing / spending limitを解消し、PR #183のCIを正常に完了させる", "blocked");
  addScopeCriterion(musubu, "PR #183の変更内容を確認しマージ可能状態にする", "doing");

  const plan = buildBatchPlan({ musubu });
  assert.equal(plan.humanActions.length, 1);
  assert.equal(plan.humanActions[0].agent, "human");
  assert.equal(plan.candidateCount, 0);
  assert.equal(plan.batches.length, 0);
  assert.ok(plan.waitingCount >= 1);
});

test("batch plan validates limits and supports agent filters", () => {
  const p = project("app", "App");
  addScopeCriterion(p, "認証フローを実ブラウザで検証する", "todo");
  addScopeCriterion(p, "Implement profile endpoint", "todo");

  const browserOnly = buildBatchPlan({ app: p }, { agent: "browser" });
  assert.equal(browserOnly.candidateCount, 1);
  assert.equal(browserOnly.batches[0][0].agent, "browser");
  assert.throws(() => buildBatchPlan({ app: p }, { maxConcurrency: 0 }), /between 1 and 16/);
  assert.throws(() => buildBatchPlan({ app: p }, { limit: 201 }), /between 1 and 200/);
  assert.throws(() => buildBatchPlan({ app: p }, { agent: "unknown" }), /Batch agent must be one of/);
});

test("batch formatter documents conservative concurrency policy", () => {
  const alpha = project("alpha", "Alpha");
  addScopeCriterion(alpha, "Implement authentication middleware", "todo");
  const plan = buildBatchPlan({ alpha });
  const output = formatBatchPlan({ alpha }, plan);
  assert.match(output, /SUMI PARALLEL PLAN/);
  assert.match(output, /One assignment per project in each batch/);
  assert.match(output, /BATCH 1/);
});

test("batch prompt bundle emits one evidence-backed prompt per parallel assignment", () => {
  const alpha = project("alpha", "Alpha");
  addScopeCriterion(alpha, "Implement authentication middleware", "todo");
  const beta = project("beta", "Beta");
  addScopeCriterion(beta, "認証フローを実ブラウザで検証する", "todo");

  const projects = { alpha, beta };
  const plan = buildBatchPlan(projects, { maxConcurrency: 2 });
  const bundle = buildBatchPromptBundle(projects, plan, "1");
  assert.match(bundle, /SUMI PARALLEL BATCH 1/);
  assert.match(bundle, /ASSIGNMENT 1\/2/);
  assert.match(bundle, /ASSIGNMENT 2\/2/);
  assert.match(bundle, /SUMI DISPATCH — Alpha/);
  assert.match(bundle, /SUMI DISPATCH — Beta/);
  assert.throws(() => selectBatch(plan, "9"), /Batch not found/);
});


test("batch plan excludes actively claimed work", () => {
  const app = project("app", "App");
  const item = addScopeCriterion(app, "Implement authentication middleware", "todo");
  claimScopeCriterion(app, item.id, { agent: "claude-code", owner: "worker-1" });
  const plan = buildBatchPlan({ app });
  assert.equal(plan.candidateCount, 0);
  assert.equal(plan.batches.length, 0);
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildBatchSessionPromptBundle, formatBatchSessions, startBatchSessions } from "../src/batch.js";

function git(args, cwd = null) {
  return execFileSync("git", args, { cwd: cwd || undefined, encoding: "utf8" }).trim();
}

function tempRepoForBatch(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(["init"], root);
  git(["config", "core.autocrlf", "false"], root);
  git(["config", "user.name", "SUMI Batch Test"], root);
  git(["config", "user.email", "sumi-batch@example.invalid"], root);
  fs.writeFileSync(path.join(root, "README.md"), "# batch\n", "utf8");
  git(["add", "README.md"], root);
  git(["commit", "-m", "initial"], root);
  return root;
}

test("batch can atomically reserve one isolated session per project", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-batch-wt-"));
  const alphaRepo = tempRepoForBatch("sumi-alpha-");
  const betaRepo = tempRepoForBatch("sumi-beta-");
  const alpha = project("alpha", "Alpha");
  alpha.local = alphaRepo;
  addScopeCriterion(alpha, "Implement authentication middleware", "todo");
  const beta = project("beta", "Beta");
  beta.local = betaRepo;
  addScopeCriterion(beta, "Implement webhook validation", "todo");

  const projects = { alpha, beta };
  const plan = buildBatchPlan(projects, { maxConcurrency: 2 });
  const outcome = startBatchSessions(projects, plan, "1", { worktreeRoot: root });
  assert.equal(outcome.items.length, 2);
  assert.equal(alpha.sessions.length, 1);
  assert.equal(beta.sessions.length, 1);
  assert.ok(fs.existsSync(alpha.sessions[0].workspace.path));
  assert.ok(fs.existsSync(beta.sessions[0].workspace.path));
  assert.match(formatBatchSessions(projects, outcome), /SUMI BATCH SESSIONS/);
  const prompts = buildBatchSessionPromptBundle(projects, outcome);
  assert.match(prompts, /SESSION 1\/2/);
  assert.match(prompts, /Do not modify the primary worktree/);
});

test("batch session startup rolls back earlier reservations when a later project fails", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-batch-wt-"));
  const alphaRepo = tempRepoForBatch("sumi-alpha-");
  const betaRepo = tempRepoForBatch("sumi-beta-");
  fs.writeFileSync(path.join(betaRepo, "dirty.txt"), "dirty\n", "utf8");

  const alpha = project("alpha", "Alpha");
  alpha.local = alphaRepo;
  addScopeCriterion(alpha, "Implement authentication middleware", "todo");
  const beta = project("beta", "Beta");
  beta.local = betaRepo;
  addScopeCriterion(beta, "Implement webhook validation", "todo");

  const projects = { alpha, beta };
  const plan = buildBatchPlan(projects, { maxConcurrency: 2 });
  assert.throws(() => startBatchSessions(projects, plan, "1", { worktreeRoot: root }), /Rolled back 1 started session/);
  assert.equal(alpha.sessions.length, 0);
  assert.equal(beta.sessions.length, 0);
  assert.equal(alpha.scope.criteria[0].claim, undefined);
  assert.equal(beta.scope.criteria[0].claim, undefined);
  assert.equal(git(["-C", alphaRepo, "branch", "--list", "sumi/alpha/*"]), "");
});
