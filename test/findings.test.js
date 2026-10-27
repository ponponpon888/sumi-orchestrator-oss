import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmptyState, createProject, SERVICE_UNUSED, setScopeCriterionStatus } from "../src/domain.js";
import { loadState, saveState } from "../src/store.js";
import {
  addConfirmation,
  addFinding,
  addPattern,
  buildFindingsMatrix,
  EVIDENCE_OUTPUT_LIMIT,
  getConfirmationBasis,
  getFinding,
  getPattern,
  getPatternApplicability,
  listFindings,
  normalizeCheck,
  normalizeOrigin,
  promoteFinding,
  removePattern,
  setFindingStatus,
  setPattern
} from "../src/findings.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function setup(projectPatch = {}) {
  const state = createEmptyState();
  const project = Object.assign(createProject({ id: "musubu", name: "MUSUBU" }), projectPatch);
  state.projects[project.id] = project;
  return { state, project };
}

function evidence(overrides = {}) {
  return { commit: COMMIT, files: ["src/api.ts"], output: "row level security disabled", ...overrides };
}

function judgmentPattern(state, overrides = {}) {
  return addPattern(state, {
    key: "unchecked-webhook-origin",
    title: "Webhook handler does not verify its sender",
    question: "Does every webhook handler verify the signature before acting?",
    origin: "record",
    severity: "high",
    ...overrides
  });
}

function mechanicalPattern(state, overrides = {}) {
  return addPattern(state, {
    key: "supabase-rls-off",
    title: "A public table has RLS disabled",
    question: "Does every public table have row level security enabled?",
    origin: "docs/DESIGN-v0.1.md#rls",
    severity: "high",
    check: { argv: ["node", "scripts/check-rls.mjs"], cwd: "repo", timeoutMs: 30000, expect: "exit-zero" },
    appliesTo: { requires: ["supabase"] },
    ...overrides
  });
}

function suspect(state, project, patternKey, source = { kind: "agent", agent: "claude-code" }, extra = {}) {
  return addFinding(state, project, {
    title: "Stripe webhook accepts unsigned payloads",
    patternKey,
    detail: "handler trusts the body before verifying the signature",
    source,
    evidence: evidence(),
    ...extra
  });
}

function stateFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-findings-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "state.json");
}

// ---------------------------------------------------------------- patterns

test("a pattern with a check is mechanical and one without is judgment", () => {
  const { state } = setup();
  assert.equal(mechanicalPattern(state).kind, "mechanical");
  assert.equal(judgmentPattern(state).kind, "judgment");
  assert.equal(getPattern(state, "supabase-rls-off").id, "P001");
  assert.equal(getPattern(state, "P002").key, "unchecked-webhook-origin");
});

test("explicit error exit codes survive saving schema 3 and can be cleared", (t) => {
  const { state } = setup();
  const pattern = mechanicalPattern(state, {
    check: { argv: ["grep", "needle", "target.txt"], expect: "exit-nonzero", errorExitCodes: [2] }
  });
  const file = stateFile(t);
  saveState(state, file);
  const reloaded = loadState(file);
  assert.equal(reloaded.schemaVersion, 3);
  assert.equal(reloaded.migratedFrom, undefined);
  assert.deepEqual(getPattern(reloaded, pattern.key).check.errorExitCodes, [2]);

  setPattern(reloaded, pattern.key, { check: { ...pattern.check, errorExitCodes: [] } });
  saveState(reloaded, file);
  assert.equal(getPattern(loadState(file), pattern.key).check.errorExitCodes, undefined);
});

test("error exit code policy rejects malformed values and keeps legacy checks unchanged", () => {
  const legacy = normalizeCheck({ argv: ["node", "check.mjs"] });
  assert.equal(Object.hasOwn(legacy, "errorExitCodes"), false);
  for (const errorExitCodes of ["2", ["2"], [0], [-1], [256], [1.5], [NaN], [null]]) {
    assert.throws(() => normalizeCheck({ ...legacy, errorExitCodes }), /errorExitCodes must be an array of integers/);
  }
  assert.deepEqual(normalizeCheck({ ...legacy, errorExitCodes: [255, 2, 2] }).errorExitCodes, [2, 255]);
});

