import test from "node:test";
import assert from "node:assert/strict";
import { addScopeCriterion, createProject } from "../src/domain.js";
import { formatScopeSuggestions, getScopeSuggestions, observedScopeSuggestions } from "../src/scope.js";

function observedProject() {
  const p = createProject({ id: "musubu", name: "MUSUBU" });
  p.deployment = {
    ...p.deployment,
    pr: 183,
    ci: "failed",
    preview: "cancelled",
    production: "ready"
  };
  p.observations = {
    github: {
      openPrTitle: "fix(auth): remove sensitive logging from auth confirm",
      baselineFailureLikely: true,
      baselineCi: { branch: "main", status: "failed" },
      failedJobs: [{ name: "Vitest", failedSteps: [] }]
    },
    verification: {
      required: true,
      status: "pending",
      label: "browser/manual verification",
      reason: "PR body says browser/manual verification is not complete"
    },
    vercel: {
      preview: { url: "https://preview.vercel.app" },
      production: { url: "https://prod.vercel.app" }
    }
  };
  return p;
}

test("scope suggest derives release gates from observed state", () => {
  const p = observedProject();
  const suggestions = observedScopeSuggestions(p);
  assert.deepEqual(suggestions.map((x) => x.key), [
    "pr-review-merge",
    "ci-baseline",
    "browser-verification",
    "preview-cancel-reason",
    "production-smoke"
  ]);
  assert.equal(suggestions[0].status, "doing");
  assert.equal(suggestions[2].status, "todo");
});

test("scope suggest suppresses semantic duplicates already covered by scope", () => {
  const p = observedProject();
  addScopeCriterion(p, "PR #183の変更内容を確認しマージ可能状態にする", "doing");
  addScopeCriterion(p, "GitHub Actionsのbaseline CI障害を切り分ける", "doing");
  addScopeCriterion(p, "認証フローを実ブラウザで検証する", "todo");
  addScopeCriterion(p, "Vercel Previewキャンセル理由を確認する", "done");
  addScopeCriterion(p, "マージ後にProduction smoke testを完了する", "todo");
  const result = getScopeSuggestions(p);
  assert.equal(result.observed.length, 5);
  assert.equal(result.covered.length, 5);
  assert.equal(result.fresh.length, 0);
  const text = formatScopeSuggestions(p, result);
  assert.match(text, /Covered by current scope: 5/);
  assert.match(text, /New suggestions: 0/);
  assert.match(text, /C004 \[done\] Vercel Previewキャンセル理由を確認する/);
});

test("scope suggest matches PR review criteria by PR number and status without mutating scope", () => {
  const p = observedProject();
  p.deployment.pr = 306;
  const originalCriteria = structuredClone(p.scope.criteria);
  const old = addScopeCriterion(p, "PR #128の変更内容を確認しマージ可能状態にする", "cancelled");

  let before = structuredClone(p);
  let result = getScopeSuggestions(p);
  assert.deepEqual(p, before);
  assert.equal(result.covered.some((item) => item.suggestion.key === "pr-review-merge"), false);
  assert.equal(result.fresh.some((item) => item.key === "pr-review-merge"), true);

  const withoutPrNumber = addScopeCriterion(p, "PRの変更内容を確認しマージ可能状態にする", "doing");
  before = structuredClone(p);
  result = getScopeSuggestions(p);
  assert.deepEqual(p, before);
  assert.equal(result.covered.some((item) => item.suggestion.key === "pr-review-merge"), false);
  assert.equal(result.fresh.some((item) => item.key === "pr-review-merge"), true);

  const cancelled = addScopeCriterion(p, "PR #306の変更内容を確認しマージ可能状態にする", "cancelled");
  before = structuredClone(p);
  result = getScopeSuggestions(p);
  assert.deepEqual(p, before);
  assert.equal(result.covered.some((item) => item.suggestion.key === "pr-review-merge"), false);
  assert.equal(result.fresh.some((item) => item.key === "pr-review-merge"), false);
  assert.deepEqual(result.reconsider, [{ suggestion: result.observed.find((item) => item.key === "pr-review-merge"), criterion: cancelled }]);
  assert.match(formatScopeSuggestions(p, result), new RegExp(`${cancelled.id} \\[cancelled\\]`));

  const active = addScopeCriterion(p, "PR #306の変更内容を確認しマージ可能状態にする", "blocked");
  before = structuredClone(p);
  result = getScopeSuggestions(p);
  assert.deepEqual(p, before);
  assert.equal(result.covered.find((item) => item.suggestion.key === "pr-review-merge").criterion.id, active.id);
  assert.equal(result.reconsider.length, 0);

  active.status = "done";
  before = structuredClone(p);
  result = getScopeSuggestions(p);
  assert.deepEqual(p, before);
  assert.equal(result.covered.find((item) => item.suggestion.key === "pr-review-merge").criterion.id, active.id);

  assert.deepEqual(originalCriteria, []);
  assert.equal(old.status, "cancelled");
  assert.equal(withoutPrNumber.status, "doing");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(active.status, "done");
});

