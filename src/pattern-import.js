import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bundledArgv, CHECKS_DIR } from "./bundled-checks.js";
import {
  addPattern,
  ensurePatternsShape,
  normalizeAppliesTo,
  normalizeCheck,
  normalizeOrigin,
  PATTERN_SERVICES,
  setPattern,
  SEVERITIES
} from "./findings.js";

/**
 * Pattern import turns records of the ai-workforce pitfall database
 * (data/app-pitfalls/*.json, schema_version 1) — or SUMI's own built-in
 * patterns — into cross-project patterns.
 *
 * The import is all-or-nothing. Every record is validated and every conflict
 * is resolved before anything is written; one invalid record or one refused
 * update leaves the state exactly as it was. A record is never half-mapped:
 * what SUMI cannot represent faithfully is either refused or reported.
 */

export { CHECKS_DIR };

// A copy of ai-workforce data/pitfalls/_schema.json (schema_version 1). The
// import validates against it rather than trusting the shape: a typo such as
// layer "App" or kind "behavior" must be refused, not silently re-classified.
const RECORD_ID = /^[a-z][a-z0-9]*-[0-9]{3}$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const ENUMS = {
  confidence: new Set(["measured", "inferred", "documented", "unverified"]),
  status: new Set(["closed", "open_recorded", "untouched"]),
  kind: new Set(["trap", "limitation", "behaviour"]),
  layer: new Set(["instruction", "permissions", "hook", "runtime", "ci", "external", "app"])
};
const RECORD_FIELDS = new Set([
  "id", "title", "summary", "layer", "kind", "severity", "confidence", "origin",
  "measured_on", "environment", "repro", "sources", "inferred_from",
  "status", "fix", "why_not_closed", "detection", "related", "tags"
]);
const DETECTION_FIELDS = new Set(["checkable", "kind", "target", "pattern", "expect", "message", "note"]);
const DETECTION_KINDS = new Set(["settings-json", "file-content", "exit-code", "manual"]);
const DETECTION_EXPECT = new Set(["present", "absent"]);
const TITLE_MAX = 100;

// Bundled checks exit 0 when clean and 3 when they reproduce. Every other exit
// (2 = could not check, 1 = Node failed, anything a crash returns) is an
// execution error, so it can never be read as a reproduction.
function bundledCheck(script, args = [], timeoutMs = 60000) {
  return {
    argv: bundledArgv(script, args),
    cwd: "repo",
    timeoutMs,
    expect: "exit-zero",
    reproducedExitCodes: [3]
  };
}

/**
 * The content a pattern is answered by. Display-only metadata (the source
 * itself, timestamps, the generated ID) is left out, so the digest changes
 * exactly when what a reader or a sweep would see changes.
 */
export function patternContentDigest(pattern) {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    title: pattern.title,
    question: pattern.question,
    summary: pattern.summary || null,
    severity: pattern.severity,
    origin: pattern.origin,
    appliesTo: normalizeAppliesTo(pattern.appliesTo),
    check: normalizeCheck(pattern.check)
  })).digest("hex");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate one pitfall record and map it to a pattern candidate.
 * Returns { candidate } | { skip } | { invalid } and never throws.
 */
