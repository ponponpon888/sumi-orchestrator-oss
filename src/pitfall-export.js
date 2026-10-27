import fs from "node:fs";
import path from "node:path";
import { getConfirmationBasis, getFinding, getPattern } from "./findings.js";
import { mapPitfallRecord } from "./pattern-import.js";

/**
 * Pitfall export turns a SUMI finding back into a draft record for the
 * ai-workforce pitfall database (data/app-pitfalls/<id>.json, schema_version 1)
 * — the other half of `pattern import`.
 *
 * The draft is for a person to read, edit and submit. SUMI never publishes it.
 * What SUMI cannot vouch for is left out or marked, never filled in:
 * - `confidence: measured` only when a sweep reproduced the check; the date is
 *   the day it ran. Corroboration by two kinds of source is not a measurement.
 * - Every environment field is "unrecorded": SUMI did not record them.
 * - The finding's evidence output is never copied. A check that looks for a
 *   leaked key prints the line that holds it.
 * - An open hole is exported only when the person says it may be published
 *   (`openOk`), never at high severity: holes in personal data or permissions
 *   are published after they are closed.
 */

const RECORD_ID = /^[a-z][a-z0-9]*-[0-9]{3}$/;
const TITLE_MAX = 100;

function day(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function reproducedRun(finding) {
  return (finding.confirmations || []).find((item) => item.source?.kind === "sweep" && item.check?.satisfied === true) || null;
}

export function exportFindingAsPitfall(state, project, findingId, {
  id,
  title = null,
  summary = null,
  whyNotClosed = null,
  openOk = false
} = {}) {
  const finding = getFinding(project, findingId);
  const pattern = finding.patternKey ? getPattern(state, finding.patternKey) : null;
  const notes = [];

  if (!RECORD_ID.test(String(id || ""))) {
    throw new Error(`--id must be a pitfall record id like rls-005 (${RECORD_ID}).`);
  }
  if (!["confirmed", "fixed"].includes(finding.status)) {
    throw new Error(`Cannot export ${finding.id}: only a confirmed or fixed finding becomes a record (it is ${finding.status}).`);
  }
  const open = finding.status === "confirmed";
  if (open) {
    if (finding.severity === "high") {
      throw new Error(`Cannot export ${finding.id}: it is open and high severity. Close it first — holes in personal data or permissions are published after they are fixed.`);
    }
    if (!openOk) {
      throw new Error(`Cannot export ${finding.id}: it is still open. Pass --open-ok only if it touches neither personal data nor permissions, and give --why-not-closed.`);
    }
    if (!clean(whyNotClosed)) throw new Error(`Cannot export ${finding.id}: an open record needs --why-not-closed.`);
  }

  const recordTitle = clean(title) || clean(finding.title);
  if (recordTitle.length > TITLE_MAX) {
    throw new Error(`The title is ${recordTitle.length} characters; records allow ${TITLE_MAX}. Give a shorter one with --title.`);
  }
  const recordSummary = clean(summary) || clean(finding.detail) || clean(pattern?.summary);
  if (!recordSummary) throw new Error(`Cannot export ${finding.id}: it has no detail to use as the summary; give --summary.`);

  const record = {
    id,
    title: recordTitle,
    summary: recordSummary,
    layer: "app",
    kind: "trap",
    severity: finding.severity,
    confidence: "unverified",
    origin: "record"
  };

  const basis = getConfirmationBasis(finding, pattern);
  const run = reproducedRun(finding);
  if (basis.ok && basis.basis === "mechanical-check" && run && day(run.check.ranAt)) {
    const evidence = run.evidence || finding.evidence || {};
    record.confidence = "measured";
    record.measured_on = day(run.check.ranAt);
    record.environment = {
      os: "unrecorded",
      shell: "unrecorded",
      shell_version: "unrecorded",
      claude_code_version: "unrecorded",
      node_version: "unrecorded"
    };
    record.repro = [
      `SUMI sweep ran the check of pattern ${pattern.key}: ${run.check.argv.join(" ")}`,
      `It exited ${run.check.exitCode ?? "?"}, which the pattern reads as reproduced`,
      ...(evidence.commit ? [`At commit ${String(evidence.commit).slice(0, 12)} of the swept project`] : []),
      ...((evidence.files || []).length ? [`Files: ${evidence.files.slice(0, 10).join(", ")}${evidence.files.length > 10 ? ` (+${evidence.files.length - 10})` : ""}`] : [])
    ];
    notes.push("confidence is measured: a sweep reproduced the check. The environment fields are unrecorded — fill them in only from a record of that run.");
    notes.push("The check's output is not copied into repro (it can hold the very secret it found). Describe what came back in your own words if it matters.");
  } else {
    notes.push(`confidence is unverified: ${basis.ok ? `confirmed by ${basis.basis}, which is not a measurement` : "no sweep reproduced it"}. Change it only with a measurement, a source or an inference you can name.`);
  }

  if (open) {
    record.status = "open_recorded";
    record.why_not_closed = clean(whyNotClosed);
  } else {
    const by = finding.fixedBy || {};
    record.status = "closed";
    record.fix = `Fixed by ${by.pr ? `PR #${by.pr}` : "a delivered change"}${by.mergeCommit ? ` (merge commit ${String(by.mergeCommit).slice(0, 12)})` : ""}; SUMI recorded the delivery in session ${by.sessionId || "?"}. Say what the change did.`;
    notes.push("fix names the PR only. Replace the last sentence with what the change actually did.");
  }

  record.detection = {
    checkable: false,
    kind: "manual",
    note: pattern
      ? `Found by SUMI pattern ${pattern.key}${pattern.check ? " with its bundled or registered check" : " as a judgment question"}; a SUMI sweep re-runs it.`
      : "Recorded from a SUMI finding without a pattern."
  };
  if (pattern?.source?.kind === "pitfall-record" && pattern.source.id && pattern.source.id !== id) {
    record.related = [pattern.source.id];
  }
  const services = pattern?.appliesTo?.requires || [];
  record.tags = [...new Set(["sumi", ...services])];

  // The draft must be something `pattern import` would take back.
  const check = mapPitfallRecord(record, { file: `${id}.json` });
  if (check.invalid) throw new Error(`The draft is not a valid record: ${check.invalid.problems.join("; ")}`);

  notes.push("This is a draft. Read it and edit it, put it in ai-workforce data/app-pitfalls/, run `node kit/scripts/validate-pitfalls.mjs` and `node kit/scripts/build-pitfall-index.mjs`, and submit it yourself.");
  return { record, notes, open };
}

export function serializePitfallRecord(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** Write <dir>/<id>.json (or the given .json path); never overwrites. */
export function writePitfallRecord(record, out) {
  const target = out.toLowerCase().endsWith(".json") ? out : path.join(out, `${record.id}.json`);
  if (path.basename(target) !== `${record.id}.json`) throw new Error(`The file must be named ${record.id}.json.`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, serializePitfallRecord(record), { encoding: "utf8", flag: "wx" });
  return target;
}
