import test from "node:test";
import assert from "node:assert/strict";
import { addScopeCriterion, createProject } from "../src/domain.js";
import { claimScopeCriterion } from "../src/claims.js";
import { buildAgentPrompt, formatRoutePlan, getRoutePlan, selectRouteItem } from "../src/router.js";

function musubuLikeProject() {
  const p = createProject({ id: "musubu", name: "MUSUBU", repo: "example-org/musubu", local: "C:\\Dev\\musubu-example", vercel: "musubu-example", supabase: "example-ref" });
  addScopeCriterion(p, "PR #183の変更内容を確認しマージ可能状態にする", "doing");
  addScopeCriterion(p, "GitHub Actionsのbaseline CI障害を切り分ける", "doing");
  addScopeCriterion(p, "認証フローを実ブラウザで検証する", "todo");
  addScopeCriterion(p, "Vercel Previewキャンセル理由を確認する", "done");
  addScopeCriterion(p, "マージ後にProduction smoke testを完了する", "todo");
  p.deployment = { ...p.deployment, branch: "fix/auth", commit: "abc", pr: 183, ci: "failed", preview: "cancelled", production: "ready" };
  p.observations = {
    inferredNext: [
      "CI障害がmainにもあるため、PR固有か基盤障害か切り分ける",
      "PR #183を実ブラウザで検証する",
      "Vercel Previewがキャンセルされた理由を確認する（Ignored Build Stepの可能性）"
    ],
    local: { dirty: false },
    github: { failedJobs: [], ciFailureSummary: [], recentMergedPrs: [], baselineFailureLikely: true },
    vercel: { preview: { url: "https://preview.vercel.app" }, production: { url: "https://prod.vercel.app" } },
    supabase: { found: true, status: "ACTIVE_HEALTHY", region: "ap-northeast-1" }
  };
  return p;
}

test("router assigns specialized agents to semantic NEXT items", () => {
  const plan = getRoutePlan(musubuLikeProject());
  const byId = Object.fromEntries(plan.filter((x) => x.scopeId).map((x) => [x.scopeId, x]));
  assert.equal(byId.C002.agent, "claude-code");
  assert.equal(byId.C003.agent, "browser");
  assert.equal(byId.C001.agent, "codex");
  assert.equal(byId.C005.agent, "browser");
});

test("production smoke task waits while PR is still open", () => {
  const plan = getRoutePlan(musubuLikeProject());
  const item = plan.find((x) => x.scopeId === "C005");
  assert.equal(item.state, "waiting");
  assert.match(item.reason, /PR #183/);
});

test("cancelled preview does not block browser route but warns about environment", () => {
  const plan = getRoutePlan(musubuLikeProject());
  const item = plan.find((x) => x.scopeId === "C003");
  assert.equal(item.state, "ready");
  assert.match(item.reason, /Preview is cancelled/);
});

test("route prompt contains target and current evidence", () => {
  const p = musubuLikeProject();
  const item = getRoutePlan(p).find((x) => x.scopeId === "C002");
  const text = buildAgentPrompt(p, item);
  assert.match(text, /Target agent: claude-code/);
  assert.match(text, /C002: GitHub Actions/);
  assert.match(text, /CI: failed/);
  assert.match(text, /Supabase: ACTIVE_HEALTHY/);
});

test("route selector accepts scope ID and route number", () => {
  const plan = getRoutePlan(musubuLikeProject());
  assert.equal(selectRouteItem(plan, "C003").scopeId, "C003");
  assert.equal(selectRouteItem(plan, "1").order, 1);
});

test("route plan clearly separates ready and waiting assignments", () => {
  const text = formatRoutePlan(musubuLikeProject());
  assert.match(text, /ROUTE PLAN — MUSUBU/);
  assert.match(text, /\[READY\]/);
  assert.match(text, /\[WAITING\].*C005/);
});

test("billing blocker routes to a human account action", () => {
  const p = createProject({ id: "billing", name: "Billing" });
  addScopeCriterion(p, "GitHub Billing / spending limitを解消し、PR #183のCIを正常に完了させる", "blocked");
  const plan = getRoutePlan(p);
  assert.equal(plan[0].agent, "human");
  assert.equal(plan[0].mode, "action");
});


test("GitHub Billing / spending limit blocker without Actions or CI wording routes to human", () => {
  const p = createProject({ id: "billing-real-wording", name: "Billing Real Wording" });
  addScopeCriterion(p, "GitHub Billing / spending limitを解消し、Actions runnerを起動可能にする", "blocked");
  const plan = getRoutePlan(p);
  assert.equal(plan[0].key, "ci-billing");
  assert.equal(plan[0].agent, "human");
  assert.equal(plan[0].mode, "action");
  assert.equal(plan[0].state, "ready");
});

test("managed-platform configuration routes to a human action", () => {
  const cases = [
    ["Turnstile hostname configuration and Production retest", "cloudflare-config"],
    ["Vercel管理画面でProduction domainを設定する", "vercel-config"],
    ["Supabase dashboardでAuth URL settingsを変更する", "supabase-config"]
  ];
  for (const [text, key] of cases) {
    const p = createProject({ id: key, name: key });
    addScopeCriterion(p, text, "todo");
    const item = getRoutePlan(p)[0];
    assert.equal(item.key, key);
    assert.equal(item.agent, "human");
    assert.equal(item.mode, "action");
    assert.equal(item.state, "ready");
  }
});

test("recovered billing gate with a normal CI failure routes to Claude Code", () => {
  const p = createProject({ id: "billing-recovered", name: "Billing Recovered" });
  const c = addScopeCriterion(p, "GitHub Billing / spending limitを解消し、PR #183のCIを正常に完了させる", "doing");
  p.deployment.ci = "failed";
  const plan = getRoutePlan(p);
  const item = plan.find((x) => x.scopeId === c.id);
  assert.equal(item.agent, "claude-code");
  assert.equal(item.mode, "execute");
});


test("router exposes active scope lease as claimed instead of ready", () => {
  const p = createProject({ id: "leased", name: "Leased", repo: "owner/leased", local: "C:\\Dev\\leased" });
  p.observations = { inferredNext: [], local: { dirty: false, changedFiles: 0 } };
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  claimScopeCriterion(p, item.id, { agent: "claude-code", owner: "worker-1", ttlMinutes: 120 });
  const plan = getRoutePlan(p);
  assert.equal(plan[0].state, "claimed");
  assert.equal(plan[0].claim.owner, "worker-1");
  assert.match(plan[0].reason, /Claimed by worker-1/);
});
