import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createEmptyState, createProject } from "../src/domain.js";
import { addConfirmation, addFinding, addPattern, setFindingStatus } from "../src/findings.js";
import { mapPitfallRecord } from "../src/pattern-import.js";
import { exportFindingAsPitfall, serializePitfallRecord, writePitfallRecord } from "../src/pitfall-export.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SECRET = "sb_secret_DO_NOT_COPY_0123456789";

function setup() {
  const state = createEmptyState();
  const project = createProject({ id: "app", name: "APP", supabase: "app-prod" });
  state.projects[project.id] = project;
  const pattern = addPattern(state, {
    key: "rls-001",
    title: "A public table has RLS disabled",
    question: "Does every public table have row level security enabled?",
    summary: "The pattern summary.",
    origin: "record",
    severity: "medium",
    check: { argv: ["node", "scripts/check-rls.mjs"], cwd: "repo", timeoutMs: 30000, expect: "exit-zero" },
    appliesTo: { requires: ["supabase"] },
    source: { kind: "pitfall-record", id: "rls-001", digest: "d".repeat(64), confidence: "measured" }
  });
  return { state, project, pattern };
}

function sweptFinding(state, project, { severity = "medium", detail = "salons has RLS disabled and anon can read every row" } = {}) {
  const finding = addFinding(state, project, {
    title: "salons is readable without RLS",
    patternKey: "rls-001",
    detail,
    severity,
    source: { kind: "sweep" },
    evidence: { commit: COMMIT, files: ["supabase/migrations/001.sql"], output: `found ${SECRET}`, checkedAt: "2026-10-27T03:00:00Z" },
    check: { satisfied: true, exitCode: 1, ranAt: "2026-10-27T03:00:00Z" }
  });
  return setFindingStatus(state, project, finding.id, "confirmed");
}

