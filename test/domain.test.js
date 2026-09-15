import test from "node:test";
import assert from "node:assert/strict";
import { addScopeCriterion, addTask, createProject, getCompletion, setDeployment, setTaskStatus } from "../src/domain.js";

test("whole-project progress stays unknown without explicit completion scope", () => {
  const p = createProject({ id: "musubu", name: "MUSUBU" });
  addTask(p, "Auth", "done");
  addTask(p, "E2E", "doing");
  const c = getCompletion(p);
  assert.equal(c.percent, null);
  assert.equal(c.basis, "none");
  assert.equal(c.complete, false);
});

test("implementation is not complete until explicit scope is done and production is verified", () => {
  const p = createProject({ id: "hanami", name: "Hanami" });
  addScopeCriterion(p, "Contact form verified", "done");
  let c = getCompletion(p);
  assert.equal(c.implementationDone, true);
  assert.equal(c.complete, false);
  setDeployment(p, { production: "verified" });
  c = getCompletion(p);
  assert.equal(c.complete, true);
  assert.ok(p.deployment.productionCheckedAt);
});

test("explicit scope becomes the authoritative project progress basis", async () => {
  const { addScopeCriterion, getProjectProgress } = await import("../src/domain.js");
  const p = createProject({ id: "scope-demo", name: "Scope Demo" });
  addScopeCriterion(p, "Auth verified", "done");
  addScopeCriterion(p, "Production smoke test", "todo");
  addTask(p, "Incidental maintenance task", "done");
  const progress = getProjectProgress(p);
  assert.equal(progress.basis, "scope");
  assert.equal(progress.percent, 50);
});

test("managed tasks never become whole-project percentage without explicit scope", async () => {
  const { getProjectProgress } = await import("../src/domain.js");
  const p = createProject({ id: "task-no-scope", name: "Task No Scope" });
  addTask(p, "A", "done");
  addTask(p, "B", "todo");
  const progress = getProjectProgress(p);
  assert.equal(progress.basis, "none");
  assert.equal(progress.percent, null);
});
