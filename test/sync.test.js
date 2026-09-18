import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { addScopeCriterion, createProject, SERVICE_UNUSED } from "../src/domain.js";
import { aggregateGithubCi, aggregateStoredProductionVerification, inferManualVerification, parseVercelList, selectCurrentOpenPr, shouldSyncVercelPreview, summarizeBaselineCi, syncProject, syncVercel } from "../src/sync.js";
import { formatHandoff } from "../src/handoff.js";
import { formatProject } from "../src/format.js";

const MUSUBU_PRODUCTION_RESULT = "Production smoke test completed against merged commit bb23113 on https://musubu-kappa.vercel.app. PASS: /beauty/login rendered successfully; Cloudflare Turnstile loaded without error 110200 and completed with Success; authentication completed successfully and the user logged in; /auth/confirm with an invalid fake code returned to the BEAUTY login page; no fake code, URL, hash, token, session data, or removed sensitive debug strings appeared in Console; GitHub Vitest and Vercel deployment completed successfully. No remaining Production authentication blocker was observed. C005 can move to done.";

function musubuProductionFixture() {
  const p = createProject({ id: "musubu", name: "MUSUBU" });
  addScopeCriterion(p, "PR #183の変更内容を確認しマージ可能状態にする", "done");
  addScopeCriterion(p, "GitHub Actionsのbaseline CI障害を切り分ける", "done");
  addScopeCriterion(p, "認証フローを実ブラウザで検証する", "cancelled");
  addScopeCriterion(p, "Vercel Previewキャンセル理由を確認する", "done");
  addScopeCriterion(p, "マージ後にProduction smoke testを完了する", "done");
  addScopeCriterion(p, "GitHub Billing / spending limitを解消する", "cancelled");
  addScopeCriterion(p, "Turnstile hostname configuration and Production retest", "done");
  p.deployment.commit = "bb23113deff9198006aa9a6d8611e9a6b588fea1";
  p.deployment.production = "ready";
  p.agentResults.push({
    id: "R008",
    seq: 8,
    scopeId: "C005",
    agent: "browser",
    rawText: MUSUBU_PRODUCTION_RESULT,
    evidence: Array.from({ length: 6 }, (_, index) => ({
      key: "production-smoke",
      label: "Production smoke check passed",
      detail: `production check ${index + 1}`
    })),
    blockers: [],
    targetDisposition: { action: "done", reason: "C005 can move to done" },
    createdAt: "2026-09-14T05:17:10.806Z"
  });
  return p;
}

function emptyVerification() {
  return { verification: { required: false, status: "unknown", label: null, evidence: null } };
}

test("PR body without browser language does not create a verification gate", () => {
  assert.deepEqual(inferManualVerification("Unit tests passed."), {
    required: false, status: "unknown", label: null, evidence: null
  });
});

test("PR body keeps explicitly incomplete browser verification pending", () => {
  const verification = inferManualVerification("Browser verification not verified yet.");
  assert.equal(verification.required, true);
  assert.equal(verification.status, "pending");
  assert.match(verification.evidence, /not complete/);
});

test("PR body completion claim cannot mark browser verification ready", () => {
  const verification = inferManualVerification("Browser verification tested and verified.");
  assert.equal(verification.required, true);
  assert.equal(verification.status, "pending");
  assert.match(verification.evidence, /direct SUMI browser\/human evidence is required/);
});

function githubObservations(baselineCi) {
  return {
    github: {
      openPrTitle: null,
      openPrState: null,
      checks: [],
      workflowRuns: [],
      failedJobs: [],
      ciFailureSummary: [],
      baselineCi,
      baselineFailureLikely: false
    }
  };
}

function emptyVercelObservations() {
  return {
    vercel: { linked: true, projectName: "musubu", cliAvailable: false, preview: null, production: null },
    warnings: []
  };
}

const VERCEL_PRODUCTION_OUTPUT = "1m https://musubu-production.vercel.app Ready Production";

function vercelRunner(previewResult, calls) {
  return (command, args) => {
    calls.push({ command, args });
    if (args.includes("--environment=preview")) return previewResult;
    return { ok: true, stdout: VERCEL_PRODUCTION_OUTPUT, stderr: "" };
  };
}

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}

const SHARENAIL_BRANCH = "fix/zero-square-monthly-20260912";
const SHARENAIL_COMMIT = "25a9ecdae7657ec3382eec474988fd559f701761";