export function mapPitfallRecord(record, { file = null } = {}) {
  const where = file || record?.id || "record";
  const problems = [];
  if (!isObject(record)) return { invalid: { file: where, problems: ["not a JSON object"] } };

  if (!nonEmpty(record.id) || !RECORD_ID.test(record.id)) problems.push(`id must match ${RECORD_ID}`);
  if (file && nonEmpty(record.id) && path.basename(file) !== `${record.id}.json`) problems.push(`file name must be ${record.id}.json`);
  const unknownFields = Object.keys(record).filter((field) => !RECORD_FIELDS.has(field));
  if (unknownFields.length) problems.push(`unknown field(s): ${unknownFields.join(", ")}`);
  for (const field of ["title", "summary"]) {
    if (!nonEmpty(record[field])) problems.push(`${field} is required`);
  }
  if (nonEmpty(record.title) && record.title.length > TITLE_MAX) problems.push(`title is longer than ${TITLE_MAX} characters`);
  for (const [field, allowed] of Object.entries(ENUMS)) {
    if (field === "status" && record.status === undefined) continue;
    if (!allowed.has(record[field])) problems.push(`${field} must be one of ${[...allowed].join(", ")}`);
  }
  if (!SEVERITIES.has(record.severity)) problems.push(`severity must be one of ${[...SEVERITIES].join(", ")}`);
  if (record.kind === "behaviour" && record.status !== undefined) problems.push("a behaviour record must not have a status");
  if (["trap", "limitation"].includes(record.kind) && record.status === undefined) problems.push(`a ${record.kind} record requires a status`);
  if (record.confidence === "measured" && !(nonEmpty(record.measured_on) && DATE.test(record.measured_on))) {
    problems.push("a measured record requires measured_on (YYYY-MM-DD)");
  }
  for (const field of ["repro", "sources", "inferred_from", "related", "tags"]) {
    const value = record[field];
    if (value !== undefined && (!Array.isArray(value) || value.some((item) => !nonEmpty(item)))) {
      problems.push(`${field} must be an array of non-empty strings`);
    }
  }

  let origin = null;
  try {
    origin = normalizeOrigin(record.origin);
  } catch (error) {
    problems.push(`${error.message} SUMI cannot trace an "issue:<n>" origin; give the record a prose origin first.`);
  }

  const detection = record.detection;
  let checkable = false;
  if (detection !== undefined) {
    if (!isObject(detection) || typeof detection.checkable !== "boolean") {
      problems.push("detection must be an object with a boolean checkable");
    } else if (Object.keys(detection).some((field) => !DETECTION_FIELDS.has(field))) {
      problems.push(`unknown detection field(s): ${Object.keys(detection).filter((field) => !DETECTION_FIELDS.has(field)).join(", ")}`);
    } else if (!DETECTION_KINDS.has(detection.kind)) {
      problems.push(`detection.kind must be one of ${[...DETECTION_KINDS].join(", ")}`);
    } else if (detection.checkable) {
      checkable = true;
      if (!nonEmpty(detection.target)) problems.push("detection.target is required when checkable");
      if (!nonEmpty(detection.pattern)) problems.push("detection.pattern is required when checkable");
      if (!DETECTION_EXPECT.has(detection.expect)) problems.push("detection.expect must be present or absent when checkable");
    }
  }

  if (problems.length) return { invalid: { file: where, problems } };

  // Skips are decided only after validation: a malformed record is reported
  // as malformed even when it would have been skipped.
  if (record.layer !== "app") {
    return { skip: { key: record.id, reason: `layer ${record.layer} describes agent tooling, not application code` } };
  }
  if (record.kind === "behaviour") {
    return { skip: { key: record.id, reason: "a behaviour record describes how a tool behaves, not a defect to look for" } };
  }

  const notes = [];
  let check = null;
  if (checkable && detection.kind === "file-content") {
    check = bundledCheck("file-content.mjs", [detection.target, detection.pattern, detection.expect], 30000);
  } else if (checkable) {
    notes.push(`${record.id}: detection.kind ${detection.kind} has no SUMI runner; imported as a judgment question`);
  }

  // Only services SUMI can register become requirements. Anything else stays
  // a plain tag in the record, not a reason to call the pattern unknown.
  const requires = (record.tags || []).filter((tag) => PATTERN_SERVICES.has(tag));

  return {
    candidate: {
      key: record.id,
      title: record.title.trim(),
      question: `Does this project have the problem described in ${record.id}? ${record.title.trim()}`,
      summary: record.summary.trim(),
      severity: record.severity,
      origin,
      appliesTo: requires.length ? { requires: [...new Set(requires)] } : null,
      check,
      source: {
        kind: "pitfall-record",
        id: record.id,
        ...(file ? { file: path.basename(file) } : {}),
        confidence: record.confidence
      }
    },
    notes
  };
}

/**
 * Read pitfall records from one file or a directory of them. Files beginning
 * with "_" are schema and template files, not records, as in ai-workforce.
 */
