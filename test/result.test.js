import test from "node:test";
import assert from "node:assert/strict";
import { addScopeCriterion, createProject } from "../src/domain.js";
import { analyzeAgentResult, applyAgentResult, recordAgentResult } from "../src/result.js";

function projectFixture() {
  const p = createProject({ id: "musubu", name: "MUSUBU" });
  p.deployment.pr = 183;
  p.deployment.ci = "failed";
  p.deployment.preview = "cancelled";
  p.deployment.production = "ready";
  addScopeCriterion(p, "PR #183の変更内容を確認しマージ可能状態にする", "doing");
  addScopeCriterion(p, "GitHub Actionsのbaseline CI障害を切り分ける", "doing");
  addScopeCriterion(p, "認証フローを実ブラウザで検証する", "todo");
  addScopeCriterion(p, "Vercel Previewキャンセル理由を確認する", "done");
  addScopeCriterion(p, "マージ後にProduction smoke testを完了する", "todo");
  return p;
}

const codexResult = `PR #183 を独立レビューしました。コード上のマージ阻害事項はありません
が、SUMI C001 は開いたままにします。

1. 確認: 認証確認画面の差分、認証フロー、CI、Vercel状態を確認。
2. 変更: コード変更なし。CIを1回再実行。
3. 検証:
- typecheck: 成功
- production build: 成功
- authテスト: 84/84成功
- lint: 0 errors、既存warning 22件
- git diff --check: 成功
- 全テスト: 797/799成功。残り2件はWindowsのCRLF依存で、対象ファイルはmainから変更なし

4. ブロッカー: CI再実行が、GitHubの支払い失敗またはspending limitを理由に、runner起動前に失敗。Vercel PreviewもIgnored Build StepによりCanceled。

5. 判定: PR #183はGitHub上でMERGEABLEですが、UNSTABLEです。GitHub Billingを解消してVitestを成功させるまでC001は継続です。`;

const blockedProductionResult = `Production smoke test completed against merge commit bb23113. PASS: /beauty/login rendered successfully; /auth/confirm with invalid fake code returned to the BEAUTY login page; no fake code, URL, hash, token, session data, or removed debug strings appeared in Console. GitHub Vitest completed successfully. BLOCKER: Cloudflare Turnstile returned error 110200 on both the production deployment URL and https://musubu-kappa.vercel.app, displaying セキュリティ確認の読み込みに失敗しました and preventing authentication. C005 must remain blocked and must not move to done until the Production hostname is allowed in Turnstile and authentication is retested. Add a remediation scope for Turnstile hostname configuration and Production retest.`;

test("result ingestion respects explicit keep-open verdict over mergeable evidence", () => {
  const p = projectFixture();
  const result = analyzeAgentResult(p, "C001", codexResult, { agent: "codex" });
  assert.equal(result.targetDisposition.action, "stay-open");
  assert.equal(result.statusChanges.some((x) => x.criterionId === "C001" && x.to === "done"), false);
  assert.ok(result.evidence.some((x) => x.key === "pr-mergeable"));
});

test("result ingestion marks baseline diagnosis done and suggests billing blocker scope", () => {
  const p = projectFixture();
  const result = analyzeAgentResult(p, "C001", codexResult, { agent: "codex" });
  const baseline = result.statusChanges.find((x) => x.criterionId === "C002");
  assert.ok(baseline);
  assert.equal(baseline.to, "done");
  assert.equal(baseline.confidence, "high");
  assert.equal(result.freshScopeSuggestions.length, 1);
  assert.equal(result.freshScopeSuggestions[0].key, "ci-billing");
  assert.equal(result.freshScopeSuggestions[0].status, "blocked");
});