test("current PR stays null when multiple open PR branches do not match", () => {
  const list = [
    { number: 67, state: "OPEN", headRefName: "feature/unrelated-one", headRefOid: "a".repeat(40) },
    { number: 68, state: "OPEN", headRefName: "fix/unrelated-two", headRefOid: "b".repeat(40) }
  ];
  assert.equal(selectCurrentOpenPr(list, SHARENAIL_BRANCH, SHARENAIL_COMMIT), null);
});

test("current PR selects only the exact matching local branch", () => {
  const list = [
    { number: 67, state: "OPEN", headRefName: "feature/unrelated", headRefOid: "a".repeat(40) },
    { number: 129, state: "OPEN", headRefName: SHARENAIL_BRANCH, headRefOid: SHARENAIL_COMMIT }
  ];
  assert.equal(selectCurrentOpenPr(list, SHARENAIL_BRANCH, SHARENAIL_COMMIT)?.number, 129);
});

test("current PR stays null when the matching PR is merged and only another PR is open", () => {
  const list = [
    { number: 129, state: "MERGED", headRefName: SHARENAIL_BRANCH, headRefOid: SHARENAIL_COMMIT },
    { number: 67, state: "OPEN", headRefName: "feature/unrelated", headRefOid: "a".repeat(40) }
  ];
  assert.equal(selectCurrentOpenPr(list, SHARENAIL_BRANCH, SHARENAIL_COMMIT), null);
});

test("main does not select an unrelated open PR", () => {
  const list = [
    { number: 67, state: "OPEN", headRefName: "feature/unrelated", headRefOid: "a".repeat(40) }
  ];
  assert.equal(selectCurrentOpenPr(list, "main", SHARENAIL_COMMIT), null);
});

test("current PR uses head commit only to prefer an exact-branch candidate", () => {
  const list = [
    { number: 130, state: "OPEN", headRefName: SHARENAIL_BRANCH, headRefOid: "b".repeat(40) },
    { number: 129, state: "OPEN", headRefName: SHARENAIL_BRANCH, headRefOid: SHARENAIL_COMMIT },
    { number: 67, state: "OPEN", headRefName: "feature/unrelated", headRefOid: SHARENAIL_COMMIT }
  ];
  assert.equal(selectCurrentOpenPr(list, SHARENAIL_BRANCH, SHARENAIL_COMMIT)?.number, 129);
});

test("syncProject reads local git state and handoff renders it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-sync-"));
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  git(dir, "init");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "SUMI Test");
  git(dir, "add", "README.md");
  git(dir, "commit", "-m", "initial commit");

  const p = createProject({ id: "demo", name: "Demo", local: dir });
  const o = syncProject(p);
  assert.equal(o.local.available, true);
  assert.equal(o.local.git, true);
  assert.equal(o.local.dirty, false);
  assert.ok(p.deployment.commit);

  const text = formatHandoff(p);
  assert.match(text, /SUMI HANDOFF/);
  assert.match(text, /initial commit/);
});

test("sync aggregates a completed MUSUBU production result without regressing on later syncs", () => {
  const p = musubuProductionFixture();
  const first = syncProject(p, { skipVercel: true, skipSupabase: true });

  assert.equal(p.deployment.production, "verified");
  assert.equal(p.deployment.productionCheckedAt, "2026-09-14T05:17:10.806Z");
  assert.equal(first.verification.status, "ready");
  assert.equal(first.verification.source, "stored-result");
  assert.equal(first.verification.resultId, "R008");
  assert.match(first.verification.evidence, /6 production smoke checks/);
  const output = formatProject(p);
  assert.match(output, /STATE\s+DONE/);
  assert.match(output, /PROGRESS\s+100% \(5\/5 scope\)/);
  assert.match(output, /VERIFY\s+ready \(production verification\)/);
  assert.match(output, /PRODUCTION\s+verified/);

  const second = syncProject(p, { skipVercel: true, skipSupabase: true });
  assert.equal(p.deployment.production, "verified");
  assert.equal(second.verification.status, "ready");
  assert.equal(second.verification.resultId, "R008");
});