export function readPitfallRecords(inputPath) {
  if (!inputPath) throw new Error("A pitfall record file or directory is required.");
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved)) throw new Error(`Not found: ${inputPath}`);
  const files = fs.statSync(resolved).isDirectory()
    ? fs.readdirSync(resolved)
      .filter((name) => name.endsWith(".json") && !name.startsWith("_"))
      .sort()
      .map((name) => path.join(resolved, name))
    : [resolved];
  if (!files.length) throw new Error(`No pitfall records (*.json) in ${inputPath}.`);
  return files.map((file) => {
    try {
      return { file, record: JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) };
    } catch (error) {
      return { file, parseError: `does not parse as JSON: ${error.message}` };
    }
  });
}

export function builtinPatternCandidates() {
  return [
    {
      key: "service-role-in-client",
      title: "The Supabase service role key can reach the browser",
      question: "Can the Supabase service role key reach browser code, through a browser-exposed variable or a \"use client\" module?",
      summary: "The service role key bypasses every RLS policy. A NEXT_PUBLIC_/VITE_/PUBLIC_ variable is inlined into the client bundle at build time, and anything a \"use client\" module touches ships to the browser. The check reports file, line and variable name only, never the value.",
      severity: "high",
      origin: "record",
      appliesTo: { requires: ["supabase"] },
      check: bundledCheck("service-role-in-client.mjs"),
      source: { kind: "builtin", id: "service-role-in-client" }
    }
  ];
}

export function pitfallCandidatesFromPath(inputPath) {
  const invalid = [];
  const skipped = [];
  const candidates = [];
  const notes = [];
  const seen = new Map();
  for (const entry of readPitfallRecords(inputPath)) {
    const name = path.basename(entry.file);
    if (entry.parseError) {
      invalid.push({ file: name, problems: [entry.parseError] });
      continue;
    }
    const mapped = mapPitfallRecord(entry.record, { file: entry.file });
    if (mapped.invalid) {
      invalid.push({ ...mapped.invalid, file: name });
      continue;
    }
    const id = mapped.candidate?.key || mapped.skip.key;
    if (seen.has(id)) {
      invalid.push({ file: name, problems: [`duplicate record id ${id} (also in ${seen.get(id)})`] });
      continue;
    }
    seen.set(id, name);
    if (mapped.skip) skipped.push(mapped.skip);
    else {
      candidates.push(mapped.candidate);
      notes.push(...mapped.notes);
    }
  }
  return { candidates, skipped, invalid, notes };
}

/**
 * Decide what each candidate would do to the state, without changing it.
 */
export function planPatternImport(state, { candidates = [], skipped = [], invalid = [], notes = [] } = {}, { update = false } = {}) {
  const patterns = ensurePatternsShape(state);
  const rows = [];
  const refused = [];
  for (const candidate of candidates) {
    const digest = patternContentDigest(candidate);
    const existing = patterns.find((item) => item.key === candidate.key) || null;
    const row = { key: candidate.key, title: candidate.title, kind: candidate.check ? "mechanical" : "judgment", severity: candidate.severity, candidate, digest };
    if (!existing) {
      rows.push({ ...row, action: "add" });
      continue;
    }
    if (!existing.source) {
      refused.push(`${candidate.key}: a pattern with this key already exists and was not imported; remove or rename it first`);
      continue;
    }
    if (existing.source.kind !== candidate.source.kind || existing.source.id !== candidate.source.id) {
      refused.push(`${candidate.key}: already imported from ${existing.source.kind} ${existing.source.id}, not ${candidate.source.kind} ${candidate.source.id}`);
      continue;
    }
    const currentDigest = patternContentDigest(existing);
    const editedLocally = currentDigest !== existing.source.digest;
    if (editedLocally && digest === currentDigest) {
      // The hand edit and the new record agree; adopt the record as the new
      // baseline so the next change to it is compared against this content.
      rows.push({ ...row, action: "unchanged", refreshSource: true, note: "local edits already match the record; recorded it as the new baseline" });
      continue;
    }
    if (digest === existing.source.digest) {
      rows.push({ ...row, action: "unchanged", note: editedLocally ? "edited locally since import; local edits kept" : null });
      continue;
    }
    if (editedLocally) {
      refused.push(`${candidate.key}: the record changed AND the pattern was edited locally since import; reconcile by hand (pattern set) or remove the pattern and import again`);
      continue;
    }
    if (!update) {
      refused.push(`${candidate.key}: the record changed since import; rerun with --update to apply it (a changed check makes earlier sweeps RECHECK REQUIRED)`);
      continue;
    }
    rows.push({ ...row, action: "update", patternId: existing.id });
  }
  return { rows, skipped, invalid, refused, notes };
}

