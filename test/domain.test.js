import test from "node:test";
import assert from "node:assert/strict";
import {
  addScopeCriterion, addTask, createProject, getCompletion, getProjectStateLabel, getServiceState,
  getSetupGaps, isProductionObservable, PROJECT_STATES, SERVICE_UNUSED, setDeployment, setTaskStatus
} from "../src/domain.js";

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

test("service state distinguishes unregistered from deliberately unused", () => {
  const p = createProject({ id: "svc", name: "Svc" });
  assert.equal(getServiceState(p, "vercel").state, "unregistered");
  p.vercel = "";
  assert.equal(getServiceState(p, "vercel").state, "unregistered");
  p.vercel = SERVICE_UNUSED;
  assert.deepEqual(getServiceState(p, "vercel"), { state: "unused", name: null });
  p.vercel = "client-site";
  assert.deepEqual(getServiceState(p, "vercel"), { state: "registered", name: "client-site" });
  assert.equal(getServiceState(p, "supabase").state, "unregistered");
});

test("production is observable only through a registered, linked, or already observed source", () => {
  const p = createProject({ id: "obs", name: "Obs" });
  assert.equal(isProductionObservable(p), false);
  p.vercel = SERVICE_UNUSED;
  assert.equal(isProductionObservable(p), false);
  p.vercel = "obs-app";
  assert.equal(isProductionObservable(p), true);

  const linked = createProject({ id: "linked", name: "Linked" });
  linked.observations = { vercel: { linked: true } };
  assert.equal(isProductionObservable(linked), true);

  const manual = createProject({ id: "manual", name: "Manual" });
  setDeployment(manual, { production: "ready" });
  assert.equal(isProductionObservable(manual), true);
});

test("state label reports UNSCOPED instead of IN DEVELOPMENT without countable scope", () => {
  const p = createProject({ id: "unscoped", name: "Unscoped" });
  assert.equal(getProjectStateLabel(p), PROJECT_STATES.UNSCOPED);

  const cancelled = createProject({ id: "cancelled-only", name: "Cancelled Only" });
  addScopeCriterion(cancelled, "Dropped gate", "cancelled");
  assert.equal(getProjectStateLabel(cancelled), PROJECT_STATES.UNSCOPED);

  const open = createProject({ id: "open", name: "Open" });
  addScopeCriterion(open, "Auth verified", "todo");
  assert.equal(getProjectStateLabel(open), PROJECT_STATES.IN_DEVELOPMENT);
});

test("state label keeps DONE and IMPLEMENTED evidence rules unchanged", () => {
  const p = createProject({ id: "done", name: "Done" });
  addScopeCriterion(p, "Auth verified", "done");
  assert.equal(getProjectStateLabel(p), PROJECT_STATES.IMPLEMENTED);
  setDeployment(p, { production: "verified" });
  assert.equal(getProjectStateLabel(p), PROJECT_STATES.DONE);

  const unused = createProject({ id: "no-vercel", name: "No Vercel" });
  unused.vercel = SERVICE_UNUSED;
  setDeployment(unused, { production: "verified" });
  assert.equal(getProjectStateLabel(unused), PROJECT_STATES.UNSCOPED);
});

test("setup gaps name the exact command that closes them", () => {
  const client = createProject({ id: "client-site", name: "client International", repo: "owner/client-site" });
  const gaps = getSetupGaps(client);
  assert.deepEqual(gaps.map((gap) => gap.key), ["scope", "vercel"]);
  assert.ok(gaps[1].commands.some((command) => command.includes("sumi project set client-site --vercel")));
  assert.ok(gaps[0].commands.some((command) => command.includes("sumi scope add client-site")));

  client.vercel = SERVICE_UNUSED;
  assert.deepEqual(getSetupGaps(client).map((gap) => gap.key), ["scope"]);

  addScopeCriterion(client, "Production smoke test", "todo");
  assert.deepEqual(getSetupGaps(client), []);

  const linkedOnly = createProject({ id: "linked-only", name: "Linked Only" });
  linkedOnly.observations = { vercel: { linked: true } };
  assert.deepEqual(getSetupGaps(linkedOnly).map((gap) => gap.key), ["scope"]);
});