test("MUSUBU main baseline CI is aggregated into the stored and displayed top-level CI", () => {
  const p = musubuProductionFixture();
  p.deployment.branch = "main";
  p.deployment.pr = null;
  p.deployment.ci = "unknown";
  p.deployment.production = "verified";
  const baseline = summarizeBaselineCi("main", [{
    databaseId: 1001,
    workflowName: "Test",
    status: "completed",
    conclusion: "success",
    url: "https://github.test/actions/runs/1001",
    headSha: p.deployment.commit
  }]);
  const observations = githubObservations(baseline);
  p.observations = observations;

  assert.equal(aggregateGithubCi(p, observations), "ready");
  assert.equal(p.deployment.ci, "ready");
  assert.equal(p.observations.github.baselineCi.status, "ready");
  assert.equal(p.observations.github.baselineCi.headSha, p.deployment.commit);
  const status = formatProject(p);
  assert.match(status, /CI\s+ready/);
  assert.match(status, /CI DETAIL[\s\S]*BASELINE main: ready/);
  const handoff = formatHandoff(p);
  assert.match(handoff, /- CI: ready/);
  assert.match(handoff, /Baseline CI: main: ready/);
});

test("baseline CI aggregation keeps failed and pending ahead of ready", () => {
  const sha = "bb23113deff9198006aa9a6d8611e9a6b588fea1";
  const ready = { databaseId: 1001, workflowName: "Lint", status: "completed", conclusion: "success", headSha: sha };
  const failed = { databaseId: 1002, workflowName: "Test", status: "completed", conclusion: "failure", headSha: sha };
  const pending = { databaseId: 1003, workflowName: "Build", status: "in_progress", conclusion: null, headSha: sha };

  assert.equal(summarizeBaselineCi("main", [ready, pending]).status, "pending");
  assert.equal(summarizeBaselineCi("main", [ready, pending, failed]).status, "failed");

  for (const currentCi of ["failed", "pending"]) {
    const p = createProject({ id: `preserve-${currentCi}`, name: "Preserve CI" });
    p.deployment.branch = "main";
    p.deployment.commit = sha;
    p.deployment.ci = currentCi;
    const observations = githubObservations(summarizeBaselineCi("main", [ready]));
    assert.equal(aggregateGithubCi(p, observations), currentCi);
  }
});

test("open PR CI stays separate from a ready baseline CI", () => {
  const sha = "bb23113deff9198006aa9a6d8611e9a6b588fea1";
  const baseline = summarizeBaselineCi("main", [{
    databaseId: 1001,
    workflowName: "Test",
    status: "completed",
    conclusion: "success",
    headSha: sha
  }]);

  for (const prCi of ["failed", "pending", "unknown"]) {
    const p = createProject({ id: `pr-${prCi}`, name: "PR CI" });
    p.deployment.branch = "feature/auth";
    p.deployment.commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    p.deployment.pr = 184;
    p.deployment.ci = prCi;
    assert.equal(aggregateGithubCi(p, githubObservations(baseline)), prCi);
  }
});

