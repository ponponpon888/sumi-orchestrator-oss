import { ensureProjectShape, setDeployment, setScopeCriterionStatus, touch } from "./domain.js";
import { DELIVERY_STATUSES, getDeliveryReadiness } from "./delivery.js";
import { cleanupSessionWorkspace, getSession } from "./sessions.js";

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

function nextReleaseId(project) {
  const seq = (project.releases || []).reduce((max, item) => {
    const match = String(item.id || "").match(/^R(\d+)$/i);
    return Math.max(max, match ? Number(match[1]) : 0);
  }, 0) + 1;
  return `R${String(seq).padStart(3, "0")}`;
}

function criterion(project, scopeId) {
  ensureProjectShape(project);
  return project.scope.criteria.find((item) => item.id === scopeId) || null;
}

function verificationChecks(record) {
  return (record.lastReview?.checks || []).map((item) => ({
    id: item.id || null,
    label: item.label || item.id || null,
    ok: Boolean(item.ok)
  }));
}

function releaseSnapshot(project, record, gate, deliveredAt) {
  const certification = record.releaseCertification || {};
  const verification = record.deliveryVerification || {};
  const reviewer = record.lastReviewerResult || {};
  const githubGate = record.lastReleaseGate || {};
  return {
    id: nextReleaseId(project),
    projectId: project.id,
    projectName: project.name,
    priority: Number(project.priority) || 3,
    sessionId: record.id,
    scopeId: record.scopeId,
    task: record.task,
    worker: record.agent || null,
    reviewer: reviewer.agent || null,
    reviewerVerdict: reviewer.verdict || null,
    reviewedHead: reviewer.reviewedHead || null,
    repo: project.repo || certification.repo || null,
    branch: certification.branch || record.workspace?.branch || null,
    prNumber: gate.prNumber || certification.prNumber || null,
    prUrl: gate.prUrl || certification.prUrl || null,
    certifiedHead: gate.certifiedHead || certification.head || null,
    mergedHead: gate.mergedHead || null,
    mergeCommit: gate.mergeCommit || null,
    mergedAt: gate.mergedAt || null,
    releaseCertifiedAt: certification.certifiedAt || null,
    githubGateAt: githubGate.evaluatedAt || null,
    ci: githubGate.ci || null,
    githubReviewDecision: githubGate.reviewDecision || null,
    productionStatus: gate.productionStatus || null,
    productionUrl: gate.productionUrl || null,
    productionVerifiedAt: verification.verifiedAt || gate.verifiedAt || null,
    productionVerificationNote: verification.note || null,
    deliveryEvidenceObservedAt: gate.observedAt || null,
    verificationChecks: verificationChecks(record),
    deliveredAt,
    workspaceCleanup: null
  };
}

function cleanupIfRequested(project, record, requested, now) {
  if (!requested) return { requested: false, status: "retained", reason: "Cleanup not requested." };
  if (record.workspace?.mode !== "worktree" || !record.workspace?.created) {
    return { requested: true, status: "not_applicable", reason: "Session does not own a SUMI-created worktree." };
  }
  try {
    const outcome = cleanupSessionWorkspace(project, record.id, { now });
    return {
      requested: true,
      status: "removed",
      removedAt: record.workspace?.removedAt || null,
      alreadyRemoved: Boolean(outcome.alreadyRemoved),
      missing: Boolean(outcome.missing)
    };
  } catch (error) {
    // Delivery finalization must not destroy or discard local work. A dirty or
    // otherwise unsafe worktree is retained and can be cleaned up explicitly.
    return { requested: true, status: "retained", reason: error.message };
  }
}