test("scope suggest covers same-PR todo, doing, blocked, and done criteria", () => {
  for (const status of ["todo", "doing", "blocked", "done"]) {
    const p = observedProject();
    p.deployment.pr = 306;
    const criterion = addScopeCriterion(p, "PR #306の変更内容を確認しマージ可能状態にする", status);
    const result = getScopeSuggestions(p);
    const covered = result.covered.find((item) => item.suggestion.key === "pr-review-merge");
    assert.equal(covered.criterion.id, criterion.id);
    assert.equal(result.fresh.some((item) => item.key === "pr-review-merge"), false);
  }
});

test("scope suggest prioritizes an active PR criterion over done or cancelled criteria regardless of order", () => {
  for (const statuses of [["cancelled", "done", "todo"], ["todo", "done", "cancelled"]]) {
    const p = observedProject();
    p.deployment.pr = 306;
    const criteria = statuses.map((status) =>
      addScopeCriterion(p, "PR #306の変更内容を確認しマージ可能状態にする", status)
    );
    const result = getScopeSuggestions(p);
    const covered = result.covered.find((item) => item.suggestion.key === "pr-review-merge");
    assert.equal(covered.criterion.id, criteria.find((criterion) => criterion.status === "todo").id);
    assert.equal(result.reconsider.length, 0);
  }
});

test("scope suggest leaves only genuinely uncovered gates as fresh", () => {
  const p = observedProject();
  addScopeCriterion(p, "GitHub Actionsのbaseline CI障害を切り分ける", "doing");
  const result = getScopeSuggestions(p);
  assert.equal(result.covered.length, 1);
  assert.equal(result.fresh.length, 4);
  assert.equal(result.fresh.some((x) => x.key === "ci-baseline"), false);
});

test("scope suggest falls back to PR CI failure when no baseline issue is known", () => {
  const p = observedProject();
  p.observations.github.baselineFailureLikely = false;
  p.observations.github.baselineCi = null;
  const suggestions = observedScopeSuggestions(p);
  const ci = suggestions.find((x) => x.key === "ci-failure");
  assert.ok(ci);
  assert.match(ci.text, /PR #183のCI失敗/);
});

test("scope review marks merged PR criterion done with high confidence", async () => {
  const { getScopeStatusSuggestions } = await import("../src/scope.js");
  const p = observedProject();
  const c = addScopeCriterion(p, "PR #183の変更内容を確認しマージ可能状態にする", "doing");
  p.deployment.pr = null;
  p.observations.github.openPrTitle = null;
  p.observations.github.recentMergedPrs = [{ number: 183, title: "fix auth", mergedAt: "2026-09-11T00:00:00Z" }];
  const result = getScopeStatusSuggestions(p);
  const change = result.changes.find((x) => x.criterion.id === c.id);
  assert.equal(change.to, "done");
  assert.equal(change.confidence, "high");
});

test("scope review never auto-completes preview cancellation investigation", async () => {
  const { getScopeStatusSuggestions } = await import("../src/scope.js");
  const p = observedProject();
  const c = addScopeCriterion(p, "Vercel Previewキャンセル理由を確認する", "todo");
  const result = getScopeStatusSuggestions(p);
  const change = result.changes.find((x) => x.criterion.id === c.id);
  assert.equal(change.to, "doing");
  assert.equal(change.confidence, "medium");
  assert.equal(result.highConfidence.some((x) => x.criterion.id === c.id), false);
});

test("scope review marks browser verification done only when evidence says ready", async () => {
  const { getScopeStatusSuggestions } = await import("../src/scope.js");
  const p = observedProject();
  const c = addScopeCriterion(p, "認証フローを実ブラウザで検証する", "todo");
  p.observations.verification = { required: true, status: "ready", label: "browser/manual verification", evidence: "verified in browser" };
  const result = getScopeStatusSuggestions(p);
  const change = result.changes.find((x) => x.criterion.id === c.id);
  assert.equal(change.to, "done");
  assert.equal(change.confidence, "high");
});

test("scope review apply mutates only high-confidence changes", async () => {
  const { applyScopeStatusSuggestions, getScopeStatusSuggestions } = await import("../src/scope.js");
  const p = observedProject();
  const pr = addScopeCriterion(p, "PR #183の変更内容を確認しマージ可能状態にする", "doing");
  const preview = addScopeCriterion(p, "Vercel Previewキャンセル理由を確認する", "todo");
  p.deployment.pr = null;
  p.observations.github.openPrTitle = null;
  p.observations.github.recentMergedPrs = [{ number: 183, title: "fix auth", mergedAt: "2026-09-11T00:00:00Z" }];
  const result = getScopeStatusSuggestions(p);
  const applied = applyScopeStatusSuggestions(p, result);
  assert.equal(applied.length, 1);
  assert.equal(pr.status, "done");
  assert.equal(preview.status, "todo");
});


test("scope review recovers a billing blocker when runner execution is proven", async () => {
  const { getScopeStatusSuggestions } = await import("../src/scope.js");
  const p = observedProject();
  const c = addScopeCriterion(p, "GitHub Billing / spending limitを解消し、PR #183のCIを正常に完了させる", "blocked");
  p.observations.github.failedJobs = [{ name: "Vitest", failedSteps: ["Run tests"] }];
  const result = getScopeStatusSuggestions(p);
  const change = result.changes.find((x) => x.criterion.id === c.id);
  assert.equal(change.to, "doing");
  assert.equal(change.confidence, "high");
});
