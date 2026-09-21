import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createEmptyState, createProject, SERVICE_UNUSED } from "../src/domain.js";
import { addFinding, addPattern, buildFindingsMatrix, findSweep, getFinding, listFindings } from "../src/findings.js";
import { evaluateCheckRun, formatSweepRun, resolveSweepWorktree, runSweep, summarizeSweep } from "../src/sweep.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function setup(projectPatch = {}) {
  const state = createEmptyState();
  const project = Object.assign(createProject({ id: "musubu", name: "MUSUBU", local: "/tmp/musubu" }), projectPatch);
  state.projects[project.id] = project;
  return { state, project };
}

function mechanicalPattern(state, overrides = {}) {
  return addPattern(state, {
    key: "supabase-rls-off",
    title: "A public table has RLS disabled",
    question: "Does every public table have row level security enabled?",
    origin: "record",
    severity: "high",
    check: { argv: ["node", "scripts/check-rls.mjs"], cwd: "repo", timeoutMs: 30000, expect: "exit-zero" },
    ...overrides
  });
}

// The sweep resolves the worktree through git, so every test that gets as far
// as running a check supplies both the worktree and the check result.
function stubbedSweep(state, result, options = {}) {
  return runSweep(state, {
    runner: () => result,
    worktreeResolver: () => ({ ok: true, cwd: "/tmp/musubu", commit: COMMIT }),
    ...options
  });
}

function ok(overrides = {}) {
  return { ok: true, status: 0, signal: null, stdout: "", stderr: "", error: null, errorCode: null, timedOut: false, ...overrides };
}

test("expect describes the healthy project, so a missed expectation is the reproduction", () => {
  const zero = { expect: "exit-zero", timeoutMs: 1000 };
  assert.equal(evaluateCheckRun(zero, ok({ status: 0 })).reproduced, false);
  assert.equal(evaluateCheckRun(zero, ok({ status: 1 })).reproduced, true);

  const nonzero = { expect: "exit-nonzero", timeoutMs: 1000 };
  assert.equal(evaluateCheckRun(nonzero, ok({ status: 1 })).reproduced, false);
  assert.equal(evaluateCheckRun(nonzero, ok({ status: 0 })).reproduced, true);

  const quiet = { expect: "no-output", timeoutMs: 1000 };
  assert.equal(evaluateCheckRun(quiet, ok({ stdout: "" })).reproduced, false);
  assert.equal(evaluateCheckRun(quiet, ok({ stdout: "public.bookings" })).reproduced, true);
});

test("a check that never ran is an error, never a verdict", () => {
  const check = { expect: "exit-zero", timeoutMs: 5000 };
  const timedOut = evaluateCheckRun(check, ok({ status: null, timedOut: true, error: "ETIMEDOUT" }));
  assert.equal(timedOut.ran, false);
  assert.match(timedOut.reason, /timed out after 5000ms/);

  const missing = evaluateCheckRun(check, ok({ status: null, error: "spawn ENOENT" }));
  assert.equal(missing.ran, false);
  assert.equal(missing.reproduced, undefined);

  const signalled = evaluateCheckRun(check, ok({ status: null, signal: "SIGKILL" }));
  assert.equal(signalled.ran, false);
  assert.match(signalled.reason, /SIGKILL/);
});

test("a no-output check that dies silently is an error, not a clean project", () => {
  const quiet = { expect: "no-output", timeoutMs: 1000 };
  // A linter that prints its violations and exits non-zero still reports.
  const reported = evaluateCheckRun(quiet, ok({ status: 1, stdout: "src/api.ts: no tenant filter" }));
  assert.equal(reported.ran, true);
  assert.equal(reported.reproduced, true);

  // Silence plus a non-zero exit is a check that died, not a clean answer.
  const died = evaluateCheckRun(quiet, ok({ status: 127 }));
  assert.equal(died.ran, false);
  assert.equal(died.reproduced, undefined);
  assert.match(died.reason, /exited 127 without output/);

  assert.equal(evaluateCheckRun(quiet, ok({ status: 0 })).reproduced, false);
});

