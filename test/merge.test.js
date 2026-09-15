import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { addScopeCriterion, createProject } from "../src/domain.js";
import { getMergeQueue, getMergeReadiness, MERGE_STATUSES } from "../src/merge.js";
import { reviewSession } from "../src/review.js";
import { ingestReviewerResult } from "../src/reviewer.js";
import { startSession } from "../src/sessions.js";

const NOW = new Date("2026-09-11T09:00:00.000Z");
function git(args, cwd = null) { return execFileSync("git", args, { cwd: cwd || undefined, encoding: "utf8" }).trim(); }
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-merge-repo-"));
  git(["init"], root);
  git(["config", "core.autocrlf", "false"], root); git(["config", "user.name", "SUMI Test"], root); git(["config", "user.email", "sumi-test@example.invalid"], root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", private: true, scripts: { test: "node -e \"process.exit(0)\"", check: "node --check target.js" } }, null, 2) + "\n");
  fs.writeFileSync(path.join(root, "target.js"), "export const target = true;\n");
  git(["add", "."], root); git(["commit", "-m", "initial"], root); return root;
}
function setup({ gated = true, verdict = null } = {}) {
  const local = repo();
  const p = createProject({ id: "app", name: "APP", repo: "owner/app", local });
  p.observations = { inferredNext: [], local: { dirty: false, changedFiles: 0 } };
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSession(p, item.id, { worktreeRoot: fs.mkdtempSync(path.join(os.tmpdir(), "sumi-merge-wt-")), now: NOW });
  const wt = started.session.workspace.path;
  fs.writeFileSync(path.join(wt, "auth.js"), "export const auth = true;\n");
  git(["-C", wt, "add", "auth.js"]); git(["-C", wt, "-c", "user.name=SUMI Test", "-c", "user.email=sumi-test@example.invalid", "commit", "-m", "implement auth"]);
  if (gated) reviewSession(p, started.session.id, { runChecks: true, now: NOW });
  if (verdict) ingestReviewerResult(p, started.session.id, `${verdict === "MERGEABLE" ? "VERDICT: MERGEABLE" : "VERDICT: CHANGES_REQUIRED"}\n${verdict === "MERGEABLE" ? "No blocking findings." : "Fix the auth edge case."} C001 stay open.`, { now: NOW });
  return { p, started, wt };
}

test("merge readiness requires a Review Gate first", () => {
  const { p, started } = setup({ gated: false });
  assert.equal(getMergeReadiness(p, started.session.id).status, MERGE_STATUSES.REVIEW_GATE_REQUIRED);
});

test("merge readiness requires an independent verdict after Review Gate", () => {
  const { p, started } = setup();
  assert.equal(getMergeReadiness(p, started.session.id).status, MERGE_STATUSES.INDEPENDENT_REVIEW_REQUIRED);
});

test("merge readiness becomes MERGE_READY only for MERGEABLE on current HEAD", () => {
  const { p, started } = setup({ verdict: "MERGEABLE" });
  const row = getMergeReadiness(p, started.session.id);
  assert.equal(row.status, MERGE_STATUSES.READY);
  assert.equal(row.reviewer, "codex");
});

test("merge readiness preserves CHANGES_REQUIRED as a blocker", () => {
  const { p, started } = setup({ verdict: "CHANGES_REQUIRED" });
  assert.equal(getMergeReadiness(p, started.session.id).status, MERGE_STATUSES.CHANGES_REQUIRED);
});

test("merge readiness invalidates reviewer verdict after later workspace change", () => {
  const { p, started, wt } = setup({ verdict: "MERGEABLE" });
  fs.writeFileSync(path.join(wt, "late.js"), "export const late = true;\n");
  assert.equal(getMergeReadiness(p, started.session.id).status, MERGE_STATUSES.STALE);
});

test("merge queue orders blocking review work before merge-ready decisions", () => {
  const first = setup({ verdict: "MERGEABLE" });
  first.p.id = "ready"; first.p.name = "READY"; first.p.priority = 1;
  const second = setup({ verdict: "CHANGES_REQUIRED" });
  second.p.id = "blocked"; second.p.name = "BLOCKED"; second.p.priority = 3;
  const rows = getMergeQueue({ ready: first.p, blocked: second.p });
  assert.equal(rows[0].status, MERGE_STATUSES.CHANGES_REQUIRED);
  assert.equal(rows[1].status, MERGE_STATUSES.READY);
});
