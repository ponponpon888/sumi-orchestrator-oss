import { ensureProjectShape } from "./domain.js";
import { getSession, inspectSessionWorkspace } from "./sessions.js";
import { SESSION_REVIEW_STATUSES } from "./review.js";

export const MERGE_STATUSES = {
  READY: "MERGE_READY",
  REVIEW_GATE_REQUIRED: "REVIEW_GATE_REQUIRED",
  REVIEW_GATE_BLOCKED: "REVIEW_GATE_BLOCKED",
  INDEPENDENT_REVIEW_REQUIRED: "INDEPENDENT_REVIEW_REQUIRED",
  CHANGES_REQUIRED: "CHANGES_REQUIRED",
  REVIEW_INCONCLUSIVE: "REVIEW_INCONCLUSIVE",
  STALE: "STALE"
};

function criterion(project, scopeId) {
  ensureProjectShape(project);
  return project.scope.criteria.find((item) => item.id === scopeId) || null;
}

export function getMergeReadiness(project, sessionId) {
  const record = getSession(project, sessionId);
  const gate = record.lastReview || null;
  const scope = criterion(project, record.scopeId);
  const base = {
    projectId: project.id,
    projectName: project.name,
    priority: Number(project.priority) || 3,
    sessionId: record.id,
    sessionStatus: record.status,
    scopeId: record.scopeId,
    scopeStatus: scope?.status || null,
    task: record.task,
    worker: record.agent,
    reviewer: record.lastReviewerResult?.agent || null,
    verdict: record.lastReviewerResult?.verdict || null,
    head: gate?.workspace?.head || null,
    reason: null,
    status: null
  };

  if (!gate) return { ...base, status: MERGE_STATUSES.REVIEW_GATE_REQUIRED, reason: "Session has no Review Gate result." };
  if (gate.status !== SESSION_REVIEW_STATUSES.READY) {
    return { ...base, status: MERGE_STATUSES.REVIEW_GATE_BLOCKED, reason: `Review Gate is ${gate.status}, not REVIEW_READY.` };
  }

  const inspection = inspectSessionWorkspace(project, record.id);
  if (!inspection.exists || !inspection.git || inspection.dirty || inspection.head !== gate.workspace?.head || inspection.branch !== gate.workspace?.branch) {
    return { ...base, status: MERGE_STATUSES.STALE, reason: "Workspace changed after the Review Gate; rerun session review --run-checks." };
  }

  const reviewer = record.lastReviewerResult;
  if (!reviewer || reviewer.reviewedHead !== inspection.head) {
    return { ...base, status: MERGE_STATUSES.INDEPENDENT_REVIEW_REQUIRED, head: inspection.head, reason: "Current HEAD has no independent reviewer verdict." };
  }
  if (reviewer.verdict === "CHANGES_REQUIRED") {
    return { ...base, status: MERGE_STATUSES.CHANGES_REQUIRED, head: inspection.head, reason: `${reviewer.agent} requested changes for the current HEAD.` };
  }
  if (reviewer.verdict !== "MERGEABLE") {
    return { ...base, status: MERGE_STATUSES.REVIEW_INCONCLUSIVE, head: inspection.head, reason: `${reviewer.agent} did not return a conclusive MERGEABLE verdict.` };
  }
  return { ...base, status: MERGE_STATUSES.READY, head: inspection.head, reason: `Review Gate passed and ${reviewer.agent} marked the same HEAD MERGEABLE.` };
}

const STATUS_ORDER = new Map([
  [MERGE_STATUSES.CHANGES_REQUIRED, 0],
  [MERGE_STATUSES.STALE, 1],
  [MERGE_STATUSES.REVIEW_GATE_BLOCKED, 2],
  [MERGE_STATUSES.INDEPENDENT_REVIEW_REQUIRED, 3],
  [MERGE_STATUSES.REVIEW_INCONCLUSIVE, 4],
  [MERGE_STATUSES.READY, 5],
  [MERGE_STATUSES.REVIEW_GATE_REQUIRED, 6]
]);

export function getMergeQueue(projects, { includeAll = false } = {}) {
  const rows = [];
  for (const project of Object.values(projects || {})) {
    ensureProjectShape(project);
    if (project.archived) continue;
    for (const record of project.sessions || []) {
      if (!includeAll && !record.lastReview && !record.lastReviewerResult) continue;
      if (record.workspace?.mode !== "worktree") continue;
      rows.push(getMergeReadiness(project, record.id));
    }
  }
  return rows.sort((a, b) =>
    (STATUS_ORDER.get(a.status) ?? 99) - (STATUS_ORDER.get(b.status) ?? 99)
    || a.priority - b.priority
    || a.projectId.localeCompare(b.projectId)
    || a.sessionId.localeCompare(b.sessionId)
  );
}

export function formatMergeReadiness(row) {
  return [
    `MERGE READINESS — ${row.projectName} / ${row.sessionId}`,
    `${row.scopeId} ${row.task}`,
    `Decision: ${row.status}`,
    `Scope: ${row.scopeStatus || "—"} | Session: ${row.sessionStatus}`,
    `Worker: ${row.worker} | Reviewer: ${row.reviewer || "—"}`,
    `HEAD: ${row.head || "—"}`,
    `Reason: ${row.reason}`,
    row.status === MERGE_STATUSES.READY ? "Next: merge remains an explicit human/GitHub action; SUMI has not merged or pushed anything." : null
  ].filter(Boolean).join("\n");
}

export function formatMergeQueue(rows) {
  const lines = ["SUMI MERGE QUEUE", "=".repeat(72)];
  if (!rows.length) return lines.concat("No sessions are currently in the merge/review pipeline.").join("\n");
  for (const row of rows) {
    lines.push(`${row.status.padEnd(28)} P${row.priority} ${row.projectName} [${row.projectId}] ${row.sessionId} ${row.scopeId}`);
    lines.push(`  ${row.task}`);
    lines.push(`  ${row.reason}`);
  }
  return lines.join("\n");
}