test("a reproduced check files a sweep-sourced finding and R1(a) confirms it", () => {
  const { state, project } = setup();
  mechanicalPattern(state);
  const outcome = stubbedSweep(state, ok({ status: 1, stdout: "public.bookings has RLS disabled" }));

  assert.equal(outcome.rows.length, 1);
  const row = outcome.rows[0];
  assert.equal(row.outcome, "reproduced");
  assert.equal(row.status, "confirmed");
  assert.equal(row.recorded, true);

  const finding = getFinding(project, row.findingId);
  assert.equal(finding.status, "confirmed");
  assert.equal(finding.source.kind, "sweep");
  assert.equal(finding.confirmations.length, 1);
  assert.equal(finding.confirmations[0].check.satisfied, true);
  assert.equal(finding.confirmations[0].check.exitCode, 1);
  assert.equal(finding.evidence.commit, COMMIT);
  assert.match(finding.evidence.output, /public\.bookings/);
});

test("a second sweep confirms the open finding instead of filing a duplicate", () => {
  const { state, project } = setup();
  mechanicalPattern(state);
  const first = stubbedSweep(state, ok({ status: 1, stdout: "still disabled" }));
  const second = stubbedSweep(state, ok({ status: 1, stdout: "still disabled" }));

  assert.equal(second.rows[0].findingId, first.rows[0].findingId);
  assert.equal(listFindings(project, { patternKey: "supabase-rls-off" }).length, 1);
  assert.equal(getFinding(project, first.rows[0].findingId).confirmations.length, 2);
});

test("reproducing a closed finding files a new one rather than reopening it", () => {
  const { state, project } = setup();
  const pattern = mechanicalPattern(state);
  const first = stubbedSweep(state, ok({ status: 1 }));
  const finding = getFinding(project, first.rows[0].findingId);
  finding.status = "dismissed";
  finding.reason = "accepted risk for this release";

  const second = stubbedSweep(state, ok({ status: 1 }));
  assert.notEqual(second.rows[0].findingId, first.rows[0].findingId);
  assert.equal(getFinding(project, first.rows[0].findingId).status, "dismissed");
  assert.equal(getFinding(project, second.rows[0].findingId).status, "confirmed");
  assert.equal(listFindings(project, { patternKey: pattern.key }).length, 2);
});

test("a clean run records no confirmation, so it cannot supply R1's second source kind", () => {
  const { state, project } = setup();
  mechanicalPattern(state);
  const agentFinding = addFinding(state, project, {
    title: "RLS looks disabled on bookings",
    patternKey: "supabase-rls-off",
    source: { kind: "agent", agent: "codex" },
    evidence: { commit: COMMIT }
  });
  assert.equal(agentFinding.status, "suspected");

  const outcome = stubbedSweep(state, ok({ status: 0 }));
  assert.equal(outcome.rows[0].outcome, "clean");
  assert.equal(outcome.rows[0].findingId, null);

  // The sweep disagreed with the agent. Counting it as a confirmation would
  // have given the finding two source kinds and confirmed it.
  const reread = getFinding(project, agentFinding.id);
  assert.equal(reread.confirmations.length, 1);
  assert.equal(reread.status, "suspected");
});

test("an unregistered required service is skipped without running the check", () => {
  const { state, project } = setup();
  mechanicalPattern(state, { appliesTo: { requires: ["supabase"] } });
  let ran = false;
  const outcome = runSweep(state, {
    runner: () => { ran = true; return ok({ status: 1 }); },
    worktreeResolver: () => ({ ok: true, cwd: "/tmp/musubu", commit: COMMIT })
  });

  assert.equal(ran, false);
  assert.equal(outcome.rows[0].outcome, "skipped");
  assert.match(outcome.rows[0].reason, /service unregistered: supabase/);
  assert.equal(findSweep(project, "supabase-rls-off"), null);
  assert.equal(listFindings(project, {}).length, 0);
});

test("a service recorded as unused is skipped and stays n/a in the matrix", () => {
  const { state, project } = setup({ supabase: SERVICE_UNUSED });
  mechanicalPattern(state, { appliesTo: { requires: ["supabase"] } });
  const outcome = stubbedSweep(state, ok({ status: 1 }));

  assert.equal(outcome.rows[0].outcome, "skipped");
  assert.equal(listFindings(project, {}).length, 0);
  assert.equal(buildFindingsMatrix(state).rows[0].cells[0].cell, "n/a");
});

test("a dirty or missing worktree is an error that answers nothing", () => {
  const { state, project } = setup();
  mechanicalPattern(state);
  let ran = false;
  const outcome = runSweep(state, {
    runner: () => { ran = true; return ok({ status: 1 }); },
    worktreeResolver: () => ({ ok: false, reason: "worktree has 3 uncommitted change(s); a result cannot be bound to 0123456789ab" })
  });

  assert.equal(ran, false);
  assert.equal(outcome.rows[0].outcome, "error");
  assert.equal(outcome.rows[0].findingId, null);
  assert.equal(listFindings(project, {}).length, 0);
  // The cell stays unknown: a check that could not run is not a clean result.
  assert.equal(buildFindingsMatrix(state).rows[0].cells[0].cell, "unknown");
  assert.match(buildFindingsMatrix(state).rows[0].cells[0].reason, /sweep error: worktree has 3/);
});

