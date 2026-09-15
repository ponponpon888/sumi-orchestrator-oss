import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { addScopeCriterion, createProject } from "../src/domain.js";
import { reviewSession, SESSION_REVIEW_STATUSES } from "../src/review.js";
import { startSession } from "../src/sessions.js";

const NOW = new Date("2026-09-11T09:00:00.000Z");

function git(args, cwd = null) {
  return execFileSync("git", args, { cwd: cwd || undefined, encoding: "utf8" }).trim();
}

function tempRepo({ scripts = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-review-repo-"));
  git(["init"], root);
  git(["config", "core.autocrlf", "false"], root);
  git(["config", "user.name", "SUMI Test"], root);
  git(["config", "user.email", "sumi-test@example.invalid"], root);
  fs.writeFileSync(path.join(root, "README.md"), "# test\n", "utf8");
  if (scripts) {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
      name: "review-fixture",
      private: true,
      scripts: {
        test: "node -e \"process.exit(0)\"",
        check: "node --check review-target.js"
      }
    }, null, 2) + "\n", "utf8");
    fs.writeFileSync(path.join(root, "review-target.js"), "export const ready = true;\n", "utf8");
  }
  git(["add", "."], root);
  git(["commit", "-m", "initial"], root);
  return root;
}

function project(repo) {
  const p = createProject({ id: "app", name: "APP", repo: "owner/app", local: repo });
  p.observations = { inferredNext: [], local: { dirty: false, changedFiles: 0 } };
  return p;
}

function startCodeSession(repo) {
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-review-worktrees-"));
  const p = project(repo);
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSession(p, item.id, { worktreeRoot, now: NOW });
  return { p, started, wt: started.session.workspace.path };
}

function commitFile(wt, name = "change.js", content = "export const changed = true;\n") {
  fs.writeFileSync(path.join(wt, name), content, "utf8");
  git(["-C", wt, "add", name]);
  git(["-C", wt, "-c", "user.name=SUMI Test", "-c", "user.email=sumi-test@example.invalid", "commit", "-m", `change ${name}`]);
}

test("review gate reports WORKING when no commit exists beyond the session base", () => {
  const { p, started } = startCodeSession(tempRepo());
  const review = reviewSession(p, started.session.id, { now: NOW });
  assert.equal(review.status, SESSION_REVIEW_STATUSES.WORKING);
  assert.match(review.reasons[0], /No committed progress/);
});

test("review gate requires checks after clean committed progress", () => {
  const { p, started, wt } = startCodeSession(tempRepo());
  commitFile(wt);
  const review = reviewSession(p, started.session.id, { now: NOW });
  assert.equal(review.status, SESSION_REVIEW_STATUSES.CHECKS_REQUIRED);
  assert.equal(review.commits.length, 1);
  assert.equal(review.committedFiles.length, 1);
});

test("review gate becomes REVIEW_READY when discovered checks pass", () => {
  const { p, started, wt } = startCodeSession(tempRepo());
  commitFile(wt);
  const review = reviewSession(p, started.session.id, { runChecks: true, now: NOW });
  assert.equal(review.status, SESSION_REVIEW_STATUSES.READY);
  assert.deepEqual(review.checks.map((item) => item.id), ["diff-check", "test", "check"]);
  assert.ok(review.checks.every((item) => item.ok));
  assert.equal(started.session.lastReview.status, SESSION_REVIEW_STATUSES.READY);
});

test("review gate blocks dirty committed work", () => {
  const { p, started, wt } = startCodeSession(tempRepo());
  commitFile(wt);
  fs.writeFileSync(path.join(wt, "dirty.txt"), "not committed\n", "utf8");
  const review = reviewSession(p, started.session.id, { runChecks: true, now: NOW });
  assert.equal(review.status, SESSION_REVIEW_STATUSES.BLOCKED);
  assert.match(review.reasons.join(" "), /uncommitted/);
  assert.equal(review.checks.length, 0);
});

test("review gate blocks a failing project verification script", () => {
  const repo = tempRepo();
  const { p, started, wt } = startCodeSession(repo);
  commitFile(wt);
  const pkg = JSON.parse(fs.readFileSync(path.join(wt, "package.json"), "utf8"));
  pkg.scripts.check = "node -e \"process.exit(7)\"";
  fs.writeFileSync(path.join(wt, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8");
  git(["-C", wt, "add", "package.json"]);
  git(["-C", wt, "-c", "user.name=SUMI Test", "-c", "user.email=sumi-test@example.invalid", "commit", "-m", "make check fail"]);
  const review = reviewSession(p, started.session.id, { runChecks: true, now: NOW });
  assert.equal(review.status, SESSION_REVIEW_STATUSES.BLOCKED);
  assert.equal(review.checks.find((item) => item.id === "check")?.exitCode, 7);
});

test("review gate refuses branch drift before running checks", () => {
  const { p, started, wt } = startCodeSession(tempRepo());
  commitFile(wt);
  git(["-C", wt, "switch", "-c", "unexpected-review-branch"]);
  const review = reviewSession(p, started.session.id, { runChecks: true, now: NOW });
  assert.equal(review.status, SESSION_REVIEW_STATUSES.BLOCKED);
  assert.match(review.reasons.join(" "), /Expected branch/);
  assert.equal(review.checks.length, 0);
});


test("review gate does not certify a repository with no project verification script", () => {
  const { p, started, wt } = startCodeSession(tempRepo({ scripts: false }));
  commitFile(wt);
  const review = reviewSession(p, started.session.id, { runChecks: true, now: NOW });
  assert.equal(review.status, SESSION_REVIEW_STATUSES.CHECKS_REQUIRED);
  assert.deepEqual(review.checks.map((item) => item.id), ["diff-check"]);
  assert.match(review.reasons.join(" "), /No project verification script/);
});

test("review gate reports UNSUPPORTED for a shared non-isolated session", () => {
  const repo = tempRepo();
  const p = project(repo);
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSession(p, item.id, { worktree: false, now: NOW });
  const review = reviewSession(p, started.session.id, { runChecks: true, now: NOW });
  assert.equal(review.status, SESSION_REVIEW_STATUSES.UNSUPPORTED);
  assert.match(review.reasons.join(" "), /isolated Git worktree/);
});
