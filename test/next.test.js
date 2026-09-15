import test from "node:test";
import assert from "node:assert/strict";
import { addScopeCriterion, createProject } from "../src/domain.js";
import { buildNextQueue, classifyAction } from "../src/next.js";
import { formatProject } from "../src/format.js";
import { formatHandoff } from "../src/handoff.js";

test("classifyAction maps equivalent operational phrases to stable semantic keys", () => {
  assert.equal(classifyAction("CI障害がmainにもあるため、PR固有か基盤障害か切り分ける"), "ci-baseline");
  assert.equal(classifyAction("GitHub Actionsのbaseline CI障害を切り分ける"), "ci-baseline");
  assert.equal(classifyAction("PR #183を実ブラウザで検証する"), "browser-verification");
  assert.equal(classifyAction("認証フローを実ブラウザで検証する"), "browser-verification");
  assert.equal(classifyAction("Vercel Previewがキャンセルされた理由を確認する（Ignored Build Stepの可能性）"), "preview-cancel-reason");
  assert.equal(classifyAction("Turnstile hostname configuration and Production retest"), "cloudflare-config");
  assert.equal(classifyAction("Vercel管理画面でProduction domainを設定する"), "vercel-config");
  assert.equal(classifyAction("Supabase dashboardでAuth URL settingsを変更する"), "supabase-config");
});

test("NEXT collapses live observations into matching open scope criteria", () => {
  const p = createProject({ id: "musubu", name: "MUSUBU" });
  addScopeCriterion(p, "PR #183の変更内容を確認しマージ可能状態にする", "doing");
  addScopeCriterion(p, "GitHub Actionsのbaseline CI障害を切り分ける", "doing");
  addScopeCriterion(p, "認証フローを実ブラウザで検証する", "todo");
  addScopeCriterion(p, "Vercel Previewキャンセル理由を確認する", "done");
  addScopeCriterion(p, "マージ後にProduction smoke testを完了する", "todo");
  p.observations = {
    inferredNext: [
      "CI障害がmainにもあるため、PR固有か基盤障害か切り分ける",
      "PR #183を実ブラウザで検証する",
      "Vercel Previewがキャンセルされた理由を確認する（Ignored Build Stepの可能性）"
    ]
  };

  assert.deepEqual(buildNextQueue(p), [
    "C002 GitHub Actionsのbaseline CI障害を切り分ける",
    "C003 認証フローを実ブラウザで検証する",
    "C001 PR #183の変更内容を確認しマージ可能状態にする",
    "C005 マージ後にProduction smoke testを完了する"
  ]);
});

test("done scope suppresses stale inferred reminder from status and handoff", () => {
  const p = createProject({ id: "done-suppression", name: "Done Suppression" });
  addScopeCriterion(p, "Vercel Previewキャンセル理由を確認する", "done");
  p.observations = {
    inferredNext: ["Vercel Previewがキャンセルされた理由を確認する（Ignored Build Stepの可能性）"],
    local: {}, github: { failedJobs: [], ciFailureSummary: [], recentMergedPrs: [] },
    vercel: {}, supabase: {}, verification: { required: false }, readiness: { total: 0 }
  };
  assert.doesNotMatch(formatProject(p), /NEXT[\s\S]*Ignored Build Step/);
  assert.doesNotMatch(formatHandoff(p), /## Next[\s\S]*Ignored Build Step/);
});

test("handoff blocked section includes blocked completion scope", () => {
  const p = createProject({ id: "blocked-scope", name: "Blocked Scope" });
  addScopeCriterion(p, "Production smoke test", "blocked");
  const text = formatHandoff(p);
  assert.match(text, /## Blocked[\s\S]*C001 Production smoke test/);
});

test("blocked scope is prioritized and billing blocker gets a distinct semantic key", () => {
  const p = createProject({ id: "billing-blocked", name: "Billing Blocked" });
  addScopeCriterion(p, "認証フローを実ブラウザで検証する", "todo");
  addScopeCriterion(p, "GitHub Billing / spending limitを解消し、PR #183のCIを正常に完了させる", "blocked");
  assert.equal(classifyAction("GitHub Billing / spending limitを解消し、PR #183のCIを正常に完了させる"), "ci-billing");
  assert.match(buildNextQueue(p)[0], /^C002 /);
});
