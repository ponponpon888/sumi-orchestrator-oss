import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { addScopeCriterion, createProject } from "../src/domain.js";
import { formatDashboard, formatProject } from "../src/format.js";
import { formatContinue } from "../src/continue.js";
import { formatHandoff } from "../src/handoff.js";
import { assessCiHealth, assessDeployHealth, buildHealthReport, formatHealthReport, reportHasAlertsAtLeast, CI_STALE_COMMITS, CI_STALE_DAYS, classifyVercelStatus, DEPLOY_STUCK_MINUTES, getHealthAlerts } from "../src/health.js";
import { formatGlobalQueue, getGlobalQueue, selectGlobalQueueItem } from "../src/queue.js";
import { syncProject } from "../src/sync.js";

const NOW = new Date("2026-10-28T00:00:00Z");
const HEAD = "b".repeat(40);
const OLD = "a".repeat(40);
const active = [{ name: "Test", state: "active", path: ".github/workflows/test.yml" }];
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

test("CI that ran for the head commit is current", () => {
  const health = assessCiHealth({ branch: "main", workflows: active, runs: [{ headSha: HEAD, createdAt: daysAgo(0) }], head: { sha: HEAD, committedAt: daysAgo(0) }, now: NOW });
  assert.equal(health.status, "current");
  assert.equal(health.commitsSince, 0);
  assert.deepEqual(getHealthAlerts({ observations: { github: { ciHealth: health } } }), []);
});

test("every workflow disabled is 'disabled', with how far main has moved since the last run", () => {
  const health = assessCiHealth({
    branch: "main",
    workflows: [{ name: "Test", state: "disabled_manually", path: ".github/workflows/test.yml" }],
    runs: [{ headSha: OLD, createdAt: "2026-09-18T06:47:59Z", url: "u" }],
    head: { sha: HEAD, committedAt: daysAgo(2) },
    aheadBy: 112,
    now: NOW
  });
  assert.equal(health.status, "disabled");
  assert.equal(health.commitsSince, 112);
  assert.equal(health.daysSince, 39);
  assert.match(health.summary, /Test \(disabled_manually\); last run 2026-09-18 @ aaaaaaaaaaaa, 112 commit\(s\) \/ 39 day\(s\) since/);
  const [alert] = getHealthAlerts({ observations: { github: { ciHealth: health } } });
  assert.deepEqual([alert.key, alert.severity, alert.owner], ["ci-disabled", "high", "human"]);
});

test("no run for the head commit is stale only past the day or commit threshold", () => {
  const base = { branch: "main", workflows: active, head: { sha: HEAD, committedAt: daysAgo(1) }, now: NOW };
  const run = (days) => [{ headSha: OLD, createdAt: daysAgo(days) }];
  assert.equal(assessCiHealth({ ...base, runs: run(1), aheadBy: 2 }).status, "unverified", "path filters can skip a docs commit");
  assert.equal(assessCiHealth({ ...base, runs: run(CI_STALE_DAYS), aheadBy: 1 }).status, "stale");
  assert.equal(assessCiHealth({ ...base, runs: run(1), aheadBy: CI_STALE_COMMITS }).status, "stale");
  assert.equal(assessCiHealth({ ...base, runs: run(1), aheadBy: null }).status, "unverified", "unknown distance is not an alarm by itself");
  const [alert] = getHealthAlerts({ observations: { github: { ciHealth: assessCiHealth({ ...base, runs: run(30), aheadBy: 3 }) } } });
  assert.equal(alert.key, "ci-stale");
});

test("a head commit younger than the grace period is not stale yet", () => {
  const health = assessCiHealth({
    branch: "main", workflows: active,
    runs: [{ headSha: OLD, createdAt: daysAgo(30) }],
    head: { sha: HEAD, committedAt: new Date(NOW.getTime() - 5 * 60000).toISOString() },
    aheadBy: 50, now: NOW
  });
  assert.equal(health.status, "unverified");
});