test("a completed clean run turns the matrix cell from unknown into clean", () => {
  const { state } = setup();
  mechanicalPattern(state);
  assert.equal(buildFindingsMatrix(state).rows[0].cells[0].cell, "unknown");

  stubbedSweep(state, ok({ status: 0 }));
  const cell = buildFindingsMatrix(state).rows[0].cells[0];
  assert.equal(cell.cell, "clean");
  assert.match(cell.reason, /swept .* @ 0123456789ab/);
});

test("one sweep record per pattern per project, replaced by the next run", () => {
  const { state, project } = setup();
  mechanicalPattern(state);
  stubbedSweep(state, ok({ status: 0 }));
  stubbedSweep(state, ok({ status: 1 }));

  assert.equal(project.sweeps.length, 1);
  assert.equal(findSweep(project, "supabase-rls-off").outcome, "reproduced");
});

test("a dry run reports the reproduction and writes nothing", () => {
  const { state, project } = setup();
  mechanicalPattern(state);
  const outcome = stubbedSweep(state, ok({ status: 1, stdout: "disabled" }), { dryRun: true });

  assert.equal(outcome.dryRun, true);
  assert.equal(outcome.rows[0].outcome, "reproduced");
  assert.equal(outcome.rows[0].recorded, false);
  assert.equal(listFindings(project, {}).length, 0);
  assert.equal(project.sweeps.length, 0);
  assert.match(formatSweepRun(outcome), /DRY RUN/);
});

test("a judgment pattern has no check and is refused by name, skipped in bulk", () => {
  const { state } = setup();
  addPattern(state, {
    key: "unchecked-webhook-origin",
    title: "Webhook handler does not verify its sender",
    question: "Does every webhook handler verify the signature?",
    origin: "record"
  });

  assert.throws(
    () => runSweep(state, { patternKey: "unchecked-webhook-origin" }),
    /judgment question with no check to run/
  );
  const bulk = runSweep(state, {});
  assert.equal(bulk.patterns.length, 0);
  assert.equal(bulk.rows.length, 0);
  assert.match(formatSweepRun(bulk), /No mechanical pattern to sweep/);
});

test("--project narrows the sweep and an unknown project is refused", () => {
  const { state } = setup();
  state.projects.other = createProject({ id: "other", name: "Other", local: "/tmp/other" });
  mechanicalPattern(state);

  const outcome = stubbedSweep(state, ok({ status: 0 }), { projectIds: ["musubu"] });
  assert.deepEqual(outcome.rows.map((row) => row.projectId), ["musubu"]);
  assert.throws(() => runSweep(state, { projectIds: ["nope"] }), /Unknown project: nope/);
});

test("every mechanical pattern is swept in every project when none is named", () => {
  const { state } = setup();
  state.projects.other = createProject({ id: "other", name: "Other", local: "/tmp/other" });
  mechanicalPattern(state);
  mechanicalPattern(state, { key: "service-role-in-client", title: "Service role key reachable from the browser bundle" });

  const outcome = stubbedSweep(state, ok({ status: 0 }));
  assert.equal(outcome.rows.length, 4);
  assert.deepEqual(summarizeSweep(outcome), { reproduced: 0, clean: 4, error: 0, skipped: 0 });
});

test("resolveSweepWorktree refuses a dirty worktree and accepts a clean one", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-sweep-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "sweep@example.test");
    git("config", "user.name", "Sweep Test");
    fs.writeFileSync(path.join(root, "README.md"), "seed\n");
    git("add", "README.md");
    git("commit", "-qm", "seed");

    const clean = resolveSweepWorktree({ id: "t", local: root });
    assert.equal(clean.ok, true);
    assert.match(clean.commit, /^[0-9a-f]{40}$/);

    fs.writeFileSync(path.join(root, "README.md"), "changed\n");
    const dirty = resolveSweepWorktree({ id: "t", local: root });
    assert.equal(dirty.ok, false);
    assert.match(dirty.reason, /uncommitted change/);

    assert.equal(resolveSweepWorktree({ id: "t", local: null }).ok, false);
    assert.match(resolveSweepWorktree({ id: "t", local: path.join(root, "nope") }).reason, /local path not found/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
