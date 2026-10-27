import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createProject } from "../src/domain.js";
import { createGithubApi, getCommitChecks, listOpenPulls, listRecentMergedPulls, listRuns, mapRun } from "../src/github.js";
import { mapChecks, syncProject } from "../src/sync.js";

const REPO = "owner/app";
const SHA = "a".repeat(40);

/** A fake `gh api`: routes to fixtures, and records what was asked. */
function fakeApi(routes) {
  const calls = [];
  const api = (path, params = {}) => {
    const query = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    const route = query ? `${path}?${query}` : path;
    calls.push(route);
    for (const [pattern, response] of Object.entries(routes)) {
      if (route.startsWith(pattern)) return typeof response === "function" ? response(route) : { ok: true, data: response };
    }
    return { ok: false, error: `unrouted: ${route}` };
  };
  api.calls = calls;
  return api;
}

test("gh api is called with REST routes only, never a GraphQL subcommand", () => {
  const seen = [];
  const api = createGithubApi({ run: (command, args) => { seen.push([command, ...args]); return { ok: true, stdout: "[]" }; } });
  listOpenPulls(api, REPO);
  assert.deepEqual(seen[0], ["gh", "api", "-X", "GET", "-H", "Accept: application/vnd.github+json", "repos/owner/app/pulls", "-f", "state=open", "-f", "per_page=20"]);
  assert.ok(!seen[0].some((arg) => arg.includes("&")), "no '&' in any argument: a Windows .cmd shim would refuse it");
  assert.throws(() => listOpenPulls(api, "owner/app; rm -rf /"), /Invalid GitHub repository/);
  const broken = createGithubApi({ run: () => ({ ok: true, stdout: "<html>" }) });
  assert.match(listOpenPulls(broken, REPO).error, /unreadable JSON/);
});

test("open pulls map to the fields the PR selector reads", () => {
  const api = fakeApi({
    [`repos/${REPO}/pulls?state=open`]: [{ number: 7, title: "t", body: "b", state: "open", head: { ref: "feat/x", sha: SHA }, html_url: "https://github.com/owner/app/pull/7" }]
  });
  assert.deepEqual(listOpenPulls(api, REPO).data, [{
    number: 7, title: "t", body: "b", state: "OPEN", headRefName: "feat/x", headRefOid: SHA, headRepo: null, url: "https://github.com/owner/app/pull/7"
  }]);
});

test("checks combine check runs and status contexts, and ignore the combined status's own state", () => {
  const empty = fakeApi({
    [`repos/${REPO}/commits/${SHA}/check-runs`]: { check_runs: [{ name: "build", status: "completed", conclusion: "success", html_url: "u" }] },
    // GitHub answers "pending" for a commit with no status contexts at all.
    [`repos/${REPO}/commits/${SHA}/status`]: { state: "pending", statuses: [] }
  });
  const onlyRuns = getCommitChecks(empty, REPO, SHA).data;
  assert.equal(mapChecks(onlyRuns), "ready", "no status contexts must not hold CI at pending");

  const mixed = fakeApi({
    [`repos/${REPO}/commits/${SHA}/check-runs`]: { check_runs: [{ name: "build", status: "in_progress", conclusion: null }] },
    [`repos/${REPO}/commits/${SHA}/status`]: { state: "failure", statuses: [{ context: "vercel", state: "failure", target_url: "v" }] }
  });
  const checks = getCommitChecks(mixed, REPO, SHA).data;
  assert.deepEqual(checks, [
    { name: "build", status: "IN_PROGRESS", conclusion: null, detailsUrl: null },
    { context: "vercel", state: "FAILURE", targetUrl: "v" }
  ]);
  assert.equal(mapChecks(checks), "failed");
  assert.equal(mapChecks(getCommitChecks(fakeApi({
    [`repos/${REPO}/commits/${SHA}/check-runs`]: { check_runs: [{ name: "build", status: "queued", conclusion: null }] },
    [`repos/${REPO}/commits/${SHA}/status`]: { statuses: [] }
  }), REPO, SHA).data), "pending");
});

test("workflow runs keep gh's naming: name is the run title, workflowName the workflow", () => {
  assert.deepEqual(mapRun({ id: 1, name: "CI", display_title: "fix: x", status: "completed", conclusion: "failure", html_url: "u", event: "push", head_sha: SHA }), {
    databaseId: 1, name: "fix: x", workflowName: "CI", status: "completed", conclusion: "failure", url: "u", event: "push", headSha: SHA, createdAt: null
  });
  const api = fakeApi({ [`repos/${REPO}/actions/runs?`]: (route) => ({ ok: true, data: { workflow_runs: [], route } }) });
  listRuns(api, REPO, { branch: "feat/a b", perPage: 5 });
  assert.equal(api.calls[0], `repos/${REPO}/actions/runs?per_page=5&branch=feat%2Fa%20b`);
});

