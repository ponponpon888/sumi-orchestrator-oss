import test from "node:test";
import assert from "node:assert/strict";
import { createProject, addScopeCriterion } from "../src/domain.js";
import { analyzeAgentResult, applyAgentResult, recordAgentResult } from "../src/result.js";
import { formatEvidenceLedger, formatResultDetail, getEvidenceLedger, listAgentResults } from "../src/ledger.js";

function projectFixture() {
  const p = createProject({ id: "musubu", name: "MUSUBU", repo: "x/y" });
  addScopeCriterion(p, "GitHub Actionsのbaseline CI障害を切り分ける", "doing");
  addScopeCriterion(p, "PR #183の変更内容を確認しマージ可能状態にする", "doing");
  p.deployment.pr = 183;
  return p;
}

const resultText = `PR #183 を独立レビューしました。SUMI C002 は継続です。\nブロッカー: GitHubのspending limitを理由にrunner起動前に失敗。`;

test("result list can filter by scope", () => {
  const p = projectFixture();
  const analysis = analyzeAgentResult(p, "C002", resultText, { agent: "codex" });
  recordAgentResult(p, analysis);
  assert.equal(listAgentResults(p, { scopeId: "C002" }).length, 1);
  assert.equal(listAgentResults(p, { scopeId: "C001" }).length, 0);
});

test("evidence ledger includes cross-scope status changes", () => {
  const p = projectFixture();
  const analysis = analyzeAgentResult(p, "C002", resultText, { agent: "codex" });
  const record = recordAgentResult(p, analysis);
  const applied = applyAgentResult(p, analysis);
  record.appliedChanges = applied.appliedChanges;
  const ledger = getEvidenceLedger(p, "C001");
  assert.ok(ledger.results.length >= 1);
  assert.ok(ledger.events.some((e) => e.type === "status-change" || e.type === "evidence"));
});

test("result detail preserves raw result and evidence", () => {
  const p = projectFixture();
  const analysis = analyzeAgentResult(p, "C002", resultText, { agent: "codex" });
  const record = recordAgentResult(p, analysis);
  const text = formatResultDetail(p, record);
  assert.match(text, /RAW RESULT/);
  assert.match(text, /spending limit/i);
});

test("evidence ledger formatter explains current status", () => {
  const p = projectFixture();
  const analysis = analyzeAgentResult(p, "C002", resultText, { agent: "codex" });
  recordAgentResult(p, analysis);
  const text = formatEvidenceLedger(p, getEvidenceLedger(p, "C002"));
  assert.match(text, /Current status: doing/);
  assert.match(text, /GitHub Actions is blocked by billing\/spending limit/);
});
