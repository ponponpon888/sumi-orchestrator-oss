import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { addScopeCriterion, createProject } from "../src/domain.js";
import { reviewSession } from "../src/review.js";
import { buildReviewerPrompt, ingestReviewerResult } from "../src/reviewer.js";
import { startSession } from "../src/sessions.js";

const NOW = new Date("2026-09-11T09:00:00.000Z");

function git(args, cwd = null) { return execFileSync("git", args, { cwd: cwd || undefined, encoding: "utf8" }).trim(); }
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-reviewer-repo-"));
  git(["init"], root);
  git(["config", "core.autocrlf", "false"], root);
  git(["config", "user.name", "SUMI Test"], root);
  git(["config", "user.email", "sumi-test@example.invalid"], root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", private: true, scripts: { test: "node -e \"process.exit(0)\"", check: "node --check target.js" } }, null, 2) + "\n");
  fs.writeFileSync(path.join(root, "target.js"), "export const target = true;\n");
  git(["add", "."], root);
  git(["commit", "-m", "initial"], root);
  return root;
}
function setup() {
  const local = repo();
  const p = createProject({ id: "app", name: "APP", repo: "owner/app", local });
  p.observations = { inferredNext: [], local: { dirty: false, changedFiles: 0 } };
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-reviewer-worktrees-"));
  const started = startSession(p, item.id, { worktreeRoot: root, now: NOW });
  const wt = started.session.workspace.path;
  fs.writeFileSync(path.join(wt, "auth.js"), "export const auth = true;\n");
  git(["-C", wt, "add", "auth.js"]);
  git(["-C", wt, "-c", "user.name=SUMI Test", "-c", "user.email=sumi-test@example.invalid", "commit", "-m", "implement auth"]);
  reviewSession(p, started.session.id, { runChecks: true, now: NOW });
  return { p, item, started, wt };
}

test("reviewer prompt defaults to an independent reviewer and is read-only", () => {
  const { p, started } = setup();
  const prompt = buildReviewerPrompt(p, started.session.id);
  assert.match(prompt, /Reviewer: codex/);
  assert.match(prompt, /Worker: claude-code/);
  assert.match(prompt, /Review only\. Do not edit files/);
  assert.match(prompt, /VERDICT: MERGEABLE/);
});

test("reviewer prompt requires a fresh REVIEW_READY gate", () => {
  const local = repo();
  const p = createProject({ id: "app", name: "APP", repo: "owner/app", local });
  p.observations = { inferredNext: [], local: { dirty: false, changedFiles: 0 } };
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSession(p, item.id, { worktreeRoot: fs.mkdtempSync(path.join(os.tmpdir(), "sumi-reviewer-worktrees-")), now: NOW });
  assert.throws(() => buildReviewerPrompt(p, started.session.id), /not REVIEW_READY/);
});

test("reviewer prompt rejects self-review", () => {
  const { p, started } = setup();
  assert.throws(() => buildReviewerPrompt(p, started.session.id, { agent: "claude-code" }), /must be independent/);
});

test("reviewer flow detects a stale gate when HEAD changes", () => {
  const { p, started, wt } = setup();
  fs.writeFileSync(path.join(wt, "late.js"), "export const late = true;\n");
  git(["-C", wt, "add", "late.js"]);
  git(["-C", wt, "-c", "user.name=SUMI Test", "-c", "user.email=sumi-test@example.invalid", "commit", "-m", "late change"]);
  assert.throws(() => buildReviewerPrompt(p, started.session.id), /changed after its Review Gate/);
});

test("reviewer result is linked to session and reviewed HEAD", () => {
  const { p, started } = setup();
  const head = started.session.lastReview.workspace.head;
  const outcome = ingestReviewerResult(p, started.session.id, "VERDICT: MERGEABLE\nNo blocking findings. C001 stay open pending merge.", { now: NOW });
  assert.equal(outcome.reviewer, "codex");
  assert.equal(outcome.verdict, "MERGEABLE");
  assert.equal(outcome.result.reviewOfSessionId, started.session.id);
  assert.equal(outcome.result.reviewedHead, head);
  assert.equal(started.session.lastReviewerResult.resultId, outcome.result.id);
});

test("reviewer result apply can close the explicit scope gate only when reviewer says so", () => {
  const { p, item, started } = setup();
  const outcome = ingestReviewerResult(p, started.session.id, "VERDICT: MERGEABLE\nNo blocking findings. C001 can move to done.", { apply: true, now: NOW });
  assert.equal(outcome.verdict, "MERGEABLE");
  assert.equal(item.status, "done");
  assert.equal(started.session.status, "completed");
});