test("recent merged pulls are the merged ones, newest merge first", () => {
  const api = fakeApi({
    [`repos/${REPO}/pulls?state=closed`]: [
      { number: 1, title: "closed unmerged", merged_at: null, head: { ref: "a" } },
      { number: 2, title: "older", merged_at: "2026-10-01T00:00:00Z", head: { ref: "b" }, html_url: "u2" },
      { number: 3, title: "newer", merged_at: "2026-10-20T00:00:00Z", head: { ref: "c" }, html_url: "u3" }
    ]
  });
  assert.deepEqual(listRecentMergedPulls(api, REPO).data.map((pr) => pr.number), [3, 2]);
});

function localRepoOnBranch(branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-gh-sync-"));
  const g = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", branch, dir]);
  g("config", "user.name", "SUMI Test");
  g("config", "user.email", "sumi-test@example.invalid");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  return { dir, commit: g("rev-parse", "HEAD") };
}

test("sync reads the current PR, its checks and the failing job over REST", () => {
  const local = localRepoOnBranch("feat/x");
  const p = createProject({ id: "app", name: "APP", repo: REPO, local: local.dir });
  const api = fakeApi({
    [`repos/${REPO}/pulls?state=open`]: [{ number: 9, title: "Feature", body: "ブラウザ確認は未実施", state: "open", head: { ref: "feat/x", sha: local.commit }, html_url: "pr9" }],
    [`repos/${REPO}/commits/${local.commit}/check-runs`]: { check_runs: [{ name: "test", status: "completed", conclusion: "failure" }] },
    [`repos/${REPO}/commits/${local.commit}/status`]: { statuses: [] },
    [`repos/${REPO}/actions/runs?per_page=5&head_sha=${local.commit}`]: { workflow_runs: [{ id: 55, name: "CI", display_title: "Feature", status: "completed", conclusion: "failure", head_sha: local.commit }] },
    [`repos/${REPO}/actions/runs/55/jobs`]: { jobs: [{ id: 77, name: "test", conclusion: "failure", html_url: "j", steps: [{ name: "npm test", conclusion: "failure" }, { name: "setup", conclusion: "success" }] }] },
    [`repos/${REPO}/pulls?state=closed`]: [],
    [`repos/${REPO}/actions/runs?per_page=20&branch=main`]: { workflow_runs: [{ id: 3, name: "CI", status: "completed", conclusion: "success", head_sha: "b".repeat(40), created_at: "2026-10-27T00:00:00Z" }] },
    [`repos/${REPO}/actions/workflows`]: { total_count: 1, workflows: [{ name: "CI", state: "active", path: ".github/workflows/ci.yml" }] },
    [`repos/${REPO}/commits/main`]: { sha: "b".repeat(40), commit: { committer: { date: "2026-10-27T00:00:00Z" } } },
    [`repos/${REPO}/commits?sha=main`]: [{ sha: "b".repeat(40), commit: { committer: { date: "2026-10-27T00:00:00Z" } } }],
    [`repos/${REPO}/commits/${"b".repeat(40)}/status`]: { statuses: [{ context: "Vercel", state: "success", description: "Deployment has completed" }] },
    // Exact-route last: everything above starts with this prefix.
    [`repos/${REPO}`]: (route) => (route === `repos/${REPO}` ? { ok: true, data: { default_branch: "main" } } : { ok: false, error: `unrouted: ${route}` })
  });
  const textApi = (route) => route === `repos/${REPO}/actions/jobs/77/logs`
    ? { ok: true, data: "2026 ##[error]Process completed with exit code 1.\nnoise\n" }
    : { ok: false };

  syncProject(p, { skipVercel: true, skipSupabase: true, githubApi: api, githubTextApi: textApi });
  assert.equal(p.deployment.pr, 9);
  assert.equal(p.deployment.ci, "failed");
  assert.equal(p.observations.github.source, "gh-api");
  assert.equal(p.observations.github.openPrUrl, "pr9");
  assert.deepEqual(p.observations.github.failedJobs, [{ name: "test", conclusion: "failure", url: "j", failedSteps: ["npm test"] }]);
  assert.deepEqual(p.observations.github.ciFailureSummary, ["2026 ##[error]Process completed with exit code 1."]);
  assert.equal(p.observations.verification.status, "pending", "the PR body still drives browser verification");
  assert.equal(p.observations.github.baselineCi.branch, "main");
  assert.equal(p.observations.github.baselineCi.status, "ready");
  assert.equal(p.observations.github.deployHealth.status, "current");
  assert.ok(!p.observations.warnings.length, p.observations.warnings.join("; "));
  assert.ok(!api.calls.some((route) => /graphql/i.test(route)));
});