test("baseline CI remains unknown without current-main evidence", () => {
  const sha = "bb23113deff9198006aa9a6d8611e9a6b588fea1";
  const readyBaseline = summarizeBaselineCi("main", [{
    databaseId: 1001,
    workflowName: "Test",
    status: "completed",
    conclusion: "success",
    headSha: sha
  }]);
  const cases = [
    ["no runs", summarizeBaselineCi("main", []), "main", sha],
    ["missing baseline", null, "main", sha],
    ["different commit", readyBaseline, "main", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    ["different branch", readyBaseline, "feature/auth", sha],
    ["missing commit", readyBaseline, "main", null]
  ];

  for (const [name, baseline, branch, commit] of cases) {
    const p = createProject({ id: `unknown-${name.replace(/\s/g, "-")}`, name: "Unknown CI" });
    p.deployment.branch = branch;
    p.deployment.commit = commit;
    p.deployment.ci = "ready";
    assert.equal(aggregateGithubCi(p, githubObservations(baseline)), "unknown", name);
  }
});

test("stored production aggregation rejects blockers, failures, cancellations, and unfinished scope", () => {
  const cases = [
    ["blocker", (p, result) => { result.blockers = [{ key: "turnstile", text: "Turnstile failed" }]; }],
    ["failed", (p, result) => { result.rawText = "Production verification failed because login failed. C005 can move to done."; }],
    ["cancelled", (p, result) => { result.rawText = "Production smoke test CANCELLED: deployment unavailable. C005 can move to done."; }],
    ["unfinished", (p) => { p.scope.criteria.find((item) => item.id === "C005").status = "doing"; }],
    ["newer blocker", (p, result) => {
      p.agentResults.push({
        ...structuredClone(result),
        id: "R009",
        seq: 9,
        blockers: [{ key: "turnstile", text: "Turnstile failed" }],
        targetDisposition: { action: "blocked", reason: "C005 must remain blocked" },
        createdAt: "2026-09-14T05:18:10.806Z"
      });
    }]
  ];

  for (const [name, mutate] of cases) {
    const p = musubuProductionFixture();
    mutate(p, p.agentResults[0]);
    const observations = emptyVerification();
    assert.equal(aggregateStoredProductionVerification(p, observations), null, name);
    assert.equal(p.deployment.production, "ready", name);
    assert.deepEqual(observations.verification, { required: false, status: "unknown", label: null, evidence: null }, name);
  }
});

test("stored production aggregation preserves directly observed verification", () => {
  const p = musubuProductionFixture();
  const observations = {
    verification: { required: true, status: "ready", label: "external browser verification", evidence: "PR body verified" }
  };
  const expected = structuredClone(observations.verification);

  assert.equal(aggregateStoredProductionVerification(p, observations).id, "R008");
  assert.deepEqual(observations.verification, expected);
  assert.equal(p.deployment.production, "verified");

  const pendingProject = musubuProductionFixture();
  const pending = {
    verification: { required: true, status: "pending", label: "external browser verification", evidence: "PR body pending" }
  };
  const expectedPending = structuredClone(pending.verification);
  assert.equal(aggregateStoredProductionVerification(pendingProject, pending), null);
  assert.deepEqual(pending.verification, expectedPending);
  assert.equal(pendingProject.deployment.production, "ready");
});

test("format handoff can use inferred next actions", () => {
  const p = createProject({ id: "demo2", name: "Demo 2" });
  p.observations = {
    inferredNext: ["CI失敗を修正する: Vitest"],
    github: { failedJobs: [{ name: "Vitest", failedSteps: ["Run tests"] }] },
    local: {}
  };
  p.deployment.ci = "failed";
  const text = formatHandoff(p);
  assert.match(text, /CI失敗を修正する: Vitest/);
  assert.match(text, /Vitest — failed step: Run tests/);
});

test("handoff separates project progress from current work readiness and recent merged PRs", () => {
  const p = createProject({ id: "demo3", name: "Demo 3" });
  p.deployment.pr = 42;
  p.deployment.ci = "failed";
  p.observations = {
    inferredNext: ["CI失敗を修正する: Vitest"],
    local: { dirty: false, lastCommitSubject: "fix auth" },
    verification: { required: true, status: "pending", label: "browser/manual verification", evidence: "PR body says browser/manual verification is not complete" },
    readiness: { ready: 2, total: 4, failed: 1, pending: 1 },
    github: {
      openPrTitle: "fix auth",
      openPrUrl: "https://example.test/pr/42",
      failedJobs: [{ name: "Vitest", failedSteps: [] }],
      ciFailureSummary: ["Error: test failed"],
      recentMergedPrs: [{ number: 41, title: "previous feature", mergedAt: "2026-09-10T00:00:00Z" }]
    },
    warnings: []
  };
  const text = formatHandoff(p);
  assert.match(text, /Project progress: 未算出/);
  assert.match(text, /Current work readiness: 2\/4 ready, 1 failed, 1 pending/);
  assert.match(text, /PR #41 previous feature/);
  assert.match(text, /Manual verification: pending/);
  assert.match(text, /log: Error: test failed/);
});

test("completed MUSUBU skips Preview lookup without changing its stored Preview state", () => {
  for (const previewStatus of ["failed", "cancelled", "ready"]) {
    const p = musubuProductionFixture();
    p.vercel = "musubu";
    p.deployment.pr = null;
    p.deployment.production = "verified";
    p.deployment.preview = previewStatus;
    assert.equal(shouldSyncVercelPreview(p), false);

    for (let run = 0; run < 2; run += 1) {
      const calls = [];
      const observations = emptyVercelObservations();
      syncVercel(p, observations, {
        commandAvailable: true,
        runner: vercelRunner({ ok: true, stdout: "unparseable preview output", stderr: "" }, calls)
      });
      assert.equal(calls.some((call) => call.args.includes("--environment=preview")), false);
      assert.equal(calls.some((call) => call.args.includes("--prod")), true);
      assert.equal(p.deployment.preview, previewStatus);
      assert.deepEqual(observations.warnings, []);
    }
  }
});

test("open PR and ongoing releases keep an actionable warning when Preview output is unparseable", () => {
  for (const mode of ["open-pr", "ongoing"]) {
    const p = musubuProductionFixture();
    p.vercel = "musubu";
    p.deployment.pr = mode === "open-pr" ? 184 : null;
    p.deployment.production = mode === "open-pr" ? "verified" : "ready";
    p.deployment.preview = "cancelled";
    const calls = [];
    const observations = emptyVercelObservations();

    assert.equal(shouldSyncVercelPreview(p), true, mode);
    syncVercel(p, observations, {
      commandAvailable: true,
      runner: vercelRunner({ ok: true, stdout: "https://unknown-format.vercel.app", stderr: "" }, calls)
    });

    assert.equal(calls.some((call) => call.args.includes("--environment=preview")), true, mode);
    assert.deepEqual(observations.warnings, ["Vercel preview command succeeded but deployment output could not be parsed"], mode);
    assert.equal(p.deployment.preview, "cancelled", mode);
  }
});

test("open PR distinguishes an empty Preview result from a parse failure", () => {
  const p = musubuProductionFixture();
  p.vercel = "musubu";
  p.deployment.pr = 184;
  p.deployment.production = "verified";
  p.deployment.preview = "cancelled";
  const observations = emptyVercelObservations();

  syncVercel(p, observations, {
    commandAvailable: true,
    runner: vercelRunner({ ok: true, stdout: "", stderr: "Vercel CLI 50.9.6\nFetching deployments\n> No deployments found." }, [])
  });

  assert.deepEqual(observations.warnings, ["Vercel preview deployment not found for commit bb23113deff9"]);
  assert.equal(p.deployment.preview, "cancelled");
});

test("parseVercelList handles Vercel CLI 50 deployment rows and successful Preview sync", () => {
  const output = `Vercel CLI 50.9.6
Fetching deployments in example-team
Age  Deployment                                  Status      Environment  Duration  Username
4d   https://demo-cancelled.vercel.app          Canceled    Preview      2s        user
4d   https://demo-ready.vercel.app              ● Ready     Preview      44s       user`;
  const rows = parseVercelList(output);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, "CANCELED");
  assert.equal(rows[1].status, "READY");

  const p = musubuProductionFixture();
  p.vercel = "musubu";
  p.deployment.pr = 184;
  p.deployment.production = "verified";
  p.deployment.preview = "cancelled";
  const observations = emptyVercelObservations();
  syncVercel(p, observations, {
    commandAvailable: true,
    runner: vercelRunner({ ok: true, stdout: output, stderr: "" }, [])
  });
  assert.equal(p.deployment.preview, "cancelled");
  assert.equal(observations.vercel.preview.url, "https://demo-cancelled.vercel.app");
  assert.deepEqual(observations.warnings, []);
});

test("parseVercelList extracts deployment state without guessing completion", () => {
  const rows = parseVercelList(`Age  Deployment                              Status  Environment\n2m   https://demo-abc.vercel.app             READY   Preview`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "READY");
  assert.equal(rows[0].environment, "Preview");
  assert.equal(rows[0].url, "https://demo-abc.vercel.app");
});

test("parseSupabaseProjects accepts array and wrapped project output", async () => {
  const { parseSupabaseProjects } = await import("../src/sync.js");
  const a = parseSupabaseProjects('[{"ref":"abc","status":"ACTIVE_HEALTHY"}]');
  const b = parseSupabaseProjects('{"projects":[{"ref":"xyz"}]}');
  assert.equal(a[0].ref, "abc");
  assert.equal(b[0].ref, "xyz");
});

test("handoff can explain likely baseline CI failure", () => {
  const p = createProject({ id: "baseline", name: "Baseline" });
  p.deployment.ci = "failed";
  p.observations = {
    inferredNext: ["CI障害がmainにもあるため、PR固有か基盤障害か切り分ける"],
    local: {},
    github: {
      failedJobs: [{ name: "Vitest", failedSteps: [] }],
      ciFailureSummary: [],
      recentMergedPrs: [],
      baselineCi: { branch: "main", status: "failed" },
      baselineFailureLikely: true
    },
    warnings: []
  };
  const text = formatHandoff(p);
  assert.match(text, /Baseline CI: main: failed/);
  assert.match(text, /baseline\/infrastructure-related/);
});

test("chooseResolvedCommand prefers a Windows executable shim over extensionless npm shim", async () => {
  const { chooseResolvedCommand } = await import("../src/sync.js");
  const out = [
    "C:\\Users\\developer\\AppData\\Roaming\\npm\\vercel",
    "C:\\Users\\developer\\AppData\\Roaming\\npm\\vercel.cmd"
  ].join("\r\n");
  assert.equal(chooseResolvedCommand(out, "win32"), "C:\\Users\\developer\\AppData\\Roaming\\npm\\vercel.cmd");
});

test("chooseResolvedCommand rejects extensionless Windows-only shim when no executable candidate exists", async () => {
  const { chooseResolvedCommand } = await import("../src/sync.js");
  assert.equal(chooseResolvedCommand("C:\\Users\\developer\\AppData\\Roaming\\npm\\vercel", "win32"), null);
});

test("buildSpawnInvocation uses explicit cmd.exe for Windows cmd shims without shell:true", async () => {
  const { buildSpawnInvocation } = await import("../src/sync.js");
  const r = buildSpawnInvocation(
    "C:\\Users\\developer\\AppData\\Roaming\\npm\\vercel.cmd",
    ["list", "musubu", "--no-color"],
    "win32",
    { ComSpec: "C:\\Windows\\System32\\cmd.exe" }
  );
  assert.equal(r.command, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(r.shell, false);
  assert.deepEqual(r.args.slice(0, 2), ["/d", "/c"]);
  assert.match(r.args[2], /^chcp 65001>nul & call /);
  assert.match(r.args[2], /vercel\.cmd/);
});

test("parseGitPorcelain preserves status and path for dirty-file reporting", async () => {
  const { parseGitPorcelain } = await import("../src/sync.js");
  const rows = parseGitPorcelain(" M src/app/auth/confirm/page.jsx\n?? tmp-note.txt\n");
  assert.deepEqual(rows, [
    { status: " M", path: "src/app/auth/confirm/page.jsx" },
    { status: "??", path: "tmp-note.txt" }
  ]);
});

test("parseGitPorcelain keeps the status column intact on every line", async () => {
  const { parseGitPorcelain } = await import("../src/sync.js");
  const rows = parseGitPorcelain(" M src/app/tasks/new/page.tsx\n M src/lib/supabase/server.ts\nM  src/staged.ts\n");
  assert.deepEqual(rows, [
    { status: " M", path: "src/app/tasks/new/page.tsx" },
    { status: " M", path: "src/lib/supabase/server.ts" },
    { status: "M ", path: "src/staged.ts" }
  ]);
});

test("sync reports the full path when the first change is unstaged", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-porcelain-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "page.tsx"), "export const page = 1;\n");
  git(dir, "init");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "SUMI Test");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "initial commit");
  // Unstaged modification: git prints " M src/page.tsx" with a leading space,
  // which must survive the command-output handling.
  fs.writeFileSync(path.join(dir, "src", "page.tsx"), "export const page = 2;\n");

  const p = createProject({ id: "porcelain", name: "Porcelain", local: dir });
  const o = syncProject(p, { skipVercel: true, skipSupabase: true });

  assert.equal(o.local.dirty, true);
  assert.equal(o.local.changedFiles, 1);
  assert.deepEqual(o.local.changes, [{ status: " M", path: "src/page.tsx" }]);
});


