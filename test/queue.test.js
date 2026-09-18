import test from "node:test";
import assert from "node:assert/strict";
import { addScopeCriterion, createProject } from "../src/domain.js";
import { claimScopeCriterion } from "../src/claims.js";
import { formatGlobalQueue, getGlobalQueue, selectGlobalQueueItem } from "../src/queue.js";

function project(id, name) {
  const p = createProject({ id, name, repo: `owner/${id}`, local: `C:\\Dev\\${id}` });
  p.observations = { inferredNext: [], local: { dirty: false, changedFiles: 0 } };
  return p;
}

test("global queue prioritizes a ready human blocker across projects", () => {
  const musubu = project("musubu", "MUSUBU");
  musubu.deployment.pr = 183;
  musubu.deployment.ci = "failed";
  addScopeCriterion(musubu, "GitHub Billing / spending limitを解消し、PR #183のCIを正常に完了させる", "blocked");

  const hanami = project("hanami", "Hanami");
  addScopeCriterion(hanami, "PR #12の変更内容を確認しマージ可能状態にする", "doing");

  const rows = getGlobalQueue({ hanami, musubu });
  assert.equal(rows[0].projectId, "musubu");
  assert.equal(rows[0].queueClass, "human-blocker");
  assert.equal(rows[0].agent, "human");
  assert.ok(rows.some((item) => item.projectId === "hanami"));
});

test("global queue supports agent and state filters", () => {
  const musubu = project("musubu", "MUSUBU");
  addScopeCriterion(musubu, "認証フローを実ブラウザで検証する", "todo");
  addScopeCriterion(musubu, "PR #183の変更内容を確認しマージ可能状態にする", "doing");

  const browserRows = getGlobalQueue({ musubu }, { agent: "browser", state: "ready" });
  assert.equal(browserRows.length, 1);
  assert.equal(browserRows[0].agent, "browser");
  assert.equal(browserRows[0].state, "ready");
});

test("global queue excludes archived projects and validates limit", () => {
  const active = project("active", "Active");
  addScopeCriterion(active, "認証フローを実ブラウザで検証する", "todo");
  const archived = project("archived", "Archived");
  archived.lifecycle = "archived";
  addScopeCriterion(archived, "認証フローを実ブラウザで検証する", "todo");

  const rows = getGlobalQueue({ active, archived }, { limit: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].projectId, "active");
  assert.throws(() => getGlobalQueue({ active }, { limit: 0 }), /between 1 and 200/);
  assert.throws(() => getGlobalQueue({ active }, { agent: "unknown-agent" }), /Queue agent must be one of/);
  assert.throws(() => getGlobalQueue({ active }, { state: "done" }), /ready, claimed, or waiting/);
});

test("global queue formatter separates actionable and waiting work", () => {
  const musubu = project("musubu", "MUSUBU");
  musubu.deployment.pr = 183;
  musubu.deployment.ci = "failed";
  addScopeCriterion(musubu, "GitHub Billing / spending limitを解消し、PR #183のCIを正常に完了させる", "blocked");
  addScopeCriterion(musubu, "PR #183の変更内容を確認しマージ可能状態にする", "doing");

  const rows = getGlobalQueue({ musubu });
  const output = formatGlobalQueue({ musubu }, rows);
  assert.match(output, /HUMAN BLOCKERS/);
  assert.match(output, /WAITING/);
  assert.match(output, /MUSUBU \[musubu\]/);
});


test("global queue selector accepts display number and stable project:scope ID", () => {
  const musubu = project("musubu", "MUSUBU");
  addScopeCriterion(musubu, "認証フローを実ブラウザで検証する", "todo");
  const rows = getGlobalQueue({ musubu });
  assert.equal(selectGlobalQueueItem(rows, "1").scopeId, "C001");
  assert.equal(selectGlobalQueueItem(rows, "musubu:c001").projectId, "musubu");
  assert.throws(() => selectGlobalQueueItem(rows, "9"), /not found/);
});


test("global queue lists setup-incomplete projects separately from dispatchable work", () => {
  const client = project("client-site", "client International");
  client.observations = { inferredNext: ["Productionの反映状態を確認する"], local: { dirty: false, changedFiles: 0 } };

  const ready = project("ready-app", "Ready App");
  ready.vercel = "ready-app";
  addScopeCriterion(ready, "認証フローを実ブラウザで検証する", "todo");

  const rows = getGlobalQueue({ client, ready });
  assert.deepEqual(rows.map((row) => row.projectId), ["ready-app"]);

  const output = formatGlobalQueue({ client, ready }, rows);
  assert.match(output, /Setup: 1/);
  assert.match(output, /SETUP REQUIRED[\s\S]*client International \[client-site\] — scope, vercel/);
  assert.match(output, /sumi status client-site/);
  assert.equal(selectGlobalQueueItem(rows, "1").projectId, "ready-app");
});

test("global queue marks active leases as claimed and removes them from ready filter", () => {
  const app = project("app", "App");
  const item = addScopeCriterion(app, "Implement authentication middleware", "todo");
  claimScopeCriterion(app, item.id, { agent: "claude-code", owner: "worker-1", ttlMinutes: 120 });

  const rows = getGlobalQueue({ app });
  assert.equal(rows[0].state, "claimed");
  assert.equal(rows[0].queueClass, "claimed");
  assert.equal(rows[0].claim.owner, "worker-1");
  assert.equal(getGlobalQueue({ app }, { state: "ready" }).length, 0);
  assert.equal(getGlobalQueue({ app }, { state: "claimed" }).length, 1);
  assert.match(formatGlobalQueue({ app }, rows), /CLAIMED/);
});
