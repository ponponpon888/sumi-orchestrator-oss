import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createEmptyState, createProject, SERVICE_UNUSED } from "../src/domain.js";
import { loadState, saveState } from "../src/store.js";
import {
  addFinding, addPattern, buildFindingsMatrix, findSweep, formatFindingsMatrix, getFinding, listFindings, setFindingStatus, setPattern
} from "../src/findings.js";
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

test("configured error exit codes never create findings or confirmations in any expectation mode", () => {
  for (const expect of ["exit-zero", "exit-nonzero", "no-output"]) {
    const { state, project } = setup();
    const pattern = mechanicalPattern(state, {
      check: { argv: ["node", "check.mjs"], expect, errorExitCodes: [2] }
    });
    const outcome = stubbedSweep(state, ok({ status: 2, stderr: "cannot read target file" }));
    assert.equal(outcome.rows[0].outcome, "error", expect);
    assert.equal(outcome.rows[0].exitCode, 2);
    assert.match(outcome.rows[0].reason, /configured as an execution error/);
    assert.equal(listFindings(project, {}).length, 0);
    assert.equal(buildFindingsMatrix(state).rows[0].cells[0].cell, "unknown");

    const finding = addFinding(state, project, {
      title: pattern.title, patternKey: pattern.key, source: { kind: "agent" },
      evidence: { commit: COMMIT, output: "suspected issue" }
    });
    const before = finding.confirmations.length;
    stubbedSweep(state, ok({ status: 2, stdout: "failed to inspect target" }));
    assert.equal(finding.status, "suspected");
    assert.equal(finding.confirmations.length, before);
  }
});