test("only the three documented origin forms are accepted", () => {
  assert.equal(normalizeOrigin("musubu:F001"), "musubu:F001");
  assert.equal(normalizeOrigin("record"), "record");
  assert.equal(normalizeOrigin("docs/DESIGN-v0.1.md#rls"), "docs/DESIGN-v0.1.md#rls");
  assert.throws(() => normalizeOrigin("a hunch"), /Invalid pattern origin/);
  assert.throws(() => normalizeOrigin("musubu:001"), /Invalid pattern origin/);
  assert.throws(() => normalizeOrigin(""), /Pattern origin is required/);
});

test("an unknown service name in appliesTo.requires is refused instead of staying unknown forever", () => {
  const { state } = setup();
  assert.throws(
    () => judgmentPattern(state, { appliesTo: { requires: ["supabse"] } }),
    /Unknown service in appliesTo.requires: supabse/
  );
  const ok = judgmentPattern(state, { appliesTo: { requires: ["supabase", "vercel"] } });
  assert.deepEqual(ok.appliesTo.requires, ["supabase", "vercel"]);
});

test("a pattern key is stable and a duplicate key is refused", () => {
  const { state } = setup();
  mechanicalPattern(state);
  assert.throws(() => mechanicalPattern(state), /Pattern key already exists/);
  assert.throws(() => setPattern(state, "supabase-rls-off", { key: "renamed" }), /stable slug/);
  assert.throws(() => addPattern(state, { key: "Bad Key", title: "t", question: "q", origin: "record" }), /lowercase letters, digits and hyphens/);
});

test("a pattern still referenced by a finding cannot be removed", () => {
  const { state, project } = setup();
  judgmentPattern(state);
  const finding = suspect(state, project, "unchecked-webhook-origin");
  assert.throws(
    () => removePattern(state, "unchecked-webhook-origin"),
    new RegExp(`still referenced by 1 finding\\(s\\): musubu:${finding.id}`)
  );

  const unused = addPattern(state, { key: "orphan-pattern", title: "t", question: "q", origin: "record" });
  assert.equal(removePattern(state, "orphan-pattern").id, unused.id);
  assert.equal(state.patterns.length, 1);
});

// ------------------------------------------------------------ R1 confirmed

test("a finding starts suspected and an agent self-report alone cannot raise it", () => {
  const { state, project } = setup();
  judgmentPattern(state);
  const finding = suspect(state, project, "unchecked-webhook-origin");
  assert.equal(finding.status, "suspected");
  assert.equal(getConfirmationBasis(finding, null).ok, false);
  assert.throws(
    () => setFindingStatus(state, project, finding.id, "confirmed"),
    /Cannot confirm F001: Only agent source kind\(s\) reported this/
  );
  assert.equal(getFinding(project, finding.id).status, "suspected");
});

test("two confirmations of the same source kind are still one voice", () => {
  const { state, project } = setup();
  judgmentPattern(state);
  const finding = suspect(state, project, "unchecked-webhook-origin");
  addConfirmation(state, project, finding.id, {
    source: { kind: "agent", agent: "codex" },
    evidence: evidence({ commit: "f".repeat(40) })
  });
  assert.equal(finding.confirmations.length, 2);
  assert.throws(
    () => setFindingStatus(state, project, finding.id, "confirmed"),
    /different source kind/
  );
  assert.equal(finding.status, "suspected");
});

test("two different source kinds confirm a finding", () => {
  const { state, project } = setup();
  judgmentPattern(state);
  const finding = suspect(state, project, "unchecked-webhook-origin");
  const confirmed = setFindingStatus(state, project, finding.id, "confirmed", {
    confirmation: { source: { kind: "human" }, evidence: evidence({ commit: "f".repeat(40) }) }
  });
  assert.equal(confirmed.status, "confirmed");
  assert.equal(getConfirmationBasis(confirmed, null).basis, "independent-sources");
});