test("no workflows, only deleted ones, never-run, and unreadable inputs are told apart", () => {
  const head = { sha: HEAD, committedAt: daysAgo(1) };
  assert.equal(assessCiHealth({ workflows: [], runs: [], head, now: NOW }).status, "none");
  assert.equal(assessCiHealth({ workflows: [{ name: "Old", state: "deleted" }], runs: [], head, now: NOW }).status, "none");
  const never = assessCiHealth({ workflows: active, runs: [], head, now: NOW });
  assert.equal(never.status, "never");
  assert.equal(getHealthAlerts({ observations: { github: { ciHealth: never } } })[0].severity, "medium");
  assert.equal(assessCiHealth({ workflows: null, runs: [], head, now: NOW }).status, "unknown");
  assert.equal(assessCiHealth({ workflows: active, runs: [], head: null, now: NOW }).status, "unknown");
});

test("a partly disabled set with a current run is current, and still names what is off", () => {
  const health = assessCiHealth({
    workflows: [...active, { name: "Deploy", state: "disabled_inactivity" }],
    runs: [{ headSha: HEAD, createdAt: daysAgo(0) }], head: { sha: HEAD }, now: NOW
  });
  assert.equal(health.status, "current");
  assert.deepEqual(health.disabledWorkflows.map((w) => w.name), ["Deploy"]);
});

function fakeApi(routes) {
  return (path, params = {}) => {
    const query = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    const route = query ? `${path}?${query}` : path;
    for (const [pattern, response] of Object.entries(routes)) {
      if (route === pattern || route.startsWith(`${pattern}?`)) return { ok: true, data: response };
    }
    return { ok: false, error: `unrouted: ${route}` };
  };
}

function musubuLike() {
  const p = createProject({ id: "musubu", name: "MUSUBU", repo: "owner/musubu" });
  syncProject(p, {
    skipVercel: true, skipSupabase: true, githubTextApi: () => ({ ok: false }),
    githubApi: fakeApi({
      "repos/owner/musubu/pulls": [],
      "repos/owner/musubu": { default_branch: "main" },
      "repos/owner/musubu/actions/runs": { workflow_runs: [{ id: 1, name: "Test", status: "completed", conclusion: "success", head_sha: OLD, created_at: "2026-09-18T06:47:59Z" }] },
      "repos/owner/musubu/actions/workflows": { total_count: 1, workflows: [{ name: "Test", state: "disabled_manually", path: ".github/workflows/test.yml" }] },
      "repos/owner/musubu/commits/main": { sha: HEAD, commit: { committer: { date: "2026-10-25T16:55:54Z" } } },
      [`repos/owner/musubu/compare/${OLD}...${HEAD}`]: { ahead_by: 112 }
    })
  });
  return p;
}

test("sync reproduces the musubu case: a disabled workflow and 112 unverified commits", () => {
  const p = musubuLike();
  const health = p.observations.github.ciHealth;
  assert.equal(health.status, "disabled");
  assert.equal(health.commitsSince, 112);
  assert.equal(health.lastRun.sha, OLD);
  assert.equal(p.deployment.ci, "unknown", "an old success is never reported for the current commit");
  assert.match(formatProject(p), /CI HEALTH\s+disabled — every workflow is disabled: Test \(disabled_manually\)/);
  assert.match(formatProject(p), /HEALTH ALERTS\n\s+! \[high\] CI is switched off/);
});

