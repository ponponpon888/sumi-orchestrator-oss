import { touch } from "./domain.js";
import { MERGE_STATUSES, getMergeReadiness } from "./merge.js";
import { getSession } from "./sessions.js";
import { commandExists, mapChecks, runCommand, summarizeChecks } from "./sync.js";

export const RELEASE_STATUSES = {
  READY: "RELEASE_READY",
  MERGE_GATE_REQUIRED: "MERGE_GATE_REQUIRED",
  SYNC_REQUIRED: "RELEASE_SYNC_REQUIRED",
  SYNC_FAILED: "RELEASE_SYNC_FAILED",
  EVIDENCE_STALE: "GITHUB_EVIDENCE_STALE",
  PR_REQUIRED: "PR_REQUIRED",
  PR_NOT_OPEN: "PR_NOT_OPEN",
  PR_DRAFT: "PR_DRAFT",
  PR_HEAD_MISMATCH: "PR_HEAD_MISMATCH",
  CI_FAILED: "CI_FAILED",
  CI_PENDING: "CI_PENDING",
  CI_UNKNOWN: "CI_UNKNOWN",
  GITHUB_CHANGES_REQUESTED: "GITHUB_CHANGES_REQUESTED",
  GITHUB_REVIEW_REQUIRED: "GITHUB_REVIEW_REQUIRED",
  MERGE_CONFLICT: "MERGE_CONFLICT",
  BRANCH_BEHIND: "BRANCH_BEHIND",
  GITHUB_BLOCKED: "GITHUB_BLOCKED",
  MERGEABILITY_UNKNOWN: "MERGEABILITY_UNKNOWN"
};

const STATUS_ORDER = new Map([
  [RELEASE_STATUSES.GITHUB_CHANGES_REQUESTED, 0],
  [RELEASE_STATUSES.CI_FAILED, 1],
  [RELEASE_STATUSES.MERGE_CONFLICT, 2],
  [RELEASE_STATUSES.PR_HEAD_MISMATCH, 3],
  [RELEASE_STATUSES.GITHUB_BLOCKED, 4],
  [RELEASE_STATUSES.GITHUB_REVIEW_REQUIRED, 5],
  [RELEASE_STATUSES.PR_REQUIRED, 6],
  [RELEASE_STATUSES.PR_NOT_OPEN, 7],
  [RELEASE_STATUSES.PR_DRAFT, 8],
  [RELEASE_STATUSES.BRANCH_BEHIND, 9],
  [RELEASE_STATUSES.CI_PENDING, 10],
  [RELEASE_STATUSES.CI_UNKNOWN, 11],
  [RELEASE_STATUSES.MERGEABILITY_UNKNOWN, 12],
  [RELEASE_STATUSES.SYNC_FAILED, 13],
  [RELEASE_STATUSES.EVIDENCE_STALE, 14],
  [RELEASE_STATUSES.SYNC_REQUIRED, 15],
  [RELEASE_STATUSES.MERGE_GATE_REQUIRED, 16],
  [RELEASE_STATUSES.READY, 17]
]);

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

function normalizeMaxAgeMinutes(value) {
  const parsed = Number(value ?? 15);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1440) {
    throw new Error("Release evidence max age must be between 1 and 1440 minutes.");
  }
  return parsed;
}

function reviewSummary(pr) {
  return (Array.isArray(pr?.latestReviews) ? pr.latestReviews : []).map((review) => ({
    state: review.state || null,
    author: review.author?.login || review.author?.name || null,
    submittedAt: review.submittedAt || null
  }));
}

function reviewRequests(pr) {
  return (Array.isArray(pr?.reviewRequests) ? pr.reviewRequests : []).map((request) => ({
    login: request?.login || request?.name || request?.slug || null
  })).filter((item) => item.login);
}

export function normalizeReleasePr(pr) {
  if (!pr) return null;
  const checks = summarizeChecks(pr.statusCheckRollup);
  return {
    number: Number(pr.number),
    title: pr.title || null,
    url: pr.url || null,
    state: String(pr.state || "").toUpperCase() || null,
    draft: Boolean(pr.isDraft),
    headBranch: pr.headRefName || null,
    baseBranch: pr.baseRefName || null,
    headSha: pr.headRefOid || null,
    mergeable: String(pr.mergeable || "UNKNOWN").toUpperCase(),
    mergeState: String(pr.mergeStateStatus || "UNKNOWN").toUpperCase(),
    reviewDecision: pr.reviewDecision ? String(pr.reviewDecision).toUpperCase() : null,
    ci: mapChecks(pr.statusCheckRollup),
    checks,
    latestReviews: reviewSummary(pr),
    reviewRequests: reviewRequests(pr)
  };
}