test("a check result only counts when the sweep itself produced it", () => {
  const { state, project } = setup({ supabase: "musubu-prod" });
  const pattern = mechanicalPattern(state);
  const handWritten = suspect(state, project, pattern.key, { kind: "human" }, {
    check: { satisfied: true, exitCode: 1 }
  });
  assert.equal(handWritten.confirmations[0].check.satisfied, true);
  assert.throws(
    () => setFindingStatus(state, project, handWritten.id, "confirmed"),
    /record a check run reproduced by a sweep/
  );
  assert.equal(handWritten.status, "suspected");

  const swept = suspect(state, project, pattern.key, { kind: "sweep" }, {
    check: { satisfied: true, exitCode: 1 }
  });
  const confirmed = setFindingStatus(state, project, swept.id, "confirmed");
  assert.equal(confirmed.status, "confirmed");
  assert.equal(getConfirmationBasis(confirmed, pattern).basis, "mechanical-check");
});

test("a check run cannot be attached to a judgment pattern", () => {
  const { state, project } = setup();
  judgmentPattern(state);
  assert.throws(
    () => suspect(state, project, "unchecked-webhook-origin", { kind: "sweep" }, { check: { satisfied: true } }),
    /only be recorded against a mechanical pattern/
  );
});

// --------------------------------------------------------------- R2 reason

test("not_applicable and dismissed both require a non-empty reason", () => {
  const { state, project } = setup();
  judgmentPattern(state);
  const finding = suspect(state, project, "unchecked-webhook-origin");
  assert.throws(() => setFindingStatus(state, project, finding.id, "dismissed"), /Reason for dismissed is required/);
  assert.throws(() => setFindingStatus(state, project, finding.id, "dismissed", { reason: "" }), /Reason for dismissed is required/);
  assert.throws(() => setFindingStatus(state, project, finding.id, "dismissed", { reason: "   " }), /Reason for dismissed is required/);
  assert.equal(finding.status, "suspected");

  const dismissed = setFindingStatus(state, project, finding.id, "dismissed", { reason: "handler is behind an internal-only gateway" });
  assert.equal(dismissed.status, "dismissed");
  assert.equal(dismissed.reason, "handler is behind an internal-only gateway");
});

// ---------------------------------------------------------- R7 applicability

test("an unregistered service stays unknown and cannot be called not applicable", () => {
  const { state, project } = setup();
  const pattern = mechanicalPattern(state);
  assert.equal(getPatternApplicability(project, pattern).applicable, "unknown");
  const finding = suspect(state, project, pattern.key);
  assert.throws(
    () => setFindingStatus(state, project, finding.id, "not_applicable", { reason: "service unused" }),
    /service unregistered: supabase/
  );
  assert.equal(finding.status, "suspected");
});

test("a service explicitly recorded as unused makes the pattern not applicable", () => {
  const { state, project } = setup({ supabase: SERVICE_UNUSED });
  const pattern = mechanicalPattern(state);
  assert.deepEqual(getPatternApplicability(project, pattern), { applicable: "no", reason: "service unused: supabase" });
  const finding = suspect(state, project, pattern.key);
  const marked = setFindingStatus(state, project, finding.id, "not_applicable", { reason: "service unused" });
  assert.equal(marked.status, "not_applicable");
  assert.equal(marked.reason, "service unused");
});

test("a registered service leaves the pattern applicable", () => {
  const { state, project } = setup({ supabase: "musubu-prod" });
  assert.deepEqual(getPatternApplicability(project, mechanicalPattern(state)), { applicable: "yes", reason: null });
  assert.deepEqual(getPatternApplicability(project, judgmentPattern(state)), { applicable: "yes", reason: null });
});

// --------------------------------------------------------------- R3 promote

test("a suspected finding cannot be promoted", () => {
  const { state, project } = setup();
  judgmentPattern(state);
  const finding = suspect(state, project, "unchecked-webhook-origin");
  assert.throws(() => promoteFinding(state, project, finding.id), /only a confirmed finding can be promoted \(it is suspected\)/);
  assert.equal(project.scope.criteria.length, 0);
  assert.equal(finding.scopeId, null);
});