export function assertPatternImportPlan(plan) {
  const lines = [];
  for (const item of plan.invalid) lines.push(`  invalid ${item.file}: ${item.problems.join("; ")}`);
  for (const reason of plan.refused) lines.push(`  refused ${reason}`);
  if (lines.length) {
    throw new Error(`Pattern import aborted; nothing was written.\n${lines.join("\n")}`);
  }
}

export function applyPatternImport(state, plan) {
  assertPatternImportPlan(plan);
  for (const row of plan.rows) {
    const { candidate, digest } = row;
    const source = { ...candidate.source, digest };
    if (row.action === "add") {
      row.patternId = addPattern(state, { ...candidate, source }).id;
    } else if (row.action === "update") {
      setPattern(state, candidate.key, {
        title: candidate.title,
        question: candidate.question,
        summary: candidate.summary,
        severity: candidate.severity,
        origin: candidate.origin,
        appliesTo: candidate.appliesTo,
        check: candidate.check,
        source
      });
    } else if (row.action === "unchanged") {
      const existing = ensurePatternsShape(state).find((item) => item.key === candidate.key);
      row.patternId = existing?.id;
      if (row.refreshSource) setPattern(state, candidate.key, { source });
    }
  }
  return plan;
}

export function summarizePatternImport(plan) {
  const count = (action) => plan.rows.filter((row) => row.action === action).length;
  return {
    added: count("add"),
    updated: count("update"),
    unchanged: count("unchanged"),
    skipped: plan.skipped.length,
    rebaselined: plan.rows.filter((row) => row.refreshSource).length
  };
}

function pad(value, width) {
  const textValue = String(value ?? "");
  return textValue.length >= width ? `${textValue.slice(0, width - 1)}…` : textValue.padEnd(width);
}

export function formatPatternImport(plan, { label, dryRun = false } = {}) {
  const verbs = { add: dryRun ? "would add" : "added", update: dryRun ? "would update" : "updated", unchanged: "unchanged" };
  const lines = [
    `SUMI PATTERN IMPORT — ${label}${dryRun ? " (dry run; nothing written)" : ""}`,
    "=".repeat(84),
    `${pad("ACTION", 14)} ${pad("KEY", 24)} ${pad("KIND", 11)} ${pad("SEV", 7)} TITLE`,
    "-".repeat(84)
  ];
  for (const row of plan.rows) {
    lines.push(`${pad(verbs[row.action], 14)} ${pad(row.key, 24)} ${pad(row.kind, 11)} ${pad(row.severity, 7)} ${row.title}`);
    if (row.note) lines.push(`${" ".repeat(15)}note: ${row.note}`);
  }
  for (const item of plan.skipped) lines.push(`${pad("skipped", 14)} ${pad(item.key, 24)} ${item.reason}`);
  if (!plan.rows.length && !plan.skipped.length) lines.push("Nothing to import.");
  const totals = summarizePatternImport(plan);
  lines.push("", `${dryRun ? "would add" : "added"} ${totals.added} | ${dryRun ? "would update" : "updated"} ${totals.updated} | unchanged ${totals.unchanged} | skipped ${totals.skipped}`);
  for (const note of plan.notes) lines.push(`note: ${note}`);
  const judgment = plan.rows.filter((row) => row.kind === "judgment" && row.action !== "unchanged").length;
  if (judgment) lines.push(`${judgment} judgment pattern(s): sweep does not run these; answer them per project with "sumi finding add".`);
  return lines.join("\n");
}