test("detector exit codes distinguish matches, no matches and execution errors without changing legacy checks", () => {
  const check = { expect: "exit-nonzero", timeoutMs: 1000, errorExitCodes: [2] };
  assert.equal(evaluateCheckRun(check, ok({ status: 0 })).reproduced, true);
  assert.equal(evaluateCheckRun(check, ok({ status: 1 })).reproduced, false);
  assert.equal(evaluateCheckRun(check, ok({ status: 2 })).ran, false);
  // A stored pattern without the new opt-in policy keeps its original meaning.
  assert.equal(evaluateCheckRun({ expect: "exit-nonzero" }, ok({ status: 2 })).reproduced, false);
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

test("a dismissal survives the next sweep instead of being re-filed", () => {
  const { state, project } = setup();
  const pattern = mechanicalPattern(state);
  const first = stubbedSweep(state, ok({ status: 1 }));
  setFindingStatus(state, project, first.rows[0].findingId, "dismissed", {
    reason: "false positive: the check matches the pattern name inside a test title"
  });

  // The check still reproduces. That is exactly what the dismissal anticipated,
  // so it must not come back as a fresh confirmed finding on every run.
  const second = stubbedSweep(state, ok({ status: 1 }));
  assert.equal(second.rows[0].outcome, "suppressed");
  assert.equal(second.rows[0].findingId, first.rows[0].findingId);
  assert.equal(second.rows[0].status, "dismissed");
  assert.equal(listFindings(project, { patternKey: pattern.key }).length, 1);
  assert.equal(getFinding(project, first.rows[0].findingId).confirmations.length, 1);

  const third = stubbedSweep(state, ok({ status: 1 }));
  assert.equal(third.rows[0].outcome, "suppressed");
  assert.equal(listFindings(project, { patternKey: pattern.key }).length, 1);
  assert.equal(findSweep(project, pattern.key).outcome, "suppressed");
});

test("not_applicable suppresses the same way a dismissal does", () => {
  const { state, project } = setup({ supabase: SERVICE_UNUSED });
  const pattern = mechanicalPattern(state);
  const first = stubbedSweep(state, ok({ status: 1 }));
  setFindingStatus(state, project, first.rows[0].findingId, "not_applicable", {
    reason: "this project does not expose the affected surface"
  });

  const second = stubbedSweep(state, ok({ status: 1 }));
  assert.equal(second.rows[0].outcome, "suppressed");
  assert.equal(listFindings(project, { patternKey: pattern.key }).length, 1);
});

test("a reproduction after fixed is a regression and files a new finding", () => {
  const { state, project } = setup();
  const pattern = mechanicalPattern(state);
  const first = stubbedSweep(state, ok({ status: 1 }));
  // `fixed` is a judgment about the code; reproducing it again contradicts that.
  getFinding(project, first.rows[0].findingId).status = "fixed";

  const second = stubbedSweep(state, ok({ status: 1 }));
  assert.equal(second.rows[0].outcome, "reproduced");
  assert.notEqual(second.rows[0].findingId, first.rows[0].findingId);
  assert.equal(getFinding(project, second.rows[0].findingId).status, "confirmed");
  assert.equal(listFindings(project, { patternKey: pattern.key }).length, 2);
});

test("an open finding still wins over a dismissed one for the same pattern", () => {
  const { state, project } = setup();
  const pattern = mechanicalPattern(state);
  const first = stubbedSweep(state, ok({ status: 1 }));
  setFindingStatus(state, project, first.rows[0].findingId, "dismissed", { reason: "not this one" });
  const open = addFinding(state, project, {
    title: "a human found it for real",
    patternKey: pattern.key,
    source: { kind: "human" },
    evidence: { commit: COMMIT }
  });

  const second = stubbedSweep(state, ok({ status: 1 }));
  assert.equal(second.rows[0].outcome, "reproduced");
  assert.equal(second.rows[0].findingId, open.id);
  assert.equal(getFinding(project, open.id).status, "confirmed");
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

test("changing a check cannot reuse its previous clean result and rerunning restores evidence", () => {
  const { state, project } = setup();
  const pattern = mechanicalPattern(state);
  stubbedSweep(state, ok());
  const previous = structuredClone(findSweep(project, pattern.key));

  setPattern(state, pattern.key, { check: { ...pattern.check, argv: ["node", "different-check.mjs"] } });
  const outdated = buildFindingsMatrix(state).rows[0].cells[0];
  assert.equal(outdated.cell, "unknown");
  assert.match(outdated.reason, /definition changed.*rerun/i);
  assert.deepEqual(findSweep(project, pattern.key), previous);

  stubbedSweep(state, ok());
  assert.equal(buildFindingsMatrix(state).rows[0].cells[0].cell, "clean");
});

test("a new error exit policy cannot inherit clean from the old detector policy", () => {
  const { state } = setup();
  const pattern = mechanicalPattern(state, { check: { argv: ["grep", "needle", "target.txt"], expect: "exit-nonzero" } });
  stubbedSweep(state, ok({ status: 2 }));
  assert.equal(buildFindingsMatrix(state).rows[0].cells[0].cell, "clean");
  setPattern(state, pattern.key, { check: { ...pattern.check, errorExitCodes: [2] } });
  assert.equal(buildFindingsMatrix(state).rows[0].cells[0].cell, "unknown");
  assert.equal(stubbedSweep(state, ok({ status: 2 })).rows[0].outcome, "error");
});

test("changing required services invalidates clean but label edits keep it", () => {
  const { state, project } = setup({ vercel: "fixture" });
  const pattern = mechanicalPattern(state);
  stubbedSweep(state, ok());
  setPattern(state, pattern.key, { title: "Updated display title", severity: "low" });
  assert.equal(buildFindingsMatrix(state).rows[0].cells[0].cell, "clean");
  setPattern(state, pattern.key, { appliesTo: { requires: ["vercel"] } });
  assert.equal(buildFindingsMatrix(state).rows[0].cells[0].cell, "unknown");
  assert.equal(findSweep(project, pattern.key).outcome, "clean");
});

test("legacy sweep records stay readable but need a rerun before asserting clean", () => {
  const { state, project } = setup();
  const pattern = mechanicalPattern(state);
  project.sweeps.push({ patternKey: pattern.key, outcome: "clean", commit: COMMIT, ranAt: "2026-10-01T00:00:00.000Z" });
  const cell = buildFindingsMatrix(state).rows[0].cells[0];
  assert.equal(cell.cell, "unknown");
  assert.match(cell.reason, /definition.*not recorded.*rerun/i);
  assert.equal(project.sweeps[0].outcome, "clean");
});

test("equivalent check defaults and service ordering retain valid clean evidence", () => {
  const { state } = setup({ vercel: "fixture", supabase: "fixture" });
  const pattern = mechanicalPattern(state, {
    check: { argv: ["node", "check.mjs"] },
    appliesTo: { requires: ["vercel", "supabase"] }
  });
  stubbedSweep(state, ok());
  setPattern(state, pattern.key, {
    check: { argv: ["node", "check.mjs"], cwd: "repo", timeoutMs: 60000, expect: "exit-zero", errorExitCodes: [] },
    appliesTo: { requires: ["supabase", "vercel", "supabase"] }
  });
  assert.equal(buildFindingsMatrix(state).rows[0].cells[0].cell, "clean");
});

test("clean definition evidence survives saving and reloading schema 3", (t) => {
  const { state } = setup();
  mechanicalPattern(state);
  stubbedSweep(state, ok());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-sweep-definition-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");
  saveState(state, file);
  const reloaded = loadState(file);
  assert.equal(reloaded.schemaVersion, 3);
  assert.equal(reloaded.migratedFrom, undefined);
  assert.equal(buildFindingsMatrix(reloaded).rows[0].cells[0].cell, "clean");
});

test("a check changed to a judgment question asks for review instead of an impossible sweep", () => {
  const { state } = setup();
  const pattern = mechanicalPattern(state);
  stubbedSweep(state, ok());
  setPattern(state, pattern.key, { check: null });
  const matrix = buildFindingsMatrix(state);
  assert.equal(matrix.rows[0].cells[0].cell, "unknown");
  const output = formatFindingsMatrix(matrix);
  assert.match(output, /RECHECK REQUIRED/);
  assert.match(output, /judgment question/);
  assert.match(output, /sumi pattern show supabase-rls-off/);
  assert.doesNotMatch(output, /sumi sweep supabase-rls-off/);
});

test("a past clean sweep cannot answer a service that is now unregistered", () => {
  const { state, project } = setup({ supabase: "musubu-prod" });
  mechanicalPattern(state, { appliesTo: { requires: ["supabase"] } });
  stubbedSweep(state, ok());
  assert.equal(buildFindingsMatrix(state).rows[0].cells[0].cell, "clean");

  project.supabase = null;
  const skipped = stubbedSweep(state, ok());
  assert.equal(skipped.rows[0].outcome, "skipped");
  // Skipping preserves the old evidence, but it cannot answer today's setup gap.
  assert.equal(findSweep(project, "supabase-rls-off").outcome, "clean");
  const unknown = buildFindingsMatrix(state).rows[0].cells[0];
  assert.equal(unknown.cell, "unknown");
  assert.equal(unknown.reason, "service unregistered: supabase");

  project.supabase = SERVICE_UNUSED;
  assert.equal(buildFindingsMatrix(state).rows[0].cells[0].cell, "n/a");
});

test("a past error sweep does not hide a currently unregistered service", () => {
  const { state, project } = setup({ supabase: "musubu-prod" });
  mechanicalPattern(state, { appliesTo: { requires: ["supabase"] } });
  stubbedSweep(state, ok({ status: null, error: "spawn ENOENT" }));
  project.supabase = null;
  const cell = buildFindingsMatrix(state).rows[0].cells[0];
  assert.equal(cell.cell, "unknown");
  assert.equal(cell.reason, "service unregistered: supabase");
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
  assert.deepEqual(summarizeSweep(outcome), { reproduced: 0, suppressed: 0, clean: 4, error: 0, skipped: 0 });
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