test("promoting a confirmed finding creates exactly one linked scope criterion", () => {
  const { state, project } = setup();
  judgmentPattern(state);
  const finding = suspect(state, project, "unchecked-webhook-origin");
  setFindingStatus(state, project, finding.id, "confirmed", {
    confirmation: { source: { kind: "human" }, evidence: evidence({ commit: "f".repeat(40) }) }
  });
  const { criterion } = promoteFinding(state, project, finding.id);
  assert.equal(project.scope.criteria.length, 1);
  assert.equal(criterion.status, "todo");
  assert.ok(criterion.text.includes(finding.id));
  assert.ok(criterion.text.includes("unchecked-webhook-origin"));
  assert.equal(finding.scopeId, criterion.id);
  assert.throws(() => promoteFinding(state, project, finding.id), /already promoted to C001/);
  assert.equal(project.scope.criteria.length, 1);
});

// ----------------------------------------------------------------- R4 fixed

function promoted(state, project) {
  judgmentPattern(state);
  const finding = suspect(state, project, "unchecked-webhook-origin");
  setFindingStatus(state, project, finding.id, "confirmed", {
    confirmation: { source: { kind: "human" }, evidence: evidence({ commit: "f".repeat(40) }) }
  });
  return promoteFinding(state, project, finding.id);
}

test("fixed is refused without promotion, without a done criterion, and without delivery evidence", () => {
  const { state, project } = setup();
  judgmentPattern(state);
  const unpromoted = suspect(state, project, "unchecked-webhook-origin");
  assert.throws(() => setFindingStatus(state, project, unpromoted.id, "fixed"), /has not been promoted/);

  const fresh = setup();
  const { finding, criterion } = promoted(fresh.state, fresh.project);
  assert.throws(() => setFindingStatus(fresh.state, fresh.project, finding.id, "fixed"), /is todo, not done/);

  setScopeCriterionStatus(fresh.project, criterion.id, "done");
  assert.throws(() => setFindingStatus(fresh.state, fresh.project, finding.id, "fixed"), /no session on C001 has a delivery merge commit/);
  assert.equal(finding.status, "confirmed");
  assert.equal(finding.fixedBy, null);
});

test("a session whose delivery evidence carries a merge commit is what makes a finding fixed", () => {
  const { state, project } = setup();
  const { finding, criterion } = promoted(state, project);
  setScopeCriterionStatus(project, criterion.id, "done");
  // The shape delivery.js writes onto a session after a certified PR is merged.
  project.sessions.push({
    id: "S001",
    scopeId: criterion.id,
    status: "completed",
    deliveryEvidence: { ok: true, pr: { number: 42, state: "MERGED", mergeCommit: "d".repeat(40) } }
  });
  const fixed = setFindingStatus(state, project, finding.id, "fixed");
  assert.equal(fixed.status, "fixed");
  assert.deepEqual(fixed.fixedBy, { sessionId: "S001", pr: 42, mergeCommit: "d".repeat(40) });
});

test("delivery evidence without a merge commit does not make a finding fixed", () => {
  const { state, project } = setup();
  const { finding, criterion } = promoted(state, project);
  setScopeCriterionStatus(project, criterion.id, "done");
  project.sessions.push({
    id: "S001",
    scopeId: criterion.id,
    deliveryEvidence: { ok: true, pr: { number: 42, state: "OPEN", mergeCommit: null } }
  });
  assert.throws(() => setFindingStatus(state, project, finding.id, "fixed"), /no session on C001 has a delivery merge commit/);
  assert.equal(finding.status, "confirmed");
});

// -------------------------------------------------------------- evidence

test("evidence needs a commit and long output is truncated in place, never dropped", () => {
  const { state, project } = setup();
  judgmentPattern(state);
  assert.throws(
    () => addFinding(state, project, { title: "t", source: { kind: "human" }, evidence: { files: [] } }),
    /Finding evidence commit is required/
  );

  const long = "x".repeat(EVIDENCE_OUTPUT_LIMIT + 500);
  const finding = suspect(state, project, "unchecked-webhook-origin", { kind: "human" }, { evidence: evidence({ output: long }) });
  assert.equal(finding.evidence.output.length, EVIDENCE_OUTPUT_LIMIT);
  assert.equal(finding.evidence.truncated, true);
  assert.ok(finding.evidence.checkedAt);

  const short = suspect(state, project, "unchecked-webhook-origin", { kind: "human" });
  assert.equal(short.evidence.truncated, undefined);
});