test("alerts reach every view for an unscoped project, and never shift queue numbering", () => {
  const musubu = musubuLike();
  const scoped = createProject({ id: "app", name: "APP" });
  addScopeCriterion(scoped, "Implement the thing", "todo");
  const projects = { musubu, app: scoped };

  const rows = getGlobalQueue(projects);
  assert.ok(rows.every((row) => row.projectId === "app"), "an alert is not a work item");
  assert.equal(selectGlobalQueueItem(rows, "1").projectId, "app");
  const queue = formatGlobalQueue(projects, rows);
  assert.match(queue, /Health alerts: 1/);
  assert.match(queue, /HEALTH ALERTS \(human; not work items\)\n\s+! P3 MUSUBU \[musubu\] \[high\] CI is switched off/);
  assert.match(queue, /AGENT READY\n\s+1\. P3 APP \[app\]/);

  assert.match(formatDashboard(projects), /HEALTH ALERTS\n\s+! musubu: \[high\] CI is switched off/);
  assert.match(formatContinue(musubu), /HEALTH ALERTS\n\s+! \[high\] CI is switched off/);
  const handoff = formatHandoff(musubu);
  assert.match(handoff, /- CI health: disabled/);
  assert.match(handoff, /## Health alerts\n- \[high\] CI is switched off/);
});

test("when CI health cannot be read, it is unknown with a warning and raises no alert", () => {
  const p = createProject({ id: "x", name: "X", repo: "owner/x" });
  syncProject(p, {
    skipVercel: true, skipSupabase: true, githubTextApi: () => ({ ok: false }),
    githubApi: fakeApi({
      "repos/owner/x/pulls": [],
      "repos/owner/x": { default_branch: "main" },
      "repos/owner/x/actions/runs": { workflow_runs: [] }
    })
  });
  assert.equal(p.observations.github.ciHealth.status, "unknown");
  assert.ok(p.observations.warnings.some((w) => /CI health unknown/.test(w)));
  assert.deepEqual(getHealthAlerts(p), []);
});

// --- Production deploy health -------------------------------------------

const sha = (c) => c.repeat(40);
const vercel = (state, description, extra = {}) => ({ context: "Vercel", state, description, url: "v", updatedAt: NOW.toISOString(), ...extra });
const DONE = vercel("success", "Deployment has completed");
const IGNORED = vercel("success", "Canceled by Ignored Build Step");
const FAILED = vercel("failure", "Deployment has failed — run this Vercel CLI command: npx vercel inspect dpl_x --logs");
const commit = (c, statuses, days = 0) => ({ sha: sha(c), committedAt: daysAgo(days), statuses });

test("Vercel statuses are classified by state and description, as Vercel actually posts them", () => {
  assert.equal(classifyVercelStatus(DONE), "deployed");
  assert.equal(classifyVercelStatus(IGNORED), "ignored");
  assert.equal(classifyVercelStatus(vercel("pending", "Vercel is deploying your app")), "pending");
  assert.equal(classifyVercelStatus(FAILED), "failed");
  assert.equal(classifyVercelStatus(vercel("failure", "Canceled from the Vercel Dashboard")), "canceled");
  assert.equal(classifyVercelStatus(vercel("error", "Deployment has failed")), "failed");
  assert.equal(classifyVercelStatus(null), "none");
});

test("a deployed head is current; a failed head says where production still is", () => {
  const ok = assessDeployHealth({ branch: "main", commits: [commit("c", [DONE])], now: NOW });
  assert.equal(ok.status, "current");
  assert.deepEqual(getHealthAlerts({ observations: { github: { deployHealth: ok } } }), []);

  const failed = assessDeployHealth({ branch: "main", commits: [commit("c", [FAILED]), commit("b", []), commit("a", [DONE], 3)], now: NOW });
  assert.equal(failed.status, "failed");
  assert.match(failed.summary, /production is at aaaaaaaaaaaa \(\d{4}-\d\d-\d\d\), 2 commit\(s\) behind main/);
  const [alert] = getHealthAlerts({ observations: { github: { deployHealth: failed } } });
  assert.deepEqual([alert.key, alert.severity], ["deploy-failed", "high"]);
  assert.match(alert.text, /^Production is behind main — the latest deploy failed/);
});

test("an ignored head is fine unless a commit since the last deploy failed", () => {
  const skipped = assessDeployHealth({ branch: "main", commits: [commit("c", [IGNORED]), commit("b", []), commit("a", [DONE])], now: NOW });
  assert.equal(skipped.status, "current");
  assert.match(skipped.summary, /skipped by Ignored Build Step; production is at aaaaaaaaaaaa/);

  const hidden = assessDeployHealth({ branch: "main", commits: [commit("c", [IGNORED]), commit("b", [FAILED]), commit("a", [DONE])], now: NOW });
  assert.equal(hidden.status, "behind", "a failed change does not ship because a later docs commit was skipped");
  assert.equal(getHealthAlerts({ observations: { github: { deployHealth: hidden } } })[0].severity, "high");
});

test("pending is deploying until it is stuck; a dashboard cancel is its own alert", () => {
  const pending = (minutes) => vercel("pending", "Vercel is deploying your app", { updatedAt: new Date(NOW.getTime() - minutes * 60000).toISOString() });
  const commits = (head) => [commit("c", [head]), commit("a", [DONE], 1)];
  assert.equal(assessDeployHealth({ branch: "main", commits: commits(pending(5)), now: NOW }).status, "deploying");
  const stuck = assessDeployHealth({ branch: "main", commits: commits(pending(DEPLOY_STUCK_MINUTES + 15)), now: NOW });
  assert.equal(stuck.status, "stuck");
  assert.match(stuck.summary, /pending for 45 minute\(s\)/);
  assert.equal(getHealthAlerts({ observations: { github: { deployHealth: stuck } } })[0].severity, "medium");
  const canceled = assessDeployHealth({ branch: "main", commits: commits(vercel("failure", "Canceled from the Vercel Dashboard")), now: NOW });
  assert.equal(canceled.status, "canceled");
  assert.equal(getHealthAlerts({ observations: { github: { deployHealth: canceled } } })[0].key, "deploy-canceled");
});

test("no Vercel at all, unreadable, nothing deployed in the window, and a silent Vercel are told apart", () => {
  assert.equal(assessDeployHealth({ branch: "main", commits: [commit("c", []), commit("b", [])], now: NOW }).status, "none");
  assert.equal(assessDeployHealth({ branch: "main", commits: [commit("c", null)], now: NOW }).status, "unknown");
  assert.equal(assessDeployHealth({ branch: "main", commits: null, now: NOW }).status, "unknown");
  const window = assessDeployHealth({ branch: "main", commits: [commit("c", [IGNORED]), commit("b", [IGNORED])], scanLimit: 2, now: NOW });
  assert.equal(window.status, "behind");
  assert.match(window.summary, /no completed deploy in the last 2 commit\(s\) scanned/);
  const silent = (days) => assessDeployHealth({ branch: "main", commits: [commit("c", [], 1), commit("a", [DONE], days)], now: NOW });
  assert.equal(silent(2).status, "unverified");
  assert.equal(silent(CI_STALE_DAYS + 3).status, "stale");
  assert.equal(getHealthAlerts({ observations: { github: { deployHealth: silent(10) } } })[0].text.startsWith("Vercel has stopped deploying main"), true);
});

test("several Vercel projects on one repository: the worst one decides and each is named", () => {
  const admin = (status) => ({ ...status, context: "Vercel – admin" });
  const health = assessDeployHealth({ branch: "main", commits: [commit("c", [DONE, admin(FAILED)]), commit("a", [DONE, admin(DONE)])], now: NOW });
  assert.equal(health.status, "failed");
  assert.deepEqual(health.targets.map((t) => [t.context, t.status]), [["Vercel", "current"], ["Vercel – admin", "failed"]]);
  assert.match(health.summary, /Vercel – admin: failed — /);
});

function deployApi({ statuses, failAt = null, extra = {} }) {
  const shas = Object.keys(statuses);
  const calls = [];
  const api = (path, params = {}) => {
    calls.push(path);
    if (path === "repos/owner/web") return { ok: true, data: { default_branch: "main" } };
    if (path === "repos/owner/web/pulls") return { ok: true, data: [] };
    if (path === "repos/owner/web/commits") return { ok: true, data: shas.map((s, i) => ({ sha: s, commit: { committer: { date: daysAgo(i) } } })) };
    const m = path.match(/^repos\/owner\/web\/commits\/([0-9a-f]{40})\/status$/);
    if (m) return m[1] === failAt ? { ok: false, error: "HTTP 502" } : { ok: true, data: { statuses: statuses[m[1]] } };
    if (path in extra) return { ok: true, data: extra[path] };
    return { ok: false, error: `unrouted: ${path}` };
  };
  api.calls = calls;
  return api;
}

test("sync scans back only to the last completed deploy, and stops with a warning on a read failure", () => {
  const p = createProject({ id: "web", name: "WEB", repo: "owner/web" });
  const api = deployApi({ statuses: { [sha("c")]: [FAILED], [sha("b")]: [DONE], [sha("a")]: [DONE] } });
  syncProject(p, { skipVercel: true, skipSupabase: true, githubTextApi: () => ({ ok: false }), githubApi: api });
  assert.equal(p.observations.github.deployHealth.status, "failed");
  assert.equal(p.observations.github.deployHealth.targets[0].commitsBehind, 1);
  assert.ok(!api.calls.includes(`repos/owner/web/commits/${sha("a")}/status`), "no read past the last deploy");
  assert.match(formatProject(p), /PROD DEPLOY failed — the deploy of the latest commit failed/);
  assert.match(formatHandoff(p), /- Production deploy \(main\): failed/);

  const q = createProject({ id: "web", name: "WEB", repo: "owner/web" });
  syncProject(q, { skipVercel: true, skipSupabase: true, githubTextApi: () => ({ ok: false }), githubApi: deployApi({ statuses: { [sha("c")]: [IGNORED], [sha("b")]: [], [sha("a")]: [DONE] }, failAt: sha("b") }) });
  assert.equal(q.observations.github.deployHealth.status, "unknown", "an unfinished scan claims neither current nor behind");
  assert.ok(q.observations.warnings.some((w) => /Production deploy scan stopped at bbbbbbbbbbbb/.test(w)));
  assert.deepEqual(getHealthAlerts(q), []);

  const s = createProject({ id: "web", name: "WEB", repo: "owner/web" });
  syncProject(s, { skipVercel: true, skipSupabase: true, githubTextApi: () => ({ ok: false }), githubApi: deployApi({ statuses: { [sha("c")]: [FAILED], [sha("b")]: [], [sha("a")]: [DONE] }, failAt: sha("b") }) });
  assert.equal(s.observations.github.deployHealth.status, "failed", "a failed head is known without the rest of the scan");

  const r = createProject({ id: "web", name: "WEB", repo: "owner/web" });
  syncProject(r, { skipVercel: true, skipSupabase: true, githubTextApi: () => ({ ok: false }), githubApi: deployApi({ statuses: { [sha("c")]: [DONE] }, failAt: sha("c") }) });
  assert.equal(r.observations.github.deployHealth.status, "unknown");
  assert.deepEqual(getHealthAlerts(r).filter((a) => a.key.startsWith("deploy")), []);
});

test("a project registered as not using Vercel is not scanned", () => {
  const p = createProject({ id: "web", name: "WEB", repo: "owner/web", vercel: "none" });
  const api = deployApi({ statuses: { [sha("c")]: [FAILED] } });
  syncProject(p, { skipVercel: true, skipSupabase: true, githubTextApi: () => ({ ok: false }), githubApi: api });
  assert.equal(p.observations.github.deployHealth, null);
  assert.ok(!api.calls.includes("repos/owner/web/commits"));
});

test("CI switched off while production serves main: the CI alert says the unverified code is live", () => {
  const p = createProject({ id: "web", name: "WEB", repo: "owner/web" });
  syncProject(p, {
    skipVercel: true, skipSupabase: true, githubTextApi: () => ({ ok: false }),
    githubApi: deployApi({
      statuses: { [sha("c")]: [DONE] },
      extra: {
        "repos/owner/web/actions/runs": { workflow_runs: [{ id: 1, name: "Test", status: "completed", conclusion: "success", head_sha: OLD, created_at: "2026-09-18T06:47:59Z" }] },
        "repos/owner/web/actions/workflows": { total_count: 1, workflows: [{ name: "Test", state: "disabled_manually" }] },
        [`repos/owner/web/commits/main`]: { sha: sha("c"), commit: { committer: { date: daysAgo(0) } } },
        [`repos/owner/web/compare/${OLD}...${sha("c")}`]: { ahead_by: 112 }
      }
    })
  });
  const [ci] = getHealthAlerts(p);
  assert.equal(ci.key, "ci-disabled");
  assert.match(ci.text, /; production is serving these unverified commits$/);
});

// --- sumi health ----------------------------------------------------------

function healthProjects() {
  const musubu = musubuLike();
  const ciHealth = assessCiHealth({ branch: "main", workflows: active, runs: [{ headSha: HEAD, createdAt: daysAgo(0) }], head: { sha: HEAD, committedAt: daysAgo(0) }, now: NOW });
  const quiet = createProject({ id: "quiet", name: "QUIET", repo: "owner/quiet" });
  quiet.observations = { warnings: [], github: { ciHealth, deployHealth: assessDeployHealth({ branch: "main", commits: [commit("b", [DONE])], now: NOW }) } };
  const blind = createProject({ id: "blind", name: "BLIND", repo: "owner/blind" });
  blind.observations = { warnings: ["Default branch lookup skipped: gh: HTTP 403"], github: {} };
  const noVercel = createProject({ id: "static", name: "STATIC", repo: "owner/static", vercel: "none" });
  noVercel.observations = { warnings: [], github: { ciHealth } };
  return { musubu, quiet, blind, static: noVercel };
}

test("the health report lists alerts, and lists what it could not see instead of calling it fine", () => {
  const report = buildHealthReport(healthProjects(), { syncErrors: { quiet: "boom" }, now: NOW });
  assert.deepEqual(report.totals, { projects: 4, high: 1, medium: 0, notObserved: 3 });
  const byId = Object.fromEntries(report.projects.map((row) => [row.id, row]));
  assert.deepEqual(byId.blind.notObserved, ["CI health not observed", "production deploy not observed"]);
  assert.deepEqual(byId.blind.notes, ["Default branch lookup skipped: gh: HTTP 403"]);
  assert.deepEqual(byId.quiet.notObserved, ["sync failed: boom"], "a failed sync is never a clean row");
  assert.deepEqual(byId.static.notObserved, [], "a project without Vercel is not missing a deploy");
  assert.match(byId.musubu.notObserved.join(), /production deploy unknown/);

  const text = formatHealthReport(report);
  assert.match(text, /4 project\(s\): 1 high, 0 medium alert\(s\); 3 not fully observed/);
  assert.match(text, /\nstatic\s+current\s+\(no vercel\)\s+—/);
  assert.match(text, /\nblind\s+—\s+—\s+\? \(not observed\)/);
  assert.match(text, /ALERTS \(human; not work items\)\n  ! musubu \[high\] CI is switched off/);
  assert.match(text, /NOT OBSERVED \(absence of alerts here means nothing\)\n  \? blind: CI health not observed; production deploy not observed\n      - Default branch lookup skipped/);
  assert.match(text, /\n  \? musubu: production deploy unknown\n/);
  assert.doesNotMatch(text, /No health alerts/);

  assert.equal(reportHasAlertsAtLeast(report, "high"), true);
  assert.equal(reportHasAlertsAtLeast(buildHealthReport({ quiet: healthProjects().quiet }, { now: NOW }), "medium"), false);
  assert.throws(() => reportHasAlertsAtLeast(report, "low"), /--fail-on must be high or medium/);
  assert.match(formatHealthReport(buildHealthReport({ quiet: healthProjects().quiet }, { now: NOW })), /No health alerts\./);
});

test("sumi health prints the report, --json is machine-readable, and --fail-on sets exit code 3", () => {
  const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-health-"));
  const statePath = path.join(root, "state.json");
  const sumi = (...args) => spawnSync(process.execPath, [cliPath, "--data", statePath, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  try {
    assert.equal(sumi("init").status, 0);
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    state.projects = JSON.parse(JSON.stringify(healthProjects()));
    fs.writeFileSync(statePath, JSON.stringify(state));

    const plain = sumi("health");
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /^SUMI HEALTH — /);
    assert.match(plain.stdout, /! musubu \[high\] CI is switched off/);

    const json = sumi("health", "--json");
    assert.equal(json.status, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).totals.high, 1);

    assert.equal(sumi("health", "--fail-on", "high").status, 3);
    const bad = sumi("health", "--fail-on", "low");
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--fail-on must be high or medium/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