test("formatProject renders Supabase health and local dirty files", () => {
  const p = createProject({ id: "visible", name: "Visible", supabase: "abc" });
  p.observations = {
    local: { dirty: true, changedFiles: 1, changes: [{ status: " M", path: "src/app/page.jsx" }] },
    supabase: { cliAvailable: true, found: true, status: "ACTIVE_HEALTHY", region: "ap-northeast-1" },
    github: { failedJobs: [], ciFailureSummary: [], recentMergedPrs: [] },
    verification: { required: false, status: "unknown", label: null },
    readiness: { total: 0, ready: 0, failed: 0, pending: 0 },
    inferredNext: [],
    observedAt: "2026-09-11T01:00:00Z"
  };
  const text = formatProject(p);
  assert.match(text, /SUPABASE\s+ACTIVE_HEALTHY \(ap-northeast-1\)/);
  assert.match(text, /LOCAL CHANGES/);
  assert.match(text, /M src\/app\/page\.jsx/);
});

test("buildSpawnInvocation forces UTF-8 and verbatim cmd arguments for Windows npm shims", async () => {
  const { buildSpawnInvocation } = await import("../src/sync.js");
  const r = buildSpawnInvocation(
    "C:\\Users\\developer\\AppData\\Roaming\\npm\\vercel.cmd",
    ["list", "musubu", "--no-color"],
    "win32",
    { ComSpec: "C:\\Windows\\System32\\cmd.exe" }
  );
  assert.equal(r.shell, false);
  assert.equal(r.windowsVerbatimArguments, true);
  assert.deepEqual(r.args.slice(0, 2), ["/d", "/c"]);
  assert.match(r.args[2], /^chcp 65001>nul & call /);
  assert.match(r.args[2], /"C:\\Users\\developer\\AppData\\Roaming\\npm\\vercel\.cmd"/);
});