test("a finding inherits its pattern severity unless it is given one", () => {
  const { state, project } = setup();
  judgmentPattern(state);
  assert.equal(suspect(state, project, "unchecked-webhook-origin").severity, "high");
  assert.equal(suspect(state, project, "unchecked-webhook-origin", { kind: "human" }, { severity: "low" }).severity, "low");
  assert.equal(listFindings(project, { patternKey: "unchecked-webhook-origin" }).length, 2);
});

// ----------------------------------------------------------------- matrix

test("the matrix shows unknown for unregistered, n/a for unused, and counts every finding", () => {
  const state = createEmptyState();
  const pattern = mechanicalPattern(state);
  for (const [id, supabase] of [["a-unused", SERVICE_UNUSED], ["b-unregistered", null], ["c-registered", "c-prod"]]) {
    state.projects[id] = Object.assign(createProject({ id, name: id }), { supabase });
  }
  const loud = state.projects["c-registered"];
  const first = suspect(state, loud, pattern.key, { kind: "sweep" }, { check: { satisfied: true, exitCode: 1 } });
  setFindingStatus(state, loud, first.id, "confirmed");
  const { criterion } = promoteFinding(state, loud, first.id);
  setScopeCriterionStatus(loud, criterion.id, "done");
  loud.sessions.push({ id: "S001", scopeId: criterion.id, deliveryEvidence: { pr: { number: 7, mergeCommit: "e".repeat(40) } } });
  setFindingStatus(state, loud, first.id, "fixed");
  suspect(state, loud, pattern.key, { kind: "sweep" });

  const matrix = buildFindingsMatrix(state);
  const cells = Object.fromEntries(matrix.rows[0].cells.map((cell) => [cell.projectId, cell]));
  assert.equal(cells["a-unused"].cell, "n/a");
  assert.equal(cells["b-unregistered"].cell, "unknown");
  assert.equal(cells["b-unregistered"].reason, "service unregistered: supabase");
  // The loudest status wins the cell, but the count keeps the other one visible.
  assert.equal(cells["c-registered"].cell, "suspected (2)");
  assert.deepEqual(cells["c-registered"].counts, { fixed: 1, suspected: 1 });
  assert.equal(matrix.rows[0].cells.every((cell) => cell.cell), true);
});

// ----------------------------------------------------------------- schema

test("schema v2 state migrates to v3, gains a pattern ledger and backfilled findings, and leaves a backup", (t) => {
  const file = stateFile(t);
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 2,
    revision: 4,
    projects: {
      legacy: {
        id: "legacy",
        name: "Legacy",
        findings: [{
          id: "F001",
          title: "written before confirmations existed",
          status: "suspected",
          source: { kind: "human" },
          evidence: { commit: COMMIT, files: [], output: "", checkedAt: "2026-09-01T00:00:00.000Z" },
          createdAt: "2026-09-01T00:00:00.000Z"
        }]
      },
      bare: { id: "bare", name: "Bare" }
    }
  }), "utf8");

  const migrated = loadState(file);
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.migratedFrom, 2);
  assert.deepEqual(migrated.patterns, []);
  assert.deepEqual(migrated.projects.bare.findings, []);
  const backfilled = migrated.projects.legacy.findings[0];
  assert.equal(backfilled.confirmations.length, 1);
  assert.equal(backfilled.confirmations[0].source.kind, "human");
  assert.equal(backfilled.confirmations[0].evidence.commit, COMMIT);
  assert.equal(getConfirmationBasis(backfilled, null).ok, false);

  saveState(migrated, file);
  assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8")).schemaVersion, 2);
  const reloaded = loadState(file);
  assert.equal(reloaded.schemaVersion, 3);
  assert.equal(reloaded.migratedFrom, undefined);
  assert.equal(reloaded.projects.legacy.findings[0].confirmations.length, 1);
});