export function finalizeDeliveredSession(project, sessionId, {
  cleanup = false,
  now = new Date(),
  maxAgeMinutes = 15
} = {}) {
  ensureProjectShape(project);
  const current = asDate(now);
  const record = getSession(project, sessionId);
  const existing = project.releases.find((item) => item.sessionId === record.id) || null;

  if (existing) {
    const cleanupResult = cleanupIfRequested(project, record, cleanup, current);
    if (cleanup) existing.workspaceCleanup = { ...cleanupResult };
    touch(project);
    return { release: existing, session: record, criterion: criterion(project, record.scopeId), alreadyFinalized: true, cleanup: cleanupResult };
  }

  const gate = getDeliveryReadiness(project, record.id, { now: current, maxAgeMinutes });
  if (gate.status !== DELIVERY_STATUSES.DELIVERED) {
    throw new Error(`Cannot finalize delivery while Delivery Gate is ${gate.status}.`);
  }

  const item = criterion(project, record.scopeId);
  if (!item) throw new Error(`Scope criterion not found: ${record.scopeId}`);
  if (item.status === "cancelled") throw new Error(`Cannot finalize delivered session ${record.id}; ${item.id} is cancelled.`);

  const conflicting = project.sessions.find((entry) => entry.id !== record.id && entry.scopeId === record.scopeId && entry.status === "active");
  if (conflicting) throw new Error(`Cannot finalize ${record.id}; ${item.id} has newer active session ${conflicting.id}.`);
  if (item.claim && item.claim.sessionId !== record.id) {
    const claimant = item.claim.sessionId ? `session ${item.claim.sessionId}` : (item.claim.owner || item.claim.agent || "another worker");
    throw new Error(`Cannot finalize ${record.id}; ${item.id} is claimed by ${claimant}.`);
  }

  const deliveredAt = current.toISOString();
  const release = releaseSnapshot(project, record, gate, deliveredAt);
  const previousSessionStatus = record.status;

  if (item.status !== "done") setScopeCriterionStatus(project, item.id, "done");
  if (record.status !== "completed") {
    record.status = "completed";
    record.endedAt ||= deliveredAt;
    record.claimReleased = true;
  }
  record.deliveryFinalizedAt = deliveredAt;
  record.finalizedFromSessionStatus = previousSessionStatus;
  record.releaseRecordId = release.id;
  project.releases.push(release);

  // Reconcile project-level deployment state with the exact artifact that was
  // certified and verified. This lets the dashboard's completion semantics use
  // the same evidence chain as the delivery lifecycle.
  setDeployment(project, {
    commit: release.mergeCommit || project.deployment?.commit || null,
    pr: release.prNumber || project.deployment?.pr || null,
    ci: "ready",
    production: "verified"
  });
  if (release.productionVerifiedAt) project.deployment.productionCheckedAt = release.productionVerifiedAt;

  const cleanupResult = cleanupIfRequested(project, record, cleanup, current);
  release.workspaceCleanup = { ...cleanupResult };
  touch(project);
  return { release, session: record, criterion: item, alreadyFinalized: false, cleanup: cleanupResult };
}

export function getReleaseHistory(projects, { projectId = null, limit = 50 } = {}) {
  const parsedLimit = Number(limit ?? 50);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 1000) {
    throw new Error("Release history limit must be an integer between 1 and 1000.");
  }
  const rows = [];
  for (const project of Object.values(projects || {})) {
    ensureProjectShape(project);
    if (projectId && project.id !== projectId) continue;
    for (const release of project.releases) rows.push({ ...release, projectId: project.id, projectName: project.name });
  }
  return rows
    .sort((a, b) => String(b.deliveredAt || "").localeCompare(String(a.deliveredAt || "")) || String(b.id).localeCompare(String(a.id)))
    .slice(0, parsedLimit);
}

export function formatReleaseFinalization(project, outcome) {
  const { release, session, criterion: item, cleanup, alreadyFinalized } = outcome;
  return [
    `DELIVERY FINALIZED — ${project.name} / ${session.id}`,
    `${item?.id || session.scopeId} ${session.task}`,
    `Release record: ${release.id}${alreadyFinalized ? " [existing]" : ""}`,
    `Scope: ${item?.status || "—"} | Session: ${session.status}`,
    `PR: ${release.prNumber ? `#${release.prNumber}` : "—"}${release.prUrl ? ` ${release.prUrl}` : ""}`,
    `Merge commit: ${release.mergeCommit || "—"}`,
    `Production: ${release.productionStatus || "—"}${release.productionUrl ? ` ${release.productionUrl}` : ""}`,
    `Delivered: ${release.deliveredAt}`,
    `Worktree cleanup: ${cleanup.status}${cleanup.reason ? ` — ${cleanup.reason}` : ""}`,
    "Result: release history is immutable-by-convention; scope/session lifecycle is closed."
  ].join("\n");
}

export function formatReleaseHistory(rows) {
  const lines = ["SUMI RELEASE HISTORY", "=".repeat(72), `Entries: ${rows.length}`, ""];
  if (!rows.length) return lines.concat("No finalized deliveries recorded.").join("\n");
  for (const row of rows) {
    lines.push(`${row.deliveredAt || "—"} ${row.projectName} [${row.projectId}] ${row.id} ${row.scopeId}`);
    lines.push(`  ${row.prNumber ? `PR #${row.prNumber} | ` : ""}${row.mergeCommit ? `${String(row.mergeCommit).slice(0, 12)} | ` : ""}${row.task}`);
    lines.push(`  Production: ${row.productionUrl || "—"} | Verified: ${row.productionVerifiedAt || "—"}`);
  }
  return lines.join("\n");
}