test("sync degrades to warnings when GitHub cannot be read, and never invents CI", () => {
  const local = localRepoOnBranch("main");
  const p = createProject({ id: "app", name: "APP", repo: REPO, local: local.dir });
  p.deployment.ci = "ready";
  syncProject(p, { skipVercel: true, skipSupabase: true, githubApi: () => ({ ok: false, error: "HTTP 403" }), githubTextApi: () => ({ ok: false }) });
  assert.equal(p.observations.github.prListObserved, false);
  assert.ok(p.observations.warnings.some((w) => /GitHub sync failed: HTTP 403/.test(w)));
  assert.ok(p.observations.warnings.some((w) => /Default branch lookup skipped/.test(w)));

  // The job log redirect may be unreachable: the summary is simply absent.
  const pr = localRepoOnBranch("feat/y");
  const q = createProject({ id: "q", name: "Q", repo: REPO, local: pr.dir });
  syncProject(q, {
    skipVercel: true, skipSupabase: true, githubTextApi: () => ({ ok: false, error: "Forbidden" }),
    githubApi: fakeApi({
      [`repos/${REPO}/pulls?state=open`]: [{ number: 1, state: "open", head: { ref: "feat/y", sha: pr.commit } }],
      [`repos/${REPO}/commits/${pr.commit}/check-runs`]: { check_runs: [{ name: "t", status: "completed", conclusion: "failure" }] },
      [`repos/${REPO}/commits/${pr.commit}/status`]: { statuses: [] },
      [`repos/${REPO}/actions/runs?per_page=5`]: { workflow_runs: [{ id: 1, name: "CI", conclusion: "failure", head_sha: pr.commit }] },
      [`repos/${REPO}/actions/runs/1/jobs`]: { jobs: [{ id: 2, name: "t", conclusion: "failure", steps: [] }] }
    })
  });
  assert.equal(q.deployment.ci, "failed");
  assert.equal(q.observations.github.ciFailureLogAvailable, false);
  assert.deepEqual(q.observations.github.ciFailureSummary, []);
});

test("a fork's PR from a same-named branch is not this branch's PR", () => {
  const local = localRepoOnBranch("feat/x");
  const p = createProject({ id: "app", name: "APP", repo: REPO, local: local.dir });
  const api = fakeApi({
    [`repos/${REPO}/pulls?state=open`]: [{ number: 77, state: "open", head: { ref: "feat/x", sha: "f".repeat(40), repo: { full_name: "stranger/app" } } }]
  });
  syncProject(p, { skipVercel: true, skipSupabase: true, githubApi: api, githubTextApi: () => ({ ok: false }) });
  assert.equal(p.deployment.pr, null);
  assert.ok(!api.calls.some((route) => route.includes("/check-runs")), "the fork's checks are never read as this branch's CI");
});

test("checks are read across pages, and a partial read is never judged", () => {
  const passing = (n, offset = 0) => Array.from({ length: n }, (_, i) => ({ name: `c${offset + i}`, status: "completed", conclusion: "success" }));
  const pages = (second) => fakeApi({
    [`repos/${REPO}/commits/${SHA}/check-runs?per_page=100&page=1`]: { total_count: 101, check_runs: passing(100) },
    [`repos/${REPO}/commits/${SHA}/check-runs?per_page=100&page=2`]: { total_count: 101, check_runs: second },
    [`repos/${REPO}/commits/${SHA}/status`]: { total_count: 0, statuses: [] }
  });
  const complete = getCommitChecks(pages([{ name: "late", status: "completed", conclusion: "failure" }]), REPO, SHA);
  assert.equal(complete.ok, true);
  assert.equal(complete.data.length, 101);
  assert.equal(mapChecks(complete.data), "failed", "the 101st check is the one that failed");

  const partial = getCommitChecks(pages([]), REPO, SHA);
  assert.equal(partial.ok, false);
  assert.match(partial.error, /read 100 of 101 check_runs/);
});