function selectPr(list, branch, headSha) {
  const rows = (Array.isArray(list) ? list : []).map(normalizeReleasePr);
  return rows.find((pr) => pr.state === "OPEN" && pr.headBranch === branch && (!headSha || pr.headSha === headSha))
    || rows.find((pr) => pr.state === "OPEN" && pr.headBranch === branch)
    || rows.find((pr) => headSha && pr.headSha === headSha)
    || rows[0]
    || null;
}

export function syncReleaseEvidence(project, sessionId, { now = new Date() } = {}) {
  const record = getSession(project, sessionId);
  const merge = getMergeReadiness(project, sessionId);
  const observedAt = asDate(now).toISOString();
  const base = {
    observedAt,
    repo: project.repo || null,
    sessionId: record.id,
    branch: record.workspace?.branch || null,
    expectedHead: merge.head || record.lastReview?.workspace?.head || null,
    source: "gh",
    ok: false,
    error: null,
    pr: null
  };

  if (!project.repo) {
    record.releaseEvidence = { ...base, source: "none", error: "Project repository is not configured." };
    touch(project);
    return record.releaseEvidence;
  }
  if (!record.workspace?.branch) {
    record.releaseEvidence = { ...base, source: "none", error: "Session workspace branch is not available." };
    touch(project);
    return record.releaseEvidence;
  }
  if (!commandExists("gh")) {
    record.releaseEvidence = { ...base, error: "GitHub CLI (gh) is not installed or not resolvable." };
    touch(project);
    return record.releaseEvidence;
  }

  const fields = [
    "number", "title", "url", "state", "isDraft", "headRefName", "baseRefName", "headRefOid",
    "mergeable", "mergeStateStatus", "reviewDecision", "statusCheckRollup", "latestReviews", "reviewRequests"
  ].join(",");
  const result = runCommand("gh", [
    "pr", "list", "--repo", project.repo, "--state", "all", "--head", record.workspace.branch,
    "--limit", "10", "--json", fields
  ], { cwd: record.workspace.path || project.local || undefined, timeout: 30000 });

  if (!result.ok) {
    record.releaseEvidence = { ...base, error: result.stderr || result.error || "GitHub PR lookup failed." };
    touch(project);
    return record.releaseEvidence;
  }

  try {
    const list = JSON.parse(result.stdout || "[]");
    record.releaseEvidence = {
      ...base,
      ok: true,
      pr: selectPr(list, record.workspace.branch, base.expectedHead)
    };
  } catch {
    record.releaseEvidence = { ...base, error: "GitHub CLI returned unreadable PR JSON." };
  }
  touch(project);
  return record.releaseEvidence;
}

function ageMinutes(observedAt, now) {
  if (!observedAt) return Number.POSITIVE_INFINITY;
  const observed = new Date(observedAt);
  if (Number.isNaN(observed.getTime())) return Number.POSITIVE_INFINITY;
  return Math.max(0, (asDate(now).getTime() - observed.getTime()) / 60000);
}

function rowBase(project, record, merge, evidence) {
  const pr = evidence?.pr || null;
  return {
    projectId: project.id,
    projectName: project.name,
    priority: Number(project.priority) || 3,
    sessionId: record.id,
    scopeId: record.scopeId,
    task: record.task,
    worker: record.agent,
    mergeStatus: merge.status,
    head: merge.head || null,
    releaseStatus: null,
    reason: null,
    observedAt: evidence?.observedAt || null,
    repo: project.repo || null,
    prNumber: pr?.number || null,
    prUrl: pr?.url || null,
    prState: pr?.state || null,
    draft: pr?.draft ?? null,
    prHead: pr?.headSha || null,
    ci: pr?.ci || "unknown",
    checks: pr?.checks || [],
    reviewDecision: pr?.reviewDecision || null,
    mergeable: pr?.mergeable || null,
    mergeState: pr?.mergeState || null,
    latestReviews: pr?.latestReviews || [],
    reviewRequests: pr?.reviewRequests || []
  };
}

