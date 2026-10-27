import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmptyState } from "../src/domain.js";
import { addPattern, findPattern, formatPattern, getPatternFingerprint, setPattern } from "../src/findings.js";
import { resolveBundledInvocation } from "../src/bundled-checks.js";
import {
  applyPatternImport,
  builtinPatternCandidates,
  CHECKS_DIR,
  formatPatternImport,
  mapPitfallRecord,
  patternContentDigest,
  pitfallCandidatesFromPath,
  planPatternImport
} from "../src/pattern-import.js";

// Shaped like ai-workforce data/app-pitfalls/rls-001.json (schema_version 1).
function record(overrides = {}) {
  return {
    id: "rls-001",
    title: "RLS は行を守るが、列は守らない",
    summary: "ポリシーが行を絞っていても、列は絞らない。",
    layer: "app",
    kind: "trap",
    severity: "high",
    confidence: "inferred",
    origin: "docs/case-studies/hanami-nail.md#rls-は行を守るが列は守らない",
    inferred_from: ["docs/case-studies/hanami-nail.md#rls-は行を守るが列は守らない"],
    status: "closed",
    fix: "列レベルの GRANT で付け直した。",
    detection: { checkable: false, kind: "manual", note: "読む人のアプリの中にある。" },
    related: [],
    tags: ["supabase", "rls", "postgrest"],
    ...overrides
  };
}

function recordDir(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-pitfalls-"));
  for (const item of records) fs.writeFileSync(path.join(dir, `${item.id}.json`), JSON.stringify(item, null, 2), "utf8");
  fs.writeFileSync(path.join(dir, "_schema.json"), "{\"not\": \"a record\"}", "utf8");
  fs.writeFileSync(path.join(dir, "README.md"), "# not a record\n", "utf8");
  return dir;
}

function importDir(state, dir, options = {}) {
  return applyPatternImport(state, planPatternImport(state, pitfallCandidatesFromPath(dir), options));
}

test("a manual pitfall record becomes a judgment pattern that keeps its origin and provenance", () => {
  const state = createEmptyState();
  const plan = importDir(state, recordDir([record()]));
  assert.equal(plan.rows[0].action, "add");

  const pattern = findPattern(state, "rls-001");
  assert.equal(pattern.kind, "judgment");
  assert.equal(pattern.check, null);
  assert.equal(pattern.severity, "high");
  assert.equal(pattern.origin, "docs/case-studies/hanami-nail.md#rls-は行を守るが列は守らない");
  assert.equal(pattern.summary, "ポリシーが行を絞っていても、列は絞らない。");
  assert.match(pattern.question, /rls-001/);
  assert.deepEqual(pattern.appliesTo, { requires: ["supabase"] }, "only tags SUMI can register become requirements");
  assert.deepEqual(
    { kind: pattern.source.kind, id: pattern.source.id, file: pattern.source.file, confidence: pattern.source.confidence },
    { kind: "pitfall-record", id: "rls-001", file: "rls-001.json", confidence: "inferred" }
  );
  assert.equal(pattern.source.digest, patternContentDigest(pattern));
  assert.match(formatPattern(pattern), /Imported from: pitfall-record rls-001 \(inferred\)/);
});

test("a checkable file-content record becomes a mechanical pattern on the bundled checker", () => {
  const mapped = mapPitfallRecord(record({
    id: "secret-001",
    tags: [],
    detection: { checkable: true, kind: "file-content", target: "src/lib/supabase.ts", pattern: "service_role", expect: "absent" }
  }));
  const check = mapped.candidate.check;
  assert.deepEqual(check.argv, ["{sumi-node}", "{sumi-checks}/file-content.mjs", "src/lib/supabase.ts", "service_role", "absent"]);
  assert.equal(check.expect, "exit-zero");
  assert.deepEqual(check.reproducedExitCodes, [3], "only 3 is a reproduction; a crash or an unreadable target is an error");
  assert.equal(mapped.candidate.appliesTo, null);
});

test("a checkable kind SUMI cannot run is imported as judgment and says so", () => {
  const mapped = mapPitfallRecord(record({
    id: "lint-001",
    detection: { checkable: true, kind: "exit-code", target: "x", pattern: "y", expect: "present" }
  }));
  assert.equal(mapped.candidate.check, null);
  assert.match(mapped.notes[0], /exit-code has no SUMI runner; imported as a judgment question/);
});

