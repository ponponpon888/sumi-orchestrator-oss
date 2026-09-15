import { ensureProjectShape } from "./domain.js";
import { classifyAction } from "./next.js";

function byNewest(a, b) {
  return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
}


function relevantEvidenceKeys(criterion) {
  const key = classifyAction(criterion?.text);
  if (key === "ci-baseline" || key === "ci-billing") return new Set(["github-billing", "baseline-test-diff", "full-tests"]);
  if (key === "pr-review-merge") return new Set(["pr-mergeable", "typecheck", "build", "focused-tests", "lint", "diff-check", "full-tests", "baseline-test-diff", "github-billing", "preview-cancel"]);
  if (key === "preview-cancel-reason") return new Set(["preview-cancel"]);
  if (key === "browser-verification") return new Set(["browser-verification"]);
  if (key === "production-smoke") return new Set(["production-smoke"]);
  return null;
}

function findCriterion(project, scopeId) {
  ensureProjectShape(project);
  const id = String(scopeId || "").toUpperCase();
  return project.scope.criteria.find((item) => item.id === id) || null;
}

export function listAgentResults(project, { scopeId = null, agent = null, limit = 20 } = {}) {
  ensureProjectShape(project);
  let rows = [...project.agentResults].sort(byNewest);
  if (scopeId) rows = rows.filter((item) => item.scopeId === String(scopeId).toUpperCase());
  if (agent) rows = rows.filter((item) => String(item.agent || "").toLowerCase() === String(agent).toLowerCase());
  const n = Number(limit);
  if (Number.isFinite(n) && n > 0) rows = rows.slice(0, n);
  return rows;
}

export function getAgentResult(project, resultId) {
  ensureProjectShape(project);
  const id = String(resultId || "").toUpperCase();
  return project.agentResults.find((item) => item.id === id) || null;
}

export function getEvidenceLedger(project, scopeId) {
  ensureProjectShape(project);
  const criterion = findCriterion(project, scopeId);
  if (!criterion) throw new Error(`Scope criterion not found: ${scopeId}`);

  const resultRows = [...project.agentResults]
    .filter((item) => {
      if (item.scopeId === criterion.id) return true;
      if ((item.statusChanges || []).some((change) => change.criterionId === criterion.id)) return true;
      if ((item.scopeSuggestions || []).some((suggestion) => suggestion.existingCriterionId === criterion.id)) return true;
      return false;
    })
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));

  const events = [];
  const allowedEvidence = relevantEvidenceKeys(criterion);
  for (const result of resultRows) {
    const isTargetResult = result.scopeId === criterion.id;
    for (const item of result.evidence || []) {
      if (!isTargetResult && allowedEvidence && !allowedEvidence.has(item.key)) continue;
      events.push({
        type: "evidence",
        resultId: result.id,
        agent: result.agent,
        at: result.createdAt,
        label: item.label,
        detail: item.detail || ""
      });
    }
    if (result.targetDisposition && result.scopeId === criterion.id) {
      events.push({
        type: "disposition",
        resultId: result.id,
        agent: result.agent,
        at: result.createdAt,
        action: result.targetDisposition.action,
        reason: result.targetDisposition.reason
      });
    }
    for (const change of result.statusChanges || []) {
      if (change.criterionId !== criterion.id) continue;
      events.push({
        type: "status-change",
        resultId: result.id,
        agent: result.agent,
        at: result.createdAt,
        from: change.from,
        to: change.to,
        confidence: change.confidence,
        reason: change.reason,
        applied: Boolean((result.appliedChanges || []).some((x) => x.criterionId === criterion.id && x.to === change.to))
      });
    }
  }

  return { criterion, results: resultRows, events };
}

export function formatResultList(project, rows) {
  const lines = [`RESULT HISTORY — ${project.name}`, `Results: ${rows.length}`, ""];
  if (!rows.length) return [...lines, "No agent results found."].join("\n");
  for (const item of rows) {
    const disposition = item.targetDisposition?.action || "—";
    lines.push(`${item.id}  ${item.scopeId || "—"}  ${(item.agent || "unknown").padEnd(12)} ${disposition}`);
    lines.push(`  ${item.createdAt || "—"} / evidence ${item.evidence?.length || 0} / changes ${item.statusChanges?.length || 0}`);
  }
  return lines.join("\n");
}

export function formatResultDetail(project, item) {
  if (!item) return "Result not found.";
  const lines = [
    `RESULT — ${project.name} / ${item.id}`,
    `Scope: ${item.scopeId || "—"}`,
    `Agent: ${item.agent || "unknown"}`,
    `Created: ${item.createdAt || "—"}`,
    `Disposition: ${item.targetDisposition?.action || "—"}`,
    item.targetDisposition?.reason ? `Reason: ${item.targetDisposition.reason}` : null,
    ""
  ].filter(Boolean);

  lines.push("EVIDENCE");
  if (!(item.evidence || []).length) lines.push("  なし");
  for (const ev of item.evidence || []) lines.push(`  ✓ ${ev.label}${ev.detail ? ` — ${ev.detail}` : ""}`);
  lines.push("");

  lines.push("STATUS CHANGES");
  if (!(item.statusChanges || []).length) lines.push("  なし");
  for (const change of item.statusChanges || []) {
    const applied = (item.appliedChanges || []).some((x) => x.criterionId === change.criterionId && x.to === change.to);
    lines.push(`  ${change.criterionId}: ${change.from} -> ${change.to} [${String(change.confidence || "").toUpperCase()}]${applied ? " APPLIED" : ""}`);
    lines.push(`    ${change.reason}`);
  }
  lines.push("");

  lines.push("BLOCKERS");
  if (!(item.blockers || []).length) lines.push("  なし");
  for (const blocker of item.blockers || []) lines.push(`  ! ${blocker.text}${blocker.reason ? ` — ${blocker.reason}` : ""}`);
  lines.push("");

  lines.push("RAW RESULT");
  lines.push(item.rawText || "");
  return lines.join("\n");
}

export function formatEvidenceLedger(project, ledger) {
  const { criterion, results, events } = ledger;
  const lines = [
    `EVIDENCE LEDGER — ${project.name} / ${criterion.id}`,
    `Gate: ${criterion.text}`,
    `Current status: ${criterion.status}`,
    `Source results: ${results.length}`,
    ""
  ];

  if (!events.length) {
    lines.push("No recorded evidence for this gate yet.");
    return lines.join("\n");
  }

  for (const event of events) {
    const prefix = `${event.resultId} ${event.agent || "unknown"}`;
    if (event.type === "evidence") {
      lines.push(`EVIDENCE  ${prefix}`);
      lines.push(`  ✓ ${event.label}${event.detail ? ` — ${event.detail}` : ""}`);
    } else if (event.type === "disposition") {
      lines.push(`DECISION  ${prefix}`);
      lines.push(`  ${event.action}: ${event.reason}`);
    } else if (event.type === "status-change") {
      lines.push(`STATUS    ${prefix}`);
      lines.push(`  ${event.from} -> ${event.to} [${String(event.confidence || "").toUpperCase()}]${event.applied ? " APPLIED" : ""}`);
      lines.push(`  ${event.reason}`);
    }
  }

  return lines.join("\n");
}
