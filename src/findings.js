import { addScopeCriterion, getServiceState, touch } from "./domain.js";

export const FINDING_STATUSES = new Set(["suspected", "confirmed", "not_applicable", "fixed", "dismissed"]);
export const PATTERN_KINDS = new Set(["mechanical", "judgment"]);
export const SEVERITIES = new Set(["high", "medium", "low"]);
export const SOURCE_KINDS = new Set(["sweep", "agent", "human"]);
export const CHECK_EXPECTATIONS = new Set(["exit-zero", "exit-nonzero", "no-output"]);
export const CHECK_CWDS = new Set(["repo"]);
export const PATTERN_SERVICES = new Set(["vercel", "supabase"]);
export const REASON_REQUIRED_STATUSES = new Set(["not_applicable", "dismissed"]);
export const EVIDENCE_OUTPUT_LIMIT = 4096;

const PATTERN_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ORIGIN_FINDING = /^[a-z0-9][a-z0-9-_]*:F\d{3,}$/;
const ORIGIN_ANCHOR = /^[^#\s][^#]*#[^#\s]+$/;
const FINDING_ID = /^F\d{3,}$/;

// A project cell shows the loudest thing SUMI knows about that pattern.
const CELL_ORDER = ["confirmed", "suspected", "fixed", "not_applicable", "dismissed"];

function text(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function oneOf(value, allowed, label, fallback) {
  const picked = value === undefined || value === null || value === "" ? fallback : value;
  if (!allowed.has(picked)) throw new Error(`Invalid ${label}: ${value}. Use one of ${[...allowed].join(", ")}.`);
  return picked;
}

function stringList(value, label) {
  if (value === undefined || value === null || value === "") return [];
  const list = Array.isArray(value) ? value : String(value).split(",");
  return list.map((item) => {
    if (typeof item !== "string" || !item.trim()) throw new Error(`${label} must not contain empty entries.`);
    return item.trim();
  });
}

function isoDate(value, label) {
  if (value === undefined || value === null || value === "") return new Date().toISOString();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${label}: ${value}`);
  return date.toISOString();
}

/**
 * Only three origin forms are accepted, so that every pattern can be traced
 * back to something a reader can open: a finding in another project, a manual
 * record, or an anchored document.
 */
export function normalizeOrigin(value) {
  const raw = text(value, "Pattern origin");
  if (raw.includes("#")) {
    if (!ORIGIN_ANCHOR.test(raw)) throw new Error(`Invalid pattern origin: ${raw}. Use "<path>#<anchor>".`);
    return raw;
  }
  if (raw === "record") return raw;
  if (!ORIGIN_FINDING.test(raw)) {
    throw new Error(`Invalid pattern origin: ${raw}. Use "<project>:<findingId>", "record", or "<path>#<anchor>".`);
  }
  return raw;
}

export function normalizeCheck(check) {
  if (check === undefined || check === null) return null;
  if (typeof check !== "object" || Array.isArray(check)) throw new Error("Pattern check must be an object or null.");
  const argv = Array.isArray(check.argv) ? check.argv : null;
  if (!argv || argv.length === 0) throw new Error("Pattern check requires a non-empty argv array.");
  for (const arg of argv) {
    if (typeof arg !== "string" || !arg.length) throw new Error("Pattern check argv must contain non-empty strings.");
  }
  const timeoutMs = Number(check.timeoutMs ?? 60000);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600000) {
    throw new Error("Pattern check timeoutMs must be an integer between 1 and 600000.");
  }
  return {
    argv: [...argv],
    cwd: oneOf(check.cwd, CHECK_CWDS, "pattern check cwd", "repo"),
    timeoutMs,
    expect: oneOf(check.expect, CHECK_EXPECTATIONS, "pattern check expectation", "exit-zero")
  };
}

export function normalizeAppliesTo(appliesTo) {
  if (appliesTo === undefined || appliesTo === null) return null;
  if (typeof appliesTo !== "object" || Array.isArray(appliesTo)) throw new Error("Pattern appliesTo must be an object or null.");
  const requires = stringList(appliesTo.requires, "Pattern appliesTo.requires");
  if (!requires.length) return null;
  for (const service of requires) {
    if (!PATTERN_SERVICES.has(service)) {
      throw new Error(`Unknown service in appliesTo.requires: ${service}. Use one of ${[...PATTERN_SERVICES].join(", ")}.`);
    }
  }
  return { requires };
}

export function normalizeSource(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Finding source is required.");
  const normalized = { kind: oneOf(source.kind, SOURCE_KINDS, "finding source kind") };
  if (source.agent) normalized.agent = text(source.agent, "Finding source agent");
  if (source.sessionId) normalized.sessionId = text(source.sessionId, "Finding source sessionId");
  return normalized;
}

/**
 * Evidence without a commit cannot be re-checked later, so it is refused.
 * Long output is truncated in place and flagged, never silently dropped.
 */
export function normalizeEvidence(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("Finding evidence is required.");
  const normalized = {
    commit: text(evidence.commit, "Finding evidence commit"),
    files: stringList(evidence.files, "Finding evidence files"),
    output: evidence.output === undefined || evidence.output === null ? "" : String(evidence.output),
    checkedAt: isoDate(evidence.checkedAt, "finding evidence checkedAt")
  };
  if (normalized.output.length > EVIDENCE_OUTPUT_LIMIT) {
    normalized.output = normalized.output.slice(0, EVIDENCE_OUTPUT_LIMIT);
    normalized.truncated = true;
  }
  return normalized;
}

function normalizeCheckRun(run, pattern) {
  if (run === undefined || run === null) return null;
  if (!pattern || pattern.kind !== "mechanical") {
    throw new Error("A check run can only be recorded against a mechanical pattern.");
  }
  if (typeof run !== "object" || Array.isArray(run)) throw new Error("Confirmation check must be an object.");
  if (typeof run.satisfied !== "boolean") throw new Error("Confirmation check requires a boolean 'satisfied'.");
  const exitCode = run.exitCode === undefined || run.exitCode === null ? null : Number(run.exitCode);
  if (exitCode !== null && !Number.isInteger(exitCode)) throw new Error("Confirmation check exitCode must be an integer.");
  return {
    argv: [...pattern.check.argv],
    expect: pattern.check.expect,
    exitCode,
    satisfied: run.satisfied,
    ranAt: isoDate(run.ranAt, "confirmation check ranAt")
  };
}

export function ensurePatternsShape(state) {
  if (!Array.isArray(state.patterns)) state.patterns = [];
  return state.patterns;
}

export function ensureFindingsShape(project) {
  if (!Array.isArray(project.findings)) project.findings = [];
  return project.findings;
}

function nextPatternId(patterns) {
  const seq = patterns.reduce((max, item) => Math.max(max, Number(String(item.id || "").slice(1)) || 0), 0) + 1;
  return `P${String(seq).padStart(3, "0")}`;
}

function nextFindingSeq(findings) {
  return findings.reduce((max, item) => Math.max(max, Number(item.seq) || 0), 0) + 1;
}

export function addPattern(state, { key, title, question, check = null, origin, severity = "medium", appliesTo = null } = {}) {
  const patterns = ensurePatternsShape(state);
  const slug = text(key, "Pattern key");
  if (!PATTERN_KEY.test(slug)) throw new Error(`Pattern key must be lowercase letters, digits and hyphens: ${slug}`);
  if (patterns.some((item) => item.key === slug)) throw new Error(`Pattern key already exists: ${slug}`);
  const normalizedCheck = normalizeCheck(check);
  const now = new Date().toISOString();
  const pattern = {
    id: nextPatternId(patterns),
    key: slug,
    title: text(title, "Pattern title"),
    question: text(question, "Pattern question"),
    kind: normalizedCheck ? "mechanical" : "judgment",
    check: normalizedCheck,
    origin: normalizeOrigin(origin),
    severity: oneOf(severity, SEVERITIES, "pattern severity", "medium"),
    appliesTo: normalizeAppliesTo(appliesTo),
    createdAt: now,
    updatedAt: now
  };
  patterns.push(pattern);
  return pattern;
}

export function listPatterns(state) {
  return [...ensurePatternsShape(state)].sort((a, b) => a.key.localeCompare(b.key));
}

export function findPattern(state, keyOrId) {
  if (!keyOrId) return null;
  const needle = String(keyOrId);
  return ensurePatternsShape(state).find((item) => item.key === needle || item.id === needle.toUpperCase()) || null;
}

export function getPattern(state, keyOrId) {
  const pattern = findPattern(state, keyOrId);
  if (!pattern) throw new Error(`Pattern not found: ${keyOrId}`);
  return pattern;
}

export function setPattern(state, keyOrId, patch = {}) {
  const pattern = getPattern(state, keyOrId);
  if (patch.key !== undefined && patch.key !== pattern.key) throw new Error("Pattern key is a stable slug and cannot be changed.");
  if (patch.title !== undefined) pattern.title = text(patch.title, "Pattern title");
  if (patch.question !== undefined) pattern.question = text(patch.question, "Pattern question");
  if (patch.origin !== undefined) pattern.origin = normalizeOrigin(patch.origin);
  if (patch.severity !== undefined) pattern.severity = oneOf(patch.severity, SEVERITIES, "pattern severity", "medium");
  if (patch.appliesTo !== undefined) pattern.appliesTo = normalizeAppliesTo(patch.appliesTo);
  if (patch.check !== undefined) {
    pattern.check = normalizeCheck(patch.check);
    pattern.kind = pattern.check ? "mechanical" : "judgment";
  }
  pattern.updatedAt = new Date().toISOString();
  return pattern;
}

export function listPatternReferences(state, key) {
  const rows = [];
  for (const project of Object.values(state.projects || {})) {
    for (const finding of ensureFindingsShape(project)) {
      if (finding.patternKey === key) rows.push({ projectId: project.id, findingId: finding.id });
    }
  }
  return rows;
}

export function removePattern(state, keyOrId) {
  const pattern = getPattern(state, keyOrId);
  const references = listPatternReferences(state, pattern.key);
  if (references.length) {
    const where = references.map((row) => `${row.projectId}:${row.findingId}`).join(", ");
    throw new Error(`Pattern ${pattern.key} is still referenced by ${references.length} finding(s): ${where}`);
  }
  const patterns = ensurePatternsShape(state);
  patterns.splice(patterns.indexOf(pattern), 1);
  return pattern;
}

/**
 * R7. An unregistered service is unknown, never "not applicable". Only a
 * service the project has explicitly marked as unused makes a pattern n/a.
 */
export function getPatternApplicability(project, pattern) {
  const requires = pattern?.appliesTo?.requires || [];
  if (!requires.length) return { applicable: "yes", reason: null };
  const unknown = [];
  for (const service of requires) {
    const state = getServiceState(project, service).state;
    if (state === "unused") return { applicable: "no", reason: `service unused: ${service}` };
    if (state !== "registered") unknown.push(service);
  }
  if (unknown.length) return { applicable: "unknown", reason: `service unregistered: ${unknown.join(", ")}` };
  return { applicable: "yes", reason: null };
}

export function addFinding(state, project, {
  title,
  patternKey = null,
  detail = "",
  severity = null,
  source,
  evidence,
  check = null
} = {}) {
  const findings = ensureFindingsShape(project);
  const pattern = patternKey ? getPattern(state, patternKey) : null;
  const seq = nextFindingSeq(findings);
  const now = new Date().toISOString();
  const normalizedSource = normalizeSource(source);
  const normalizedEvidence = normalizeEvidence(evidence);
  const finding = {
    id: `F${String(seq).padStart(3, "0")}`,
    seq,
    patternKey: pattern ? pattern.key : null,
    title: text(title, "Finding title"),
    detail: typeof detail === "string" ? detail : "",
    // Every finding starts as a suspicion. R1 decides when it may be raised.
    status: "suspected",
    severity: oneOf(severity, SEVERITIES, "finding severity", pattern ? pattern.severity : "medium"),
    source: normalizedSource,
    evidence: normalizedEvidence,
    confirmations: [{
      source: normalizedSource,
      evidence: normalizedEvidence,
      check: normalizeCheckRun(check, pattern),
      recordedAt: now
    }],
    reason: null,
    scopeId: null,
    fixedBy: null,
    createdAt: now,
    updatedAt: now
  };
  findings.push(finding);
  touch(project);
  return finding;
}

export function getFinding(project, findingId) {
  const needle = String(findingId || "").toUpperCase();
  if (!FINDING_ID.test(needle)) throw new Error(`Invalid finding id: ${findingId}`);
  const finding = ensureFindingsShape(project).find((item) => item.id === needle);
  if (!finding) throw new Error(`Finding not found: ${needle}`);
  return finding;
}

export function listFindings(project, { patternKey = null, status = null } = {}) {
  return ensureFindingsShape(project).filter((finding) => {
    if (patternKey && finding.patternKey !== patternKey) return false;
    if (status && finding.status !== status) return false;
    return true;
  });
}

/**
 * R1. `confirmed` needs evidence SUMI did not have to take on trust: either a
 * mechanical check the sweep itself reproduced, or corroboration from a
 * different kind of source. Repeated self-reports never clear this bar, and a
 * check result typed in by hand is a self-report — only a `sweep` source may
 * carry one, so until the sweep runner exists this leaves two distinct source
 * kinds as the only route.
 */
export function getConfirmationBasis(finding, pattern) {
  const confirmations = Array.isArray(finding.confirmations) ? finding.confirmations : [];
  const kinds = [...new Set(confirmations.map((item) => item.source?.kind).filter(Boolean))];
  const reproduced = confirmations.find((item) => item.check?.satisfied === true && item.source?.kind === "sweep");
  if (reproduced && pattern?.kind === "mechanical") return { ok: true, basis: "mechanical-check", kinds };
  if (kinds.length >= 2) return { ok: true, basis: "independent-sources", kinds };
  return {
    ok: false,
    basis: null,
    kinds,
    reason: pattern?.kind === "mechanical"
      ? `Only ${kinds.join(", ") || "no"} source kind(s) reported this; record a check run reproduced by a sweep, or a confirmation from a different source kind.`
      : `Only ${kinds.join(", ") || "no"} source kind(s) reported this; record a confirmation from a different source kind.`
  };
}

function findDeliveredSession(project, scopeId) {
  for (const record of project.sessions || []) {
    if (record.scopeId !== scopeId) continue;
    const mergeCommit = record.deliveryEvidence?.pr?.mergeCommit;
    if (!mergeCommit) continue;
    return {
      sessionId: record.id,
      pr: record.deliveryEvidence.pr.number ?? record.releaseCertification?.prNumber ?? null,
      mergeCommit
    };
  }
  return null;
}

export function addConfirmation(state, project, findingId, { source, evidence, check = null } = {}) {
  const finding = getFinding(project, findingId);
  const pattern = finding.patternKey ? getPattern(state, finding.patternKey) : null;
  if (!Array.isArray(finding.confirmations)) finding.confirmations = [];
  const entry = {
    source: normalizeSource(source),
    evidence: normalizeEvidence(evidence),
    check: normalizeCheckRun(check, pattern),
    recordedAt: new Date().toISOString()
  };
  finding.confirmations.push(entry);
  finding.updatedAt = entry.recordedAt;
  touch(project);
  return entry;
}

export function setFindingStatus(state, project, findingId, status, { reason = null, confirmation = null } = {}) {
  const finding = getFinding(project, findingId);
  const target = oneOf(status, FINDING_STATUSES, "finding status");
  const pattern = finding.patternKey ? findPattern(state, finding.patternKey) : null;
  if (confirmation) addConfirmation(state, project, finding.id, confirmation);

  if (target === "confirmed") {
    const basis = getConfirmationBasis(finding, pattern);
    if (!basis.ok) throw new Error(`Cannot confirm ${finding.id}: ${basis.reason}`);
  }

  // R2. A dismissal without a stated reason is indistinguishable from neglect.
  let nextReason = null;
  if (REASON_REQUIRED_STATUSES.has(target)) {
    nextReason = text(reason, `Reason for ${target}`);
  }

  if (target === "not_applicable" && pattern) {
    const applicability = getPatternApplicability(project, pattern);
    if (applicability.applicable === "unknown") {
      throw new Error(
        `Cannot mark ${finding.id} not_applicable: ${applicability.reason}. `
        + "An unregistered service is unknown, not irrelevant; register it or record it as unused first."
      );
    }
  }

  // R4. `fixed` is derived from delivery evidence, never asserted.
  let fixedBy = finding.fixedBy;
  if (target === "fixed") {
    if (!finding.scopeId) throw new Error(`Cannot mark ${finding.id} fixed: it has not been promoted to a scope criterion.`);
    const criterion = (project.scope?.criteria || []).find((item) => item.id === finding.scopeId);
    if (!criterion) throw new Error(`Cannot mark ${finding.id} fixed: scope criterion ${finding.scopeId} no longer exists.`);
    if (criterion.status !== "done") throw new Error(`Cannot mark ${finding.id} fixed: scope criterion ${criterion.id} is ${criterion.status}, not done.`);
    const delivered = findDeliveredSession(project, finding.scopeId);
    if (!delivered) throw new Error(`Cannot mark ${finding.id} fixed: no session on ${finding.scopeId} has a delivery merge commit.`);
    fixedBy = delivered;
  }

  finding.status = target;
  finding.reason = nextReason;
  finding.fixedBy = fixedBy;
  finding.updatedAt = new Date().toISOString();
  touch(project);
  return finding;
}

/**
 * R3. Promotion turns a confirmed finding into ordinary scope work. It creates
 * one scope criterion and links it back; it deliberately opens no new execution
 * path of its own.
 */
export function promoteFinding(state, project, findingId) {
  const finding = getFinding(project, findingId);
  if (finding.status !== "confirmed") {
    throw new Error(`Cannot promote ${finding.id}: only a confirmed finding can be promoted (it is ${finding.status}).`);
  }
  if (finding.scopeId) throw new Error(`${finding.id} is already promoted to ${finding.scopeId}.`);
  const label = finding.patternKey ? `${finding.title} [${finding.patternKey}]` : finding.title;
  const criterion = addScopeCriterion(project, `${label} (finding ${finding.id})`, "todo");
  finding.scopeId = criterion.id;
  finding.updatedAt = new Date().toISOString();
  touch(project);
  return { finding, criterion };
}

export function buildFindingsMatrix(state, { patternKey = null } = {}) {
  const patterns = patternKey ? [getPattern(state, patternKey)] : listPatterns(state);
  const projects = Object.values(state.projects || {}).sort((a, b) => a.id.localeCompare(b.id));
  const rows = patterns.map((pattern) => ({
    pattern,
    cells: projects.map((project) => {
      const findings = listFindings(project, { patternKey: pattern.key });
      if (findings.length) {
        const status = CELL_ORDER.find((candidate) => findings.some((item) => item.status === candidate));
        // Collapsing to the loudest status would hide the others, so the cell
        // always carries how many findings sit behind it.
        const counts = {};
        for (const item of findings) counts[item.status] = (counts[item.status] || 0) + 1;
        return {
          projectId: project.id,
          status,
          count: findings.length,
          counts,
          cell: findings.length > 1 ? `${status} (${findings.length})` : status,
          findings: findings.map((item) => item.id),
          reason: null
        };
      }
      const applicability = getPatternApplicability(project, pattern);
      // No finding means no answer yet. R7 forbids reading "unregistered" as "n/a".
      const status = applicability.applicable === "no" ? "n/a" : "unknown";
      return {
        projectId: project.id,
        status,
        count: 0,
        counts: {},
        cell: status,
        findings: [],
        reason: applicability.reason
      };
    })
  }));
  return { patterns, projects: projects.map((project) => ({ id: project.id, name: project.name })), rows };
}

function pad(value, width) {
  const raw = String(value ?? "");
  return raw.length >= width ? `${raw.slice(0, width - 1)}…` : raw.padEnd(width);
}

export function formatPatterns(patterns) {
  const lines = [`SUMI PATTERNS — ${patterns.length}`, "=".repeat(72), `${pad("KEY", 24)} ${pad("ID", 6)} ${pad("KIND", 11)} ${pad("SEV", 7)} TITLE`, "-".repeat(72)];
  if (!patterns.length) return lines.concat("No patterns recorded yet.").join("\n");
  for (const pattern of patterns) {
    lines.push(`${pad(pattern.key, 24)} ${pad(pattern.id, 6)} ${pad(pattern.kind, 11)} ${pad(pattern.severity, 7)} ${pattern.title}`);
  }
  return lines.join("\n");
}

export function formatPattern(pattern) {
  const lines = [
    `PATTERN ${pattern.id} — ${pattern.key}`,
    pattern.title,
    `Kind: ${pattern.kind}`,
    `Severity: ${pattern.severity}`,
    `Origin: ${pattern.origin}`,
    `Applies to: ${pattern.appliesTo?.requires?.length ? `requires ${pattern.appliesTo.requires.join(", ")}` : "every project"}`,
    "",
    "QUESTION",
    `  ${pattern.question}`
  ];
  if (pattern.check) {
    lines.push("", "CHECK", `  argv: ${pattern.check.argv.join(" ")}`, `  cwd: ${pattern.check.cwd} | timeout: ${pattern.check.timeoutMs}ms | expect: ${pattern.check.expect}`);
  } else {
    lines.push("", "CHECK", "  none (judgment pattern; answer the question by reading the code)");
  }
  return lines.join("\n");
}

export function formatFindings(project, findings) {
  const lines = [`FINDINGS — ${project.name} [${project.id}] — ${findings.length}`, "=".repeat(72), `${pad("ID", 6)} ${pad("STATUS", 15)} ${pad("SEV", 7)} ${pad("PATTERN", 22)} TITLE`, "-".repeat(72)];
  if (!findings.length) return lines.concat("No findings recorded for this project.").join("\n");
  for (const finding of findings) {
    lines.push(`${pad(finding.id, 6)} ${pad(finding.status, 15)} ${pad(finding.severity, 7)} ${pad(finding.patternKey || "—", 22)} ${finding.title}`);
  }
  return lines.join("\n");
}

export function formatFinding(project, finding, pattern = null) {
  const basis = getConfirmationBasis(finding, pattern);
  const lines = [
    `FINDING ${finding.id} — ${project.name} [${project.id}]`,
    finding.title,
    `Status: ${finding.status}${finding.reason ? ` (${finding.reason})` : ""}`,
    `Severity: ${finding.severity}`,
    `Pattern: ${finding.patternKey || "—"}`,
    `Scope: ${finding.scopeId || "not promoted"}`,
    `Fixed by: ${finding.fixedBy ? `${finding.fixedBy.sessionId} / PR ${finding.fixedBy.pr ?? "—"} / ${finding.fixedBy.mergeCommit}` : "—"}`,
    `Confirmation: ${basis.ok ? `${basis.basis} (${basis.kinds.join(", ")})` : `insufficient (${basis.kinds.join(", ") || "none"})`}`
  ];
  if (finding.detail) lines.push("", "DETAIL", `  ${finding.detail}`);
  lines.push("", "EVIDENCE");
  for (const entry of finding.confirmations || []) {
    const agent = entry.source?.agent ? `/${entry.source.agent}` : "";
    const run = entry.check ? ` / check ${entry.check.satisfied ? "reproduced" : "not reproduced"}` : "";
    lines.push(`  ${entry.source?.kind}${agent} @ ${entry.evidence?.commit?.slice(0, 12)} ${entry.evidence?.checkedAt}${run}`);
    if (entry.evidence?.files?.length) lines.push(`    files: ${entry.evidence.files.join(", ")}`);
    if (entry.evidence?.output) lines.push(`    output: ${entry.evidence.output.split(/\r?\n/)[0]}${entry.evidence.truncated ? " … (truncated)" : ""}`);
  }
  return lines.join("\n");
}

export function formatFindingsMatrix(matrix) {
  // Wide enough for the longest cell a status plus its count can produce.
  const width = 19;
  const header = `${pad("PATTERN", 24)} ${pad("SEV", 7)} ${matrix.projects.map((project) => pad(project.id, width)).join(" ")}`;
  const lines = [
    `SUMI FINDINGS — ${matrix.rows.length} pattern(s) x ${matrix.projects.length} project(s)`,
    "=".repeat(Math.max(72, header.length)),
    header,
    "-".repeat(Math.max(72, header.length))
  ];
  if (!matrix.rows.length) return lines.concat("No patterns recorded yet.").join("\n");
  if (!matrix.projects.length) return lines.concat("No projects registered yet.").join("\n");
  for (const row of matrix.rows) {
    lines.push(`${pad(row.pattern.key, 24)} ${pad(row.pattern.severity, 7)} ${row.cells.map((cell) => pad(cell.cell, width)).join(" ")}`);
  }
  lines.push(
    "",
    "unknown = not checked yet, or a required service is unregistered. n/a = a required service is recorded as unused.",
    "status (n) = n finding(s) recorded here; the status shown is the loudest one."
  );
  return lines.join("\n");
}