test("result apply updates only evidence-backed status and adds new blocker", () => {
  const p = projectFixture();
  const result = analyzeAgentResult(p, "C001", codexResult, { agent: "codex" });
  const applied = applyAgentResult(p, result);
  assert.equal(p.scope.criteria.find((x) => x.id === "C001").status, "doing");
  assert.equal(p.scope.criteria.find((x) => x.id === "C002").status, "done");
  assert.equal(applied.addedCriteria.length, 1);
  const blocker = p.scope.criteria.find((x) => x.id === applied.addedCriteria[0].criterionId);
  assert.equal(blocker.status, "blocked");
  assert.match(blocker.text, /Billing \/ spending limit/);
});

test("recorded result is stored in project history", () => {
  const p = projectFixture();
  const result = analyzeAgentResult(p, "C001", codexResult, { agent: "codex" });
  const record = recordAgentResult(p, result);
  assert.equal(record.id, "R001");
  assert.equal(record.scopeId, "C001");
  assert.equal(record.agent, "codex");
  assert.equal(p.agentResults.length, 1);
});

test("result ingestion keeps a mixed production smoke result blocked and suggests remediation", () => {
  const p = projectFixture();
  const result = analyzeAgentResult(p, "C005", blockedProductionResult, { agent: "browser" });
  const blocked = result.statusChanges.find((x) => x.criterionId === "C005" && x.to === "blocked");

  assert.equal(result.targetDisposition.action, "blocked");
  assert.ok(blocked);
  assert.equal(blocked.confidence, "high");
  assert.equal(result.statusChanges.some((x) => x.criterionId === "C005" && x.to === "done"), false);
  assert.equal(result.freshScopeSuggestions.length, 1);
  assert.match(result.freshScopeSuggestions[0].text, /Turnstile hostname configuration and Production retest/i);
  assert.equal(result.freshScopeSuggestions[0].status, "todo");
  assert.deepEqual(
    result.evidence.filter((x) => x.key === "production-smoke").map((x) => x.detail),
    [
      "/beauty/login rendered successfully",
      "/auth/confirm with invalid fake code returned to the BEAUTY login page",
      "no fake code, URL, hash, token, session data, or removed debug strings appeared in Console"
    ]
  );
});

test("negated done expressions never produce a done suggestion", () => {
  for (const text of ["C005 must not move to done.", "C005 is not done."]) {
    const result = analyzeAgentResult(projectFixture(), "C005", text, { agent: "codex" });
    assert.equal(result.targetDisposition.action, "stay-open");
    assert.equal(result.statusChanges.some((x) => x.to === "done"), false);
  }
});

test("explicit blocker signals override conflicting done language", () => {
  for (const text of [
    "C005 can move to done. BLOCKER: Production authentication still fails.",
    "C005 can move to done, but C005 remains blocked pending authentication."
  ]) {
    const result = analyzeAgentResult(projectFixture(), "C005", text, { agent: "browser" });
    assert.equal(result.targetDisposition.action, "blocked");
    assert.ok(result.statusChanges.some((x) => x.criterionId === "C005" && x.to === "blocked" && x.confidence === "high"));
    assert.equal(result.statusChanges.some((x) => x.to === "done"), false);
  }
});

test("a blocker-free explicit completion still moves the target gate to done", () => {
  const p = projectFixture();
  const result = analyzeAgentResult(p, "C005", "Production smoke test completed successfully. C005 can move to done.", { agent: "browser" });

  assert.equal(result.targetDisposition.action, "done");
  assert.ok(result.statusChanges.some((x) => x.criterionId === "C005" && x.to === "done" && x.confidence === "high"));
});

test("CHANGES_REQUIRED and remain open continue to override done language", () => {
  const p = projectFixture();
  const result = analyzeAgentResult(p, "C001", "VERDICT: CHANGES_REQUIRED. C001 must remain open and must not move to done.", { agent: "codex" });

  assert.equal(result.targetDisposition.action, "stay-open");
  assert.equal(result.statusChanges.some((x) => x.criterionId === "C001" && x.to === "done"), false);
});
