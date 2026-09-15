import test from "node:test";
import assert from "node:assert/strict";
import { addScopeCriterion, createProject } from "../src/domain.js";
import { completeManualDispatch, dispatchProject, getDispatch, listDispatches, parseCodexJsonl, prepareDispatch } from "../src/dispatch.js";

function projectWithReview() {
  const p = createProject({ id: "demo", name: "Demo", repo: "owner/demo", local: process.cwd() });
  const c = addScopeCriterion(p, "PR #12の変更内容を確認しマージ可能状態にする", "doing");
  p.deployment = { ...p.deployment, pr: 12, ci: "ready", preview: "ready", production: "ready" };
  p.observations = { local: { dirty: false }, github: {}, vercel: {}, supabase: {} };
  return { p, c };
}

test("parseCodexJsonl extracts final agent message", () => {
  const text = [
    JSON.stringify({ type: "thread.started", thread_id: "t1" }),
    JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "first" } }),
    JSON.stringify({ type: "item.completed", item: { id: "i2", type: "agent_message", text: "final review" } })
  ].join("\n");
  assert.equal(parseCodexJsonl(text), "final review");
});

test("dispatch with injected codex runner records agent result", async () => {
  const { p, c } = projectWithReview();
  const outcome = await dispatchProject(p, c.id, {
    runner: async () => ({ ok: true, status: 0, stdout: "", stderr: "", resultText: `SUMI ${c.id} は継続です。PRはMERGEABLEです。` })
  });
  assert.equal(outcome.dispatch.status, "completed");
  assert.equal(outcome.result.id, "R001");
  assert.equal(outcome.result.scopeId, c.id);
  assert.equal(outcome.analysis.targetDisposition.action, "stay-open");
  assert.equal(p.dispatches[0].resultId, "R001");
});

test("dispatch apply can apply high confidence result changes", async () => {
  const { p, c } = projectWithReview();
  const outcome = await dispatchProject(p, c.id, {
    apply: true,
    runner: async () => ({ ok: true, status: 0, stdout: "", stderr: "", resultText: `SUMI ${c.id} doneにできます。` })
  });
  assert.equal(outcome.dispatch.status, "completed");
  assert.equal(p.scope.criteria.find((x) => x.id === c.id).status, "done");
});

test("human route is recorded as manual and never auto-executed", async () => {
  const p = createProject({ id: "billing", name: "Billing" });
  const c = addScopeCriterion(p, "GitHub Billing / spending limitを解消し、PR #183のCIを正常に完了させる", "blocked");
  const prepared = prepareDispatch(p, c.id);
  assert.equal(prepared.executable, false);
  assert.equal(prepared.manual, true);
  const outcome = await dispatchProject(p, c.id);
  assert.equal(outcome.dispatch.status, "manual");
  assert.equal(outcome.dispatch.agent, "human");
});

test("blocked billing dependency makes PR review wait", () => {
  const { p, c } = projectWithReview();
  addScopeCriterion(p, "GitHub Billing / spending limitを解消し、PR #12のCIを正常に完了させる", "blocked");
  const prepared = prepareDispatch(p, c.id);
  assert.equal(prepared.item.state, "waiting");
  assert.equal(prepared.executable, false);
  assert.match(prepared.reason, /blocking CI/);
});


test("manual browser dispatch can be completed and linked to a result", async () => {
  const p = createProject({ id: "browser-demo", name: "Browser Demo", local: process.cwd() });
  const c = addScopeCriterion(p, "認証フローを実ブラウザで検証する", "todo");
  p.deployment = { ...p.deployment, ci: "ready", preview: "ready", production: "ready" };
  p.observations = { local: { dirty: false }, github: {}, vercel: {}, supabase: {} };

  const dispatched = await dispatchProject(p, c.id);
  assert.equal(dispatched.dispatch.status, "manual");
  assert.equal(dispatched.dispatch.agent, "browser");
  assert.equal(dispatched.dispatch.id, "D001");

  const completed = await completeManualDispatch(
    p,
    "D001",
    `ブラウザで認証フローを確認しました。リダイレクトとセッション復帰は正常です。SUMI ${c.id} doneにできます。`,
    { apply: true }
  );
  assert.equal(completed.dispatch.status, "completed");
  assert.equal(completed.dispatch.resultId, "R001");
  assert.ok(completed.analysis.evidence.some((x) => x.key === "browser-verification"));
  assert.equal(p.scope.criteria.find((x) => x.id === c.id).status, "done");
  assert.equal(getDispatch(p, "D001").resultId, "R001");
  assert.equal(listDispatches(p)[0].id, "D001");
});

test("waiting dispatch cannot be force-completed as a manual external result", async () => {
  const { p, c } = projectWithReview();
  addScopeCriterion(p, "GitHub Billing / spending limitを解消し、PR #12のCIを正常に完了させる", "blocked");
  const dispatched = await dispatchProject(p, c.id);
  assert.equal(dispatched.dispatch.status, "waiting");
  await assert.rejects(
    () => completeManualDispatch(p, dispatched.dispatch.id, `SUMI ${c.id} doneにできます。`, { apply: true }),
    /only manual dispatches/
  );
});
