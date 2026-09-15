import test from "node:test";
import assert from "node:assert/strict";
import { addScopeCriterion, createProject } from "../src/domain.js";
import { applyBlockerRecovery, formatBlockerRecovery, getBlockerRecovery } from "../src/recovery.js";

function billingProject() {
  const p = createProject({ id: "musubu", name: "MUSUBU" });
  const c = addScopeCriterion(p, "GitHub Billing / spending limitを解消し、PR #183のCIを正常に完了させる", "blocked");
  p.deployment.pr = 183;
  p.deployment.ci = "failed";
  p.observations = {
    github: { workflowRuns: [], failedJobs: [{ name: "Vitest", failedSteps: [] }] }
  };
  p.agentResults = [{
    id: "R001",
    agent: "codex",
    evidence: [{ key: "github-billing", label: "GitHub Actions is blocked by billing/spending limit", detail: "runner起動前に停止" }],
    addedCriteria: [{ criterionId: c.id, status: "blocked", text: c.text }]
  }];
  return { p, c };
}

test("billing blocker stays blocked when failed CI has no runner-step evidence", () => {
  const { p, c } = billingProject();
  const r = getBlockerRecovery(p, c.id);
  assert.equal(r.suggestion, null);
  assert.match(formatBlockerRecovery(p, r), /Keep this gate blocked/);
  assert.match(formatBlockerRecovery(p, r), /R001 codex/);
});

test("billing blocker becomes doing when runner executes a failing step", () => {
  const { p, c } = billingProject();
  p.observations.github.failedJobs = [{ name: "Vitest", failedSteps: ["Run tests"] }];
  const r = getBlockerRecovery(p, c.id);
  assert.equal(r.suggestion.to, "doing");
  assert.equal(r.suggestion.confidence, "high");
  const applied = applyBlockerRecovery(p, r);
  assert.equal(applied.to, "doing");
  assert.equal(c.status, "doing");
});

test("billing blocker becomes done when CI is ready", () => {
  const { p, c } = billingProject();
  p.deployment.ci = "ready";
  p.observations.github.failedJobs = [];
  const r = getBlockerRecovery(p, c.id);
  assert.equal(r.suggestion.to, "done");
  assert.equal(r.suggestion.confidence, "high");
});

test("pending CI is only medium confidence and is not auto-applied", () => {
  const { p, c } = billingProject();
  p.deployment.ci = "pending";
  p.observations.github.failedJobs = [];
  p.observations.github.workflowRuns = [{ status: "queued" }];
  const r = getBlockerRecovery(p, c.id);
  assert.equal(r.suggestion.to, "doing");
  assert.equal(r.suggestion.confidence, "medium");
  assert.equal(applyBlockerRecovery(p, r), null);
  assert.equal(c.status, "blocked");
});
