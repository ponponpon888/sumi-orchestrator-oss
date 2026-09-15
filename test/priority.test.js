import test from "node:test";
import assert from "node:assert/strict";
import { addScopeCriterion, createProject, ensureProjectShape, setProjectPriority } from "../src/domain.js";
import { getGlobalQueue } from "../src/queue.js";
import { buildBatchPlan } from "../src/batch.js";

function make(id, priority) {
  const p = createProject({ id, name: id.toUpperCase(), repo: `owner/${id}`, local: `C:\\Dev\\${id}`, priority });
  p.observations = { inferredNext: [], local: { dirty: false, changedFiles: 0 } };
  return p;
}

test("projects default to P3 and priority validates P1 through P5", () => {
  const p = createProject({ id: "app", name: "App" });
  assert.equal(p.priority, 3);
  assert.equal(setProjectPriority(p, 1), 1);
  assert.equal(p.priority, 1);
  assert.throws(() => setProjectPriority(p, 0), /between 1 and 5/);
  assert.throws(() => setProjectPriority(p, 6), /between 1 and 5/);
});

test("legacy project shape receives default P3", () => {
  const p = createProject({ id: "legacy", name: "Legacy" });
  delete p.priority;
  ensureProjectShape(p);
  assert.equal(p.priority, 3);
});

test("global queue ranks higher-priority projects first", () => {
  const low = make("low", 4);
  const high = make("high", 1);
  addScopeCriterion(low, "Implement low priority feature", "todo");
  addScopeCriterion(high, "Implement high priority feature", "todo");
  const rows = getGlobalQueue({ low, high }, { state: "ready" });
  assert.equal(rows[0].projectId, "high");
  assert.equal(rows[0].projectPriority, 1);
});

test("same-priority queue interleaves route order before project id", () => {
  const alpha = make("alpha", 2);
  const beta = make("beta", 2);
  addScopeCriterion(alpha, "Implement alpha one", "todo");
  addScopeCriterion(alpha, "Implement alpha two", "todo");
  addScopeCriterion(beta, "Implement beta one", "todo");
  const rows = getGlobalQueue({ alpha, beta }, { state: "ready" });
  assert.deepEqual(rows.slice(0, 3).map((row) => `${row.projectId}:${row.order}`), ["alpha:1", "beta:1", "alpha:2"]);
});

test("batch planner inherits portfolio priority ordering", () => {
  const low = make("low", 5);
  const high = make("high", 1);
  addScopeCriterion(low, "Implement low priority feature", "todo");
  addScopeCriterion(high, "Implement high priority feature", "todo");
  const plan = buildBatchPlan({ low, high }, { maxConcurrency: 1 });
  assert.equal(plan.batches[0][0].projectId, "high");
  assert.equal(plan.batches[1][0].projectId, "low");
});