test("Supabase CLI temp directory is excluded from meaningful dirty state", async () => {
  const { parseGitPorcelain, filterMeaningfulGitChanges, isTransientGeneratedChange } = await import("../src/sync.js");
  const all = parseGitPorcelain("?? supabase/.temp/\n M src/app/page.jsx\n");
  assert.equal(isTransientGeneratedChange(all[0]), true);
  assert.deepEqual(filterMeaningfulGitChanges(all), [
    { status: " M", path: "src/app/page.jsx" }
  ]);
});

test("Vercel canceled deployments are not classified as failed", async () => {
  const { parseVercelList } = await import("../src/sync.js");
  const rows = parseVercelList(`1m https://demo-cancelled.vercel.app CANCELED Preview`);
  assert.equal(rows[0].status, "CANCELED");
});

test("formatProject reports cancelled preview separately from failed", () => {
  const p = createProject({ id: "cancelled", name: "Cancelled" });
  p.deployment.preview = "cancelled";
  p.observations = {
    local: { dirty: false, changedFiles: 0, changes: [] },
    vercel: { linked: true, projectId: "prj_1", preview: { url: "https://preview.vercel.app", status: "CANCELED" }, production: null },
    supabase: {},
    github: { failedJobs: [], ciFailureSummary: [], recentMergedPrs: [] },
    verification: { required: false, status: "unknown", label: null },
    readiness: { total: 1, ready: 0, failed: 0, pending: 0, cancelled: 1 },
    inferredNext: ["Vercel Previewがキャンセルされた理由を確認する（Ignored Build Stepの可能性）"],
    observedAt: "2026-09-11T01:00:00Z"
  };
  const text = formatProject(p);
  assert.match(text, /PREVIEW\s+cancelled https:\/\/preview\.vercel\.app/);
  assert.match(text, /1 cancelled/);
  assert.doesNotMatch(text, /1 failed/);
});

