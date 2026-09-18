import test from "node:test";
import assert from "node:assert/strict";
import { addScopeCriterion, createProject, PROJECT_STATES, SERVICE_UNUSED, setDeployment } from "../src/domain.js";
import { formatDashboard, formatProject } from "../src/format.js";
import { formatHandoff } from "../src/handoff.js";

function observed(patch = {}) {
  return {
    local: { dirty: false, changedFiles: 0, changes: [] },
    github: { failedJobs: [], ciFailureSummary: [], recentMergedPrs: [] },
    vercel: {},
    supabase: {},
    verification: { required: false, status: "unknown", label: null },
    readiness: { total: 0, ready: 0, failed: 0, pending: 0, cancelled: 0 },
    inferredNext: [],
    observedAt: "2026-09-15T04:53:20.192Z",
    ...patch
  };
}

test("status reports UNSCOPED and the exact commands that close each setup gap", () => {
  const p = createProject({ id: "client-site", name: "client International", repo: "owner/client-site", local: "C:\\Dev\\client-site" });
  p.observations = observed();
  const text = formatProject(p);

  assert.match(text, /STATE\s+UNSCOPED/);
  assert.match(text, /SETUP\s+incomplete: scope, vercel/);
  assert.match(text, /SETUP REQUIRED[\s\S]*sumi scope add client-site/);
  assert.match(text, /SETUP REQUIRED[\s\S]*sumi project set client-site --vercel/);
  assert.match(text, /VERCEL\s+not registered/);
});

test("status separates a service that is deliberately not used from one never registered", () => {
  const p = createProject({ id: "cli-tool", name: "CLI Tool" });
  p.vercel = SERVICE_UNUSED;
  p.supabase = SERVICE_UNUSED;
  addScopeCriterion(p, "Release the installer", "todo");
  p.observations = observed();
  const text = formatProject(p);

  assert.match(text, /VERCEL\s+not used/);
  assert.match(text, /SUPABASE\s+not used/);
  assert.match(text, /SETUP\s+ok/);
  assert.doesNotMatch(text, /SETUP REQUIRED/);
  assert.match(text, /STATE\s+IN DEVELOPMENT/);
});

test("status keeps the existing DONE and IMPLEMENTED labels for scoped projects", () => {
  const p = createProject({ id: "done", name: "Done", vercel: "done-app" });
  addScopeCriterion(p, "Auth verified", "done");
  p.observations = observed();
  assert.match(formatProject(p), /STATE\s+IMPLEMENTED \/ PROD UNVERIFIED/);

  setDeployment(p, { production: "verified" });
  assert.match(formatProject(p), /STATE\s+DONE/);
});

test("status shows a registered Vercel project even before a local link is observed", () => {
  const p = createProject({ id: "registered", name: "Registered", vercel: "client-site" });
  addScopeCriterion(p, "Production smoke test", "todo");
  p.observations = observed();
  assert.match(formatProject(p), /VERCEL\s+registered \(client-site\)/);
});

test("handoff separates an unregistered service from one that is not used", () => {
  const unregistered = createProject({ id: "client-site", name: "client International" });
  unregistered.observations = observed();
  const text = formatHandoff(unregistered);

  assert.match(text, /- Vercel: 未登録/);
  assert.match(text, /- Supabase: 未登録/);
  assert.match(text, /## Setup gaps[\s\S]*完了条件\(Scope\)が未定義/);
  assert.match(text, /## Setup gaps[\s\S]*Vercel連携が未登録/);
});

test("handoff reports a deliberately unused service and no setup gaps", () => {
  const unused = createProject({ id: "cli-tool", name: "CLI Tool" });
  unused.vercel = SERVICE_UNUSED;
  unused.supabase = SERVICE_UNUSED;
  addScopeCriterion(unused, "Release the installer", "todo");
  unused.observations = observed();
  const text = formatHandoff(unused);

  assert.match(text, /- Vercel: 不使用（none）/);
  assert.match(text, /- Supabase: 不使用（none）/);
  assert.match(text, /## Setup gaps\n- なし/);
});

test("dashboard shows UNSCOPED with the missing registrations instead of READY", () => {
  const unscoped = createProject({ id: "client-site", name: "client International" });
  unscoped.observations = observed();
  const scoped = createProject({ id: "scoped", name: "Scoped", vercel: "scoped-app" });
  addScopeCriterion(scoped, "Auth verified", "todo");
  scoped.observations = observed();

  const text = formatDashboard({ client: unscoped, scoped });
  assert.match(text, /client-site\s+P3\s+—\s+UNSCOPED setup: scope, vercel/);
  assert.match(text, /scoped\s+P3\s+0%\s+READY\s+C001 Auth verified/);
  assert.equal(PROJECT_STATES.UNSCOPED, "UNSCOPED");
});