test("a fixed finding a sweep reproduced becomes a measured, closed record that pattern import accepts", () => {
  const { state, project } = setup();
  const finding = sweptFinding(state, project);
  finding.status = "fixed";
  finding.fixedBy = { sessionId: "S001", pr: 42, mergeCommit: "f".repeat(40) };

  const { record, notes } = exportFindingAsPitfall(state, project, finding.id, { id: "rls-005" });
  assert.equal(record.id, "rls-005");
  assert.equal(record.layer, "app");
  assert.equal(record.kind, "trap");
  assert.equal(record.origin, "record");
  assert.equal(record.confidence, "measured");
  assert.equal(record.measured_on, "2026-10-27");
  assert.ok(Object.values(record.environment).every((value) => value === "unrecorded"), "never guess an environment");
  assert.equal(record.status, "closed");
  assert.match(record.fix, /PR #42 \(merge commit ffffffffffff\)/);
  assert.equal(record.why_not_closed, undefined);
  assert.deepEqual(record.related, ["rls-001"]);
  assert.deepEqual(record.tags, ["sumi", "supabase"]);
  assert.match(record.repro[0], /node scripts\/check-rls\.mjs/);
  assert.match(record.repro.join("\n"), /At commit 0123456789ab/);
  assert.doesNotMatch(serializePitfallRecord(record), new RegExp(SECRET), "check output is never copied");
  assert.ok(notes.some((note) => /Say what the change did|actually did/.test(note)));
  assert.ok(mapPitfallRecord(record, { file: "rls-005.json" }).candidate, "round-trips through pattern import");
});

test("an open finding needs --open-ok and a reason, and is refused at high severity", () => {
  const { state, project } = setup();
  const finding = sweptFinding(state, project);
  assert.throws(() => exportFindingAsPitfall(state, project, finding.id, { id: "rls-005" }), /still open\. Pass --open-ok/);
  assert.throws(() => exportFindingAsPitfall(state, project, finding.id, { id: "rls-005", openOk: true }), /needs --why-not-closed/);
  const { record } = exportFindingAsPitfall(state, project, finding.id, { id: "rls-005", openOk: true, whyNotClosed: "waiting for the migration window" });
  assert.equal(record.status, "open_recorded");
  assert.equal(record.why_not_closed, "waiting for the migration window");
  assert.equal(record.fix, undefined);

  const high = sweptFinding(state, project, { severity: "high" });
  assert.throws(
    () => exportFindingAsPitfall(state, project, high.id, { id: "rls-006", openOk: true, whyNotClosed: "x" }),
    /open and high severity\. Close it first/
  );
});

test("only confirmed or fixed findings export, with a valid id and a title that fits", () => {
  const { state, project } = setup();
  const suspected = addFinding(state, project, {
    title: "maybe", patternKey: "rls-001", detail: "d", source: { kind: "agent" },
    evidence: { commit: COMMIT, files: [], output: "", checkedAt: "2026-10-27T03:00:00Z" }
  });
  assert.throws(() => exportFindingAsPitfall(state, project, suspected.id, { id: "rls-005" }), /only a confirmed or fixed finding/);
  const finding = sweptFinding(state, project);
  finding.status = "fixed";
  assert.throws(() => exportFindingAsPitfall(state, project, finding.id, { id: "RLS-5" }), /--id must be a pitfall record id/);
  assert.throws(() => exportFindingAsPitfall(state, project, finding.id, { id: "rls-005", title: "x".repeat(101) }), /records allow 100/);
});

test("corroboration by two kinds of source is exported as unverified, without measured fields", () => {
  const state = createEmptyState();
  const project = createProject({ id: "app", name: "APP" });
  state.projects.app = project;
  addPattern(state, { key: "webhook-origin", title: "Webhook trusts its body", question: "q?", origin: "record", severity: "medium" });
  const finding = addFinding(state, project, {
    title: "webhook trusts unsigned payloads", patternKey: "webhook-origin", detail: "handler acts before verifying",
    source: { kind: "agent" }, evidence: { commit: COMMIT, files: ["api/hook.ts"], output: "", checkedAt: "2026-10-27T03:00:00Z" }
  });
  addConfirmation(state, project, finding.id, { source: { kind: "human" }, evidence: { commit: COMMIT, files: [], output: "", checkedAt: "2026-10-27T04:00:00Z" } });
  setFindingStatus(state, project, finding.id, "confirmed");
  finding.status = "fixed";
  const { record, notes } = exportFindingAsPitfall(state, project, finding.id, { id: "authz-002" });
  assert.equal(record.confidence, "unverified");
  for (const field of ["measured_on", "environment", "repro"]) assert.equal(record[field], undefined);
  assert.equal(record.related, undefined, "the pattern did not come from a record");
  assert.ok(notes.some((note) => /not a measurement/.test(note)));
});

test("writing never overwrites, and the file is named after the id", () => {
  const { state, project } = setup();
  const finding = sweptFinding(state, project);
  finding.status = "fixed";
  const { record } = exportFindingAsPitfall(state, project, finding.id, { id: "rls-005" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-pitfall-"));
  try {
    const file = writePitfallRecord(record, dir);
    assert.equal(path.basename(file), "rls-005.json");
    const raw = fs.readFileSync(file);
    assert.notEqual(raw[0], 0xef, "no BOM");
    assert.ok(raw.toString("utf8").endsWith("}\n"));
    assert.throws(() => writePitfallRecord(record, dir), /EEXIST/);
    assert.throws(() => writePitfallRecord(record, path.join(dir, "other.json")), /must be named rls-005\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sumi finding export prints the draft on stdout and notes on stderr", () => {
  const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-export-cli-"));
  const statePath = path.join(root, "state.json");
  const sumi = (...args) => spawnSync(process.execPath, [cliPath, "--data", statePath, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  try {
    assert.equal(sumi("init").status, 0);
    const { state, project } = setup();
    const finding = sweptFinding(state, project);
    finding.status = "fixed";
    const stored = JSON.parse(fs.readFileSync(statePath, "utf8"));
    stored.projects = state.projects;
    stored.patterns = state.patterns;
    fs.writeFileSync(statePath, JSON.stringify(stored));

    const printed = sumi("finding", "export", "app", finding.id, "--id", "rls-005");
    assert.equal(printed.status, 0, printed.stderr);
    assert.equal(JSON.parse(printed.stdout).id, "rls-005");
    assert.match(printed.stderr, /^note: /m);

    const out = path.join(root, "drafts");
    assert.equal(sumi("finding", "export", "app", finding.id, "--id", "rls-005", "--out", out).status, 0);
    assert.ok(fs.existsSync(path.join(out, "rls-005.json")));
    const again = sumi("finding", "export", "app", finding.id, "--id", "rls-005", "--out", out);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already exists; SUMI does not overwrite/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
