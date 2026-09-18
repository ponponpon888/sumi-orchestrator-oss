import test from "node:test";
import assert from "node:assert/strict";
import { createProject, addScopeCriterion } from "../src/domain.js";
import { claimScopeCriterion } from "../src/claims.js";
import { getContinueSummary, formatContinue } from "../src/continue.js";
import { analyzeAgentResult, applyAgentResult, recordAgentResult } from "../src/result.js";

function baseProject() {
  const p = createProject({ id: "demo", name: "Demo", repo: "owner/demo", local: "C:\\Dev\\demo" });
  p.deployment.branch = "feature/x";
  p.deployment.pr = 12;
  p.deployment.ci = "failed";
  p.observations = { local: { dirty: false, changedFiles: 0 }, inferredNext: [] };
  return p;
}

function applyResult(p, analysis) {
  const record = recordAgentResult(p, analysis);
  const applied = applyAgentResult(p, analysis);
  record.appliedChanges = applied.appliedChanges.map((item) => ({ ...item }));
  record.addedCriteria = applied.addedCriteria.map((item) => ({ ...item }));
  record.appliedAt = new Date().toISOString();
  return { record, applied };
}

function productionRemediationProject() {
  const p = createProject({ id: "musubu", name: "MUSUBU" });
  for (let index = 1; index < 5; index += 1) addScopeCriterion(p, `Completed prerequisite ${index}`, "done");
  addScopeCriterion(p, "マージ後にProduction smoke testを完了する", "todo");
  p.deployment.production = "ready";
  p.observations = { local: { dirty: false, changedFiles: 0 }, inferredNext: [] };

  const analysis = analyzeAgentResult(
    p,
    "C005",
    "Production smoke test completed. BLOCKER: Cloudflare Turnstile returned error 110200. C005 must remain blocked and must not move to done. Add a remediation scope for Turnstile hostname configuration and Production retest.",
    { agent: "browser" }
  );
  const { record, applied } = applyResult(p, analysis);
  const remediation = p.scope.criteria.find((item) => item.id === applied.addedCriteria[0].criterionId);
  return { p, record, remediation };
}

test("continue prioritizes blocked human action", () => {
  const p = baseProject();
  addScopeCriterion(p, "GitHub Billing / spending limitを解消し、PR #12のCIを正常に完了させる", "blocked");
  addScopeCriterion(p, "認証フローを実ブラウザで検証する", "todo");
  const summary = getContinueSummary(p);
  assert.equal(summary.recommended.agent, "human");
  assert.equal(summary.recommended.state, "ready");
  const text = formatContinue(p, summary);
  assert.match(text, /RECOMMENDED NEXT/);
  assert.match(text, /Owner: human \/ action/);
});

test("continue shows waiting dependencies", () => {
  const p = baseProject();
  addScopeCriterion(p, "GitHub Billing / spending limitを解消し、PR #12のCIを正常に完了させる", "blocked");
  addScopeCriterion(p, "PR #12の変更内容を確認しマージ可能状態にする", "doing");
  const summary = getContinueSummary(p);
  assert.ok(summary.waiting.some((item) => item.scopeId === "C002"));
});


test("continue does not recommend already claimed work as ready", () => {
  const p = baseProject();
  p.deployment.ci = "ready";
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  claimScopeCriterion(p, item.id, { agent: "claude-code", owner: "worker-1", ttlMinutes: 120 });
  const summary = getContinueSummary(p);
  assert.equal(summary.ready.length, 0);
  assert.equal(summary.claimed.length, 1);
  assert.equal(summary.recommended, null);
  assert.match(formatContinue(p, summary), /CLAIMED \/ IN PROGRESS/);
});

test("continue recommends actionable human remediation before its blocked production gate", () => {
  const { p, remediation } = productionRemediationProject();
  const summary = getContinueSummary(p);

  assert.equal(remediation.status, "todo");
  assert.equal(summary.recommended.scopeId, remediation.id);
  assert.equal(summary.recommended.agent, "human");
  assert.equal(summary.recommended.mode, "action");
  assert.equal(summary.recommended.state, "ready");
  assert.ok(summary.waiting.some((item) => item.scopeId === "C005" && new RegExp(remediation.id).test(item.reason)));
  assert.equal(summary.ready.some((item) => item.scopeId === "C005"), false);
  assert.ok(summary.blockers.some((item) => item.id === "C005"));
  assert.equal(summary.blockers.some((item) => item.id === remediation.id), false);
});

test("continue recommends the missing registration when nothing can be dispatched", () => {
  const p = createProject({ id: "client-site", name: "client International", repo: "owner/client-site", local: "C:\\Dev\\client-site" });
  p.observations = { local: { dirty: false, changedFiles: 0 }, inferredNext: ["Productionの反映状態を確認する"] };
  const summary = getContinueSummary(p);

  assert.equal(summary.recommended, null);
  assert.deepEqual(summary.setupGaps.map((gap) => gap.key), ["scope", "vercel"]);

  const text = formatContinue(p, summary);
  assert.match(text, /RECOMMENDED NEXT[\s\S]*完了条件\(Scope\)が未定義/);
  assert.match(text, /SETUP REQUIRED[\s\S]*sumi project set client-site --vercel/);
  assert.doesNotMatch(text, /No actionable work detected/);
});

test("continue queue orders ready work before waiting dependencies", () => {
  const { p, remediation } = productionRemediationProject();
  const summary = getContinueSummary(p);

  assert.deepEqual(summary.queue, [
    `${remediation.id} Turnstile hostname configuration and Production retest`,
    "C005 マージ後にProduction smoke testを完了する"
  ]);
});

test("continue formatter renders ready remediation before its waiting parent in NEXT QUEUE", () => {
  const { p, remediation } = productionRemediationProject();
  const queueSection = formatContinue(p).split("NEXT QUEUE\n")[1];

  assert.match(queueSection, new RegExp(`^  1\\. ${remediation.id} Turnstile hostname configuration and Production retest`));
  assert.match(queueSection, /\n  2\. C005 マージ後にProduction smoke testを完了する/);
});

test("continue treats remediation scopes created blocked by the previous bug as actionable", () => {
  const { p, record, remediation } = productionRemediationProject();
  remediation.status = "blocked";
  record.addedCriteria[0].status = "blocked";
  const summary = getContinueSummary(p);

  assert.equal(summary.recommended.scopeId, remediation.id);
  assert.equal(summary.recommended.agent, "human");
  assert.equal(summary.recommended.state, "ready");
  assert.equal(summary.blockers.some((item) => item.id === remediation.id), false);
});

test("completing remediation reopens its blocked parent for production verification", () => {
  const { p, remediation } = productionRemediationProject();
  const analysis = analyzeAgentResult(p, remediation.id, `${remediation.id} can move to done.`, { agent: "human" });
  applyResult(p, analysis);

  assert.equal(remediation.status, "done");
  assert.equal(p.scope.criteria.find((item) => item.id === "C005").status, "todo");
  const summary = getContinueSummary(p);
  assert.equal(summary.recommended.scopeId, "C005");
  assert.equal(summary.recommended.agent, "browser");
  assert.equal(summary.recommended.state, "ready");
});