test("tooling layers and behaviour records are skipped with a reason, not imported", () => {
  const state = createEmptyState();
  const plan = importDir(state, recordDir([
    record({ id: "perm-001", layer: "permissions" }),
    record({ id: "shell-001", kind: "behaviour", status: undefined }),
    record({ id: "rls-002" })
  ]));
  assert.deepEqual(plan.skipped.map((item) => item.key), ["perm-001", "shell-001"]);
  assert.match(plan.skipped[0].reason, /layer permissions describes agent tooling/);
  assert.match(plan.skipped[1].reason, /behaviour record/);
  assert.deepEqual(state.patterns.map((item) => item.key), ["rls-002"]);
});

test("one invalid record aborts the whole import and writes nothing", () => {
  const state = createEmptyState();
  const dir = recordDir([
    record({ id: "rls-001" }),
    record({ id: "rls-002", severity: "critical" }),
    record({ id: "rls-003", origin: "issue:42" }),
    record({ id: "rls-004", detection: { checkable: true, kind: "file-content", expect: "absent" } })
  ]);
  fs.writeFileSync(path.join(dir, "rls-005.json"), "{ not json", "utf8");
  fs.writeFileSync(path.join(dir, "rls-006.json"), JSON.stringify(record({ id: "rls-007" })), "utf8");
  const before = JSON.stringify(state);

  assert.throws(() => importDir(state, dir), (error) => {
    assert.match(error.message, /nothing was written/);
    assert.match(error.message, /rls-002\.json: severity must be one of/);
    assert.match(error.message, /rls-003\.json: .*issue:<n>/);
    assert.match(error.message, /rls-004\.json: detection\.target is required when checkable; detection\.pattern is required/);
    assert.match(error.message, /rls-005\.json: does not parse as JSON/);
    assert.match(error.message, /rls-006\.json: file name must be rls-007\.json/);
    return true;
  });
  assert.equal(JSON.stringify(state), before);
});

test("re-importing the same records changes nothing", () => {
  const state = createEmptyState();
  const dir = recordDir([record(), record({ id: "rls-002" })]);
  importDir(state, dir);
  const before = JSON.stringify(state.patterns);
  const plan = importDir(state, dir);
  assert.deepEqual(plan.rows.map((row) => row.action), ["unchanged", "unchanged"]);
  assert.equal(JSON.stringify(state.patterns), before);
});

test("a changed record is refused without --update and applied with it", () => {
  const state = createEmptyState();
  importDir(state, recordDir([record()]));
  const pattern = findPattern(state, "rls-001");
  const fingerprintBefore = getPatternFingerprint(pattern);
  const changed = recordDir([record({
    severity: "medium",
    detection: { checkable: true, kind: "file-content", target: "supabase/grants.sql", pattern: "revoke select", expect: "present" }
  })]);

  assert.throws(() => importDir(state, changed), /record changed since import; rerun with --update/);
  assert.equal(findPattern(state, "rls-001").severity, "high", "a refused update leaves the pattern alone");

  const plan = importDir(state, changed, { update: true });
  assert.equal(plan.rows[0].action, "update");
  assert.equal(pattern.severity, "medium");
  assert.equal(pattern.kind, "mechanical");
  assert.equal(pattern.id, "P001", "an update keeps the pattern's identity");
  assert.notEqual(getPatternFingerprint(pattern), fingerprintBefore, "a changed check invalidates earlier sweeps");
  assert.equal(pattern.source.digest, patternContentDigest(pattern));
});

test("a hand-added pattern with the same key is never overwritten, even with --update", () => {
  const state = createEmptyState();
  addPattern(state, { key: "rls-001", title: "mine", question: "mine?", origin: "record" });
  assert.throws(() => importDir(state, recordDir([record()]), { update: true }), /already exists and was not imported/);
  assert.equal(findPattern(state, "rls-001").title, "mine");
});