test("formatProject shows explicit scope basis and open criteria", async () => {
  const { addScopeCriterion } = await import("../src/domain.js");
  const p = createProject({ id: "scope-visible", name: "Scope Visible" });
  addScopeCriterion(p, "Authentication verified", "done");
  addScopeCriterion(p, "Production smoke test", "todo");
  const text = formatProject(p);
  assert.match(text, /PROGRESS\s+50% \(1\/2 scope\)/);
  assert.match(text, /OPEN SCOPE/);
  assert.match(text, /C002 \[todo\] Production smoke test/);
});

test("handoff explains progress basis and completion scope", async () => {
  const { addScopeCriterion } = await import("../src/domain.js");
  const p = createProject({ id: "scope-handoff", name: "Scope Handoff" });
  addScopeCriterion(p, "Auth", "done");
  addScopeCriterion(p, "Smoke test", "doing");
  const text = formatHandoff(p);
  assert.match(text, /Progress basis: scope:/);
  assert.match(text, /## Completion scope/);
  assert.match(text, /C002 \[doing\] Smoke test/);
});

test("scope criteria feed current, blocked, and next when live observations are absent", async () => {
  const { addScopeCriterion } = await import("../src/domain.js");
  const p = createProject({ id: "scope-flow", name: "Scope Flow" });
  addScopeCriterion(p, "Auth", "done");
  addScopeCriterion(p, "E2E verification", "doing");
  addScopeCriterion(p, "Production smoke test", "blocked");
  const status = formatProject(p);
  assert.match(status, /CURRENT[\s\S]*C002 E2E verification/);
  assert.match(status, /BLOCKED[\s\S]*C003 Production smoke test/);
  assert.match(status, /NEXT[\s\S]*C002 E2E verification/);
  const handoff = formatHandoff(p);
  assert.match(handoff, /## Next[\s\S]*C002 E2E verification/);
});


test("live inferred next actions do not hide unfinished completion scope", async () => {
  const { addScopeCriterion } = await import("../src/domain.js");
  const p = createProject({ id: "scope-live-next", name: "Scope Live Next" });
  addScopeCriterion(p, "Auth verified", "done");
  addScopeCriterion(p, "E2E verification", "doing");
  addScopeCriterion(p, "Production smoke test", "todo");
  p.observations = {
    inferredNext: ["CI baselineを切り分ける"],
    local: { dirty: false, changedFiles: 0, changes: [] },
    github: { failedJobs: [], ciFailureSummary: [], recentMergedPrs: [] },
    verification: { required: false, status: "unknown", label: null },
    readiness: { total: 0, ready: 0, failed: 0, pending: 0, cancelled: 0 },
    supabase: {},
    vercel: {},
    observedAt: "2026-09-11T01:00:00Z"
  };
  const status = formatProject(p);
  assert.match(status, /NEXT[\s\S]*1\. CI baselineを切り分ける/);
  assert.match(status, /NEXT[\s\S]*C002 E2E verification/);
  assert.match(status, /NEXT[\s\S]*C003 Production smoke test/);
  const handoff = formatHandoff(p);
  assert.match(handoff, /## Next[\s\S]*CI baselineを切り分ける/);
  assert.match(handoff, /## Next[\s\S]*C002 E2E verification/);
});


test("handoff current and blocked include scope workflow state", async () => {
  const { addScopeCriterion } = await import("../src/domain.js");
  const p = createProject({ id: "scope-handoff-state", name: "Scope Handoff State" });
  addScopeCriterion(p, "Auth", "done");
  addScopeCriterion(p, "Browser verification", "doing");
  addScopeCriterion(p, "Production smoke test", "blocked");
  const handoff = formatHandoff(p);
  assert.match(handoff, /## Current[\s\S]*C002 Browser verification/);
  assert.match(handoff, /## Blocked[\s\S]*C003 Production smoke test/);
});

test("vercel=none never reaches the Vercel CLI", () => {
  const p = musubuProductionFixture();
  p.vercel = SERVICE_UNUSED;
  p.deployment.pr = null;
  p.deployment.preview = "cancelled";
  const calls = [];
  const observations = emptyVercelObservations();
  observations.vercel.linked = false;

  syncVercel(p, observations, {
    commandAvailable: true,
    runner: vercelRunner({ ok: true, stdout: VERCEL_PRODUCTION_OUTPUT, stderr: "" }, calls)
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(observations.warnings, []);
  assert.equal(p.deployment.preview, "cancelled");
});

test("vercel=none does not warn about a missing Vercel CLI", () => {
  const p = musubuProductionFixture();
  p.vercel = SERVICE_UNUSED;
  const observations = emptyVercelObservations();
  observations.vercel.linked = false;

  syncVercel(p, observations, {
    commandAvailable: false,
    runner: () => { throw new Error("runner must not be called for vercel=none"); }
  });

  assert.deepEqual(observations.warnings, []);
});

test("explicit vercel=none survives a local .vercel link and supabase=none skips its CLI", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-service-none-"));
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  git(dir, "init");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "SUMI Test");
  git(dir, "add", "README.md");
  git(dir, "commit", "-m", "initial commit");
  fs.mkdirSync(path.join(dir, ".vercel"));
  fs.writeFileSync(
    path.join(dir, ".vercel", "project.json"),
    JSON.stringify({ projectId: "prj_fixture", orgId: "team_fixture", projectName: "linked-fixture" })
  );

  const p = createProject({ id: "service-none", name: "Service None", local: dir });
  p.vercel = SERVICE_UNUSED;
  p.supabase = SERVICE_UNUSED;
  const o = syncProject(p, { skipVercel: true, skipSupabase: false });

  assert.equal(p.vercel, SERVICE_UNUSED);
  assert.equal(o.supabase.configured, false);
  assert.equal(o.warnings.some((warning) => /Supabase/i.test(warning)), false);
  assert.ok(o.warnings.some((warning) => /registered as vercel=none/.test(warning)));
});

test("sync stops suggesting a Production check it has no way to observe", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-infer-production-"));
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  git(dir, "init");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "SUMI Test");
  git(dir, "add", "README.md");
  git(dir, "commit", "-m", "initial commit");

  const unobservable = createProject({ id: "unobservable", name: "Unobservable", local: dir });
  const withoutSource = syncProject(unobservable, { skipVercel: true, skipSupabase: true });
  assert.equal(withoutSource.inferredNext.includes("Productionの反映状態を確認する"), false);

  const registered = createProject({ id: "registered", name: "Registered", local: dir, vercel: "registered-app" });
  const withSource = syncProject(registered, { skipVercel: true, skipSupabase: true });
  assert.ok(withSource.inferredNext.includes("Productionの反映状態を確認する"));
});