export function getReleaseReadiness(project, sessionId, { now = new Date(), maxAgeMinutes = 15 } = {}) {
  const maxAge = normalizeMaxAgeMinutes(maxAgeMinutes);
  const record = getSession(project, sessionId);
  const merge = getMergeReadiness(project, sessionId);
  const evidence = record.releaseEvidence || null;
  const base = rowBase(project, record, merge, evidence);

  if (merge.status !== MERGE_STATUSES.READY) {
    return { ...base, releaseStatus: RELEASE_STATUSES.MERGE_GATE_REQUIRED, reason: `Merge Gate is ${merge.status}, not MERGE_READY.` };
  }
  if (!evidence) {
    return { ...base, releaseStatus: RELEASE_STATUSES.SYNC_REQUIRED, reason: "No session-specific GitHub release evidence is stored; run release-status --sync." };
  }
  if (!evidence.ok) {
    return { ...base, releaseStatus: RELEASE_STATUSES.SYNC_FAILED, reason: evidence.error || "GitHub release evidence sync failed." };
  }
  const age = ageMinutes(evidence.observedAt, now);
  if (age > maxAge) {
    return { ...base, releaseStatus: RELEASE_STATUSES.EVIDENCE_STALE, reason: `GitHub release evidence is ${Math.floor(age)} minute(s) old; refresh it before release decisions.` };
  }
  const pr = evidence.pr;
  if (!pr) return { ...base, releaseStatus: RELEASE_STATUSES.PR_REQUIRED, reason: `No pull request was found for session branch ${record.workspace?.branch || "—"}.` };
  if (pr.state !== "OPEN") return { ...base, releaseStatus: RELEASE_STATUSES.PR_NOT_OPEN, reason: `PR #${pr.number} is ${pr.state || "not open"}.` };
  if (pr.draft) return { ...base, releaseStatus: RELEASE_STATUSES.PR_DRAFT, reason: `PR #${pr.number} is still a draft.` };
  if (!pr.headSha || pr.headSha !== merge.head) {
    return { ...base, releaseStatus: RELEASE_STATUSES.PR_HEAD_MISMATCH, reason: `PR #${pr.number} HEAD does not match the locally reviewed MERGE_READY HEAD.` };
  }
  if (pr.ci === "failed") return { ...base, releaseStatus: RELEASE_STATUSES.CI_FAILED, reason: `PR #${pr.number} has failing required/status checks.` };
  if (pr.ci === "pending") return { ...base, releaseStatus: RELEASE_STATUSES.CI_PENDING, reason: `PR #${pr.number} still has pending checks.` };
  if (pr.ci !== "ready") return { ...base, releaseStatus: RELEASE_STATUSES.CI_UNKNOWN, reason: `PR #${pr.number} CI state is ${pr.ci || "unknown"}; release requires positive CI evidence.` };

  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    return { ...base, releaseStatus: RELEASE_STATUSES.GITHUB_CHANGES_REQUESTED, reason: `GitHub review state for PR #${pr.number} is CHANGES_REQUESTED.` };
  }
  if (pr.reviewDecision === "REVIEW_REQUIRED") {
    return { ...base, releaseStatus: RELEASE_STATUSES.GITHUB_REVIEW_REQUIRED, reason: `GitHub reports required review is still outstanding for PR #${pr.number}.` };
  }

  if (pr.mergeable === "CONFLICTING" || pr.mergeState === "DIRTY") {
    return { ...base, releaseStatus: RELEASE_STATUSES.MERGE_CONFLICT, reason: `PR #${pr.number} has merge conflicts.` };
  }
  if (pr.mergeState === "BEHIND") {
    return { ...base, releaseStatus: RELEASE_STATUSES.BRANCH_BEHIND, reason: `PR #${pr.number} is behind its base branch.` };
  }
  if (pr.mergeState === "BLOCKED") {
    return { ...base, releaseStatus: RELEASE_STATUSES.GITHUB_BLOCKED, reason: `GitHub reports PR #${pr.number} is blocked by repository rules or merge requirements.` };
  }
  if (pr.mergeable === "UNKNOWN" || ["UNKNOWN", "UNSTABLE"].includes(pr.mergeState)) {
    return { ...base, releaseStatus: RELEASE_STATUSES.MERGEABILITY_UNKNOWN, reason: `GitHub mergeability for PR #${pr.number} is not conclusively clean yet.` };
  }

  return {
    ...base,
    releaseStatus: RELEASE_STATUSES.READY,
    reason: `MERGE_READY matches open PR #${pr.number}; CI is green and GitHub merge/review state has no blocking condition.`
  };
}