test("a pattern edited by hand since import keeps its edits", () => {
  const state = createEmptyState();
  importDir(state, recordDir([record()]));
  setPattern(state, "rls-001", { severity: "low" });

  const same = importDir(state, recordDir([record()]));
  assert.equal(same.rows[0].action, "unchanged");
  assert.match(same.rows[0].note, /edited locally since import; local edits kept/);
  assert.equal(findPattern(state, "rls-001").severity, "low");

  assert.throws(
    () => importDir(state, recordDir([record({ summary: "新しい説明" })]), { update: true }),
    /the record changed AND the pattern was edited locally/
  );
  assert.equal(findPattern(state, "rls-001").severity, "low");
});

test("a dry-run plan reports what would happen and leaves the state alone", () => {
  const state = createEmptyState();
  const plan = planPatternImport(state, pitfallCandidatesFromPath(recordDir([record()])));
  assert.deepEqual(state.patterns, []);
  const output = formatPatternImport(plan, { label: "records", dryRun: true });
  assert.match(output, /dry run; nothing written/);
  assert.match(output, /would add\s+rls-001/);
  assert.match(output, /1 judgment pattern\(s\): sweep does not run these/);
});

test("built-in patterns import as mechanical checks on bundled scripts that exist", () => {
  const state = createEmptyState();
  const plan = applyPatternImport(state, planPatternImport(state, { candidates: builtinPatternCandidates() }));
  assert.deepEqual(plan.rows.map((row) => row.key), ["service-role-in-client"]);
  const pattern = findPattern(state, "service-role-in-client");
  assert.equal(pattern.kind, "mechanical");
  assert.equal(pattern.origin, "record");
  assert.deepEqual(pattern.appliesTo, { requires: ["supabase"] });
  assert.deepEqual(pattern.check.reproducedExitCodes, [3]);
  assert.equal(resolveBundledInvocation(pattern.check.argv).args[0], path.join(CHECKS_DIR, "service-role-in-client.mjs"));
  assert.ok(fs.existsSync(path.join(CHECKS_DIR, "service-role-in-client.mjs")));
  assert.equal(pattern.source.kind, "builtin");
  assert.doesNotMatch(JSON.stringify(pattern), new RegExp(CHECKS_DIR.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")), "no machine path is stored");
});

test("the import digest does not depend on where SUMI is installed", () => {
  const [candidate] = builtinPatternCandidates();
  assert.doesNotMatch(JSON.stringify(candidate), /checks[\\/]service-role/);
  assert.equal(patternContentDigest(candidate), patternContentDigest(JSON.parse(JSON.stringify(candidate))));
});

test("records are validated against the upstream schema, not re-classified", () => {
  const cases = [
    [record({ layer: "App" }), /layer must be one of/],
    [record({ kind: "behavior" }), /kind must be one of/],
    [record({ confidence: "measurd" }), /confidence must be one of/],
    [record({ status: "bogus" }), /status must be one of/],
    [record({ extra: true }), /unknown field\(s\): extra/],
    [record({ title: "x".repeat(101) }), /title is longer than 100/],
    [record({ kind: "behaviour" }), /behaviour record must not have a status/],
    [record({ status: undefined }), /trap record requires a status/],
    [record({ confidence: "measured" }), /measured record requires measured_on/],
    [record({ tags: "supabase" }), /tags must be an array/],
    [record({ detection: { checkable: false, kind: "manual", bogus: 1 } }), /unknown detection field/]
  ];
  for (const [input, problem] of cases) {
    const mapped = mapPitfallRecord(JSON.parse(JSON.stringify(input)));
    assert.ok(mapped.invalid, `expected invalid: ${problem}`);
    assert.match(mapped.invalid.problems.join("; "), problem);
  }
});

test("a local edit that already matches the new record becomes the new baseline", () => {
  const state = createEmptyState();
  importDir(state, recordDir([record()]));
  setPattern(state, "rls-001", { severity: "medium" });
  const plan = importDir(state, recordDir([record({ severity: "medium" })]));
  assert.equal(plan.rows[0].action, "unchanged");
  assert.match(plan.rows[0].note, /new baseline/);
  const pattern = findPattern(state, "rls-001");
  assert.equal(pattern.source.digest, patternContentDigest(pattern));
  assert.equal(importDir(state, recordDir([record({ severity: "medium" })])).rows[0].note, null);
});