export function getReleaseQueue(projects, { includeAll = false, now = new Date(), maxAgeMinutes = 15 } = {}) {
  const rows = [];
  for (const project of Object.values(projects || {})) {
    if (project.archived) continue;
    for (const record of project.sessions || []) {
      if (record.workspace?.mode !== "worktree") continue;
      if (!includeAll && !record.releaseEvidence && getMergeReadiness(project, record.id).status !== MERGE_STATUSES.READY) continue;
      rows.push(getReleaseReadiness(project, record.id, { now, maxAgeMinutes }));
    }
  }
  return rows.sort((a, b) =>
    (STATUS_ORDER.get(a.releaseStatus) ?? 99) - (STATUS_ORDER.get(b.releaseStatus) ?? 99)
    || a.priority - b.priority
    || a.projectId.localeCompare(b.projectId)
    || a.sessionId.localeCompare(b.sessionId)
  );
}


export function recordReleaseGate(project, sessionId, readiness, { now = new Date() } = {}) {
  const record = getSession(project, sessionId);
  const evaluatedAt = asDate(now).toISOString();
  record.lastReleaseGate = {
    ...readiness,
    checks: (readiness.checks || []).map((item) => ({ ...item })),
    latestReviews: (readiness.latestReviews || []).map((item) => ({ ...item })),
    reviewRequests: (readiness.reviewRequests || []).map((item) => ({ ...item })),
    evaluatedAt
  };
  if (readiness.releaseStatus === RELEASE_STATUSES.READY) {
    record.releaseCertification = {
      certifiedAt: evaluatedAt,
      repo: readiness.repo,
      prNumber: readiness.prNumber,
      prUrl: readiness.prUrl,
      branch: record.workspace?.branch || null,
      head: readiness.head,
      releaseStatus: readiness.releaseStatus
    };
  }
  touch(project);
  return record.lastReleaseGate;
}

export function formatReleaseReadiness(row) {
  const lines = [
    `RELEASE GATE — ${row.projectName} / ${row.sessionId}`,
    `${row.scopeId} ${row.task}`,
    `Decision: ${row.releaseStatus}`,
    `Merge Gate: ${row.mergeStatus}`,
    `Repository: ${row.repo || "—"}`,
    `PR: ${row.prNumber ? `#${row.prNumber}` : "—"}${row.prUrl ? ` ${row.prUrl}` : ""}`,
    `HEAD: local=${row.head || "—"} github=${row.prHead || "—"}`,
    `CI: ${row.ci || "unknown"} | GitHub review: ${row.reviewDecision || "none/optional"}`,
    `Mergeable: ${row.mergeable || "—"} | Merge state: ${row.mergeState || "—"}`,
    `Observed: ${row.observedAt || "—"}`,
    `Reason: ${row.reason}`
  ];
  if (row.checks?.length) {
    lines.push("Checks:");
    for (const check of row.checks) lines.push(`  - ${check.name}: ${check.conclusion || check.status || "unknown"}`);
  }
  if (row.releaseStatus === RELEASE_STATUSES.READY) {
    lines.push("Next: GitHub merge/release remains an explicit action; SUMI has not merged, pushed, or deployed anything.");
  }
  return lines.join("\n");
}

export function formatReleaseQueue(rows) {
  const lines = ["SUMI RELEASE QUEUE", "=".repeat(72)];
  if (!rows.length) return lines.concat("No sessions are currently in the release pipeline.").join("\n");
  for (const row of rows) {
    lines.push(`${row.releaseStatus.padEnd(28)} P${row.priority} ${row.projectName} [${row.projectId}] ${row.sessionId} ${row.scopeId}`);
    lines.push(`  ${row.prNumber ? `PR #${row.prNumber} | ` : ""}${row.task}`);
    lines.push(`  ${row.reason}`);
  }
  return lines.join("\n");
}
