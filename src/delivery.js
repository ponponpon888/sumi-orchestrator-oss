import { getServiceState, touch } from "./domain.js";
import { getSession } from "./sessions.js";
import { createGithubApi, getPull, getVercelStatuses, pullState } from "./github.js";
import { classifyVercelStatus } from "./health.js";
import { commandExists, mapVercelStatus, parseVercelList, runCommand } from "./sync.js";

export const DELIVERY_STATUSES = {
  DELIVERED: "DELIVERED",
  RELEASE_CERTIFICATION_REQUIRED: "RELEASE_CERTIFICATION_REQUIRED",
  SYNC_REQUIRED: "DELIVERY_SYNC_REQUIRED",
  SYNC_FAILED: "DELIVERY_SYNC_FAILED",
  EVIDENCE_STALE: "DELIVERY_EVIDENCE_STALE",
  PR_NOT_MERGED: "PR_NOT_MERGED",
  MERGED_HEAD_MISMATCH: "MERGED_HEAD_MISMATCH",
  MERGE_COMMIT_UNKNOWN: "MERGE_COMMIT_UNKNOWN",
  PRODUCTION_EVIDENCE_REQUIRED: "PRODUCTION_EVIDENCE_REQUIRED",
  PRODUCTION_FAILED: "PRODUCTION_FAILED",
  PRODUCTION_PENDING: "PRODUCTION_PENDING",
  PRODUCTION_CANCELLED: "PRODUCTION_CANCELLED",
  PRODUCTION_UNKNOWN: "PRODUCTION_UNKNOWN",
  VERIFICATION_REQUIRED: "PRODUCTION_VERIFICATION_REQUIRED"
};

const STATUS_ORDER = new Map([
  [DELIVERY_STATUSES.MERGED_HEAD_MISMATCH, 0],
  [DELIVERY_STATUSES.PRODUCTION_FAILED, 1],
  [DELIVERY_STATUSES.SYNC_FAILED, 2],
  [DELIVERY_STATUSES.PR_NOT_MERGED, 3],
  [DELIVERY_STATUSES.MERGE_COMMIT_UNKNOWN, 4],
  [DELIVERY_STATUSES.PRODUCTION_EVIDENCE_REQUIRED, 5],
  [DELIVERY_STATUSES.PRODUCTION_CANCELLED, 6],
  [DELIVERY_STATUSES.PRODUCTION_PENDING, 7],
  [DELIVERY_STATUSES.PRODUCTION_UNKNOWN, 8],
  [DELIVERY_STATUSES.VERIFICATION_REQUIRED, 9],
  [DELIVERY_STATUSES.EVIDENCE_STALE, 10],
  [DELIVERY_STATUSES.SYNC_REQUIRED, 11],
  [DELIVERY_STATUSES.RELEASE_CERTIFICATION_REQUIRED, 12],
  [DELIVERY_STATUSES.DELIVERED, 13]
]);

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

function maxAge(value) {
  const parsed = Number(value ?? 15);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1440) throw new Error("Delivery evidence max age must be between 1 and 1440 minutes.");
  return parsed;
}

function ageMinutes(value, now) {
  if (!value) return Number.POSITIVE_INFINITY;
  const observed = new Date(value);
  if (Number.isNaN(observed.getTime())) return Number.POSITIVE_INFINITY;
  return Math.max(0, (asDate(now).getTime() - observed.getTime()) / 60000);
}

function parseMergeCommit(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.oid || value.sha || null;
}

/**
 * Without the Vercel CLI: the status Vercel's Git integration posted on the
 * merge commit. On the production branch, "Deployment has completed" is the
 * production deployment of that commit. A deploy skipped by Ignored Build
 * Step did not ship this commit, so it is never READY.
 */
function productionFromGithubStatus(api, repo, sha, projectName) {
  const read = getVercelStatuses(api, repo, sha);
  if (!read.ok) return { status: "unknown", rawStatus: null, url: null, environment: "Production", source: "github-status", error: read.error };
  const wanted = String(projectName || "").toLowerCase();
  const named = read.data.filter((status) => {
    const match = String(status.context).match(/^vercel\s*[–—-]\s*(.+)$/i);
    return Boolean(match && match[1].trim().toLowerCase() === wanted);
  });
  const pick = named.length === 1 ? named[0] : read.data.length === 1 ? read.data[0] : null;
  if (!pick) {
    return {
      status: "unknown", rawStatus: null, url: null, environment: "Production", source: "github-status",
      error: read.data.length ? `several Vercel statuses on ${sha.slice(0, 12)} and none names ${projectName}` : `no Vercel status on ${sha.slice(0, 12)}`
    };
  }
  const kind = classifyVercelStatus(pick);
  const status = { deployed: "ready", pending: "pending", failed: "failed", canceled: "cancelled" }[kind] || "unknown";
  return { status, rawStatus: pick.description || pick.state || null, url: pick.url || null, environment: "Production", source: "github-status", context: pick.context };
}

function productionFromVercel(text) {
  const rows = parseVercelList(text);
  const row = rows.find((item) => String(item.environment || "").toLowerCase() === "production") || rows.find((item) => item.url) || rows[0] || null;
  if (!row) return null;
  return {
    status: mapVercelStatus(row.status),
    rawStatus: row.status || null,
    url: row.url || null,
    environment: row.environment || "Production"
  };
}

export function syncDeliveryEvidence(project, sessionId, { now = new Date(), githubApi = null, vercelCliAvailable = null } = {}) {
  const record = getSession(project, sessionId);
  const certification = record.releaseCertification || null;
  const observedAt = asDate(now).toISOString();
  const evidence = {
    observedAt,
    sessionId: record.id,
    repo: project.repo || certification?.repo || null,
    source: { github: false, production: false },
    ok: false,
    error: null,
    pr: null,
    production: null
  };

  if (!certification) {
    evidence.error = "Session has no RELEASE_READY certification.";
    record.deliveryEvidence = evidence; touch(project); return evidence;
  }
  if (!evidence.repo) {
    evidence.error = "Project repository is not configured.";
    record.deliveryEvidence = evidence; touch(project); return evidence;
  }
  if (!githubApi && !commandExists("gh")) {
    evidence.error = "GitHub CLI (gh) is not installed or not resolvable.";
    record.deliveryEvidence = evidence; touch(project); return evidence;
  }
  const api = githubApi || createGithubApi();

  // REST (`gh api`), not `gh pr view` (GraphQL).
  let prResult;
  try {
    prResult = getPull(api, evidence.repo, certification.prNumber);
  } catch (error) {
    prResult = { ok: false, error: error.message };
  }
  if (!prResult.ok) {
    evidence.error = prResult.error || "GitHub merged PR lookup failed.";
    record.deliveryEvidence = evidence; touch(project); return evidence;
  }
  const pr = prResult.data;
  const state = pullState(pr);
  evidence.source.github = true;
  evidence.pr = {
    number: Number(pr.number),
    state,
    mergedAt: pr.merged_at || null,
    headSha: pr.head?.sha || null,
    // merge_commit_sha names a test merge until the PR is merged.
    mergeCommit: state === "MERGED" ? parseMergeCommit(pr.merge_commit_sha) : null,
    url: pr.html_url || certification.prUrl || null
  };

  const mergeCommit = evidence.pr.mergeCommit;
  const vercelService = getServiceState(project, "vercel");
  const cliAvailable = vercelCliAvailable ?? commandExists("vercel");
  if (vercelService.state === "registered" && mergeCommit && !cliAvailable) {
    evidence.production = productionFromGithubStatus(api, evidence.repo, mergeCommit, vercelService.name);
    evidence.source.production = evidence.production.status !== "unknown" || Boolean(evidence.production.rawStatus);
  } else if (vercelService.state === "registered" && mergeCommit && cliAvailable) {
    const prodResult = runCommand("vercel", [
      "list", vercelService.name, "--prod", "--meta", `githubCommitSha=${mergeCommit}`, "--no-color"
    ], { cwd: project.local || record.workspace?.path || undefined, timeout: 30000 });
    if (prodResult.ok) {
      evidence.source.production = true;
      evidence.production = productionFromVercel([prodResult.stdout, prodResult.stderr].filter(Boolean).join("\n"));
    } else {
      evidence.production = { status: "unknown", url: null, environment: "Production", error: prodResult.stderr || prodResult.error || "Vercel production lookup failed." };
    }
  }

  evidence.ok = true;
  record.deliveryEvidence = evidence;
  touch(project);
  return evidence;
}

function baseRow(project, record, evidence) {
  const cert = record.releaseCertification || null;
  return {
    projectId: project.id,
    projectName: project.name,
    priority: Number(project.priority) || 3,
    sessionId: record.id,
    scopeId: record.scopeId,
    task: record.task,
    status: null,
    reason: null,
    repo: project.repo || cert?.repo || null,
    certifiedHead: cert?.head || null,
    prNumber: cert?.prNumber || evidence?.pr?.number || null,
    prUrl: evidence?.pr?.url || cert?.prUrl || null,
    prState: evidence?.pr?.state || null,
    mergedAt: evidence?.pr?.mergedAt || null,
    mergedHead: evidence?.pr?.headSha || null,
    mergeCommit: evidence?.pr?.mergeCommit || null,
    productionStatus: evidence?.production?.status || null,
    productionUrl: evidence?.production?.url || null,
    observedAt: evidence?.observedAt || null,
    verifiedAt: record.deliveryVerification?.verifiedAt || null
  };
}

export function getDeliveryReadiness(project, sessionId, { now = new Date(), maxAgeMinutes = 15 } = {}) {
  const ttl = maxAge(maxAgeMinutes);
  const record = getSession(project, sessionId);
  const evidence = record.deliveryEvidence || null;
  const row = baseRow(project, record, evidence);
  const certification = record.releaseCertification;
  if (!certification) return { ...row, status: DELIVERY_STATUSES.RELEASE_CERTIFICATION_REQUIRED, reason: "No RELEASE_READY certification is stored for this session." };
  if (!evidence) return { ...row, status: DELIVERY_STATUSES.SYNC_REQUIRED, reason: "No post-merge delivery evidence is stored; run delivery-status --sync." };
  if (!evidence.ok) return { ...row, status: DELIVERY_STATUSES.SYNC_FAILED, reason: evidence.error || "Post-merge evidence sync failed." };
  const age = ageMinutes(evidence.observedAt, now);
  if (age > ttl) return { ...row, status: DELIVERY_STATUSES.EVIDENCE_STALE, reason: `Delivery evidence is ${Math.floor(age)} minute(s) old; refresh before declaring delivery complete.` };
  if (evidence.pr?.state !== "MERGED") return { ...row, status: DELIVERY_STATUSES.PR_NOT_MERGED, reason: `Certified PR #${certification.prNumber} is ${evidence.pr?.state || "not merged"}.` };
  if (!evidence.pr?.headSha || evidence.pr.headSha !== certification.head) {
    return { ...row, status: DELIVERY_STATUSES.MERGED_HEAD_MISMATCH, reason: "The merged PR head does not match the HEAD that passed RELEASE_READY." };
  }
  if (!evidence.pr?.mergeCommit) return { ...row, status: DELIVERY_STATUSES.MERGE_COMMIT_UNKNOWN, reason: "GitHub did not provide the merge commit for the certified PR." };
  const vercelState = getServiceState(project, "vercel").state;
  if (vercelState === "unused") return { ...row, status: DELIVERY_STATUSES.PRODUCTION_EVIDENCE_REQUIRED, reason: "This project is registered as vercel=none; production evidence must be supplied by another verifier." };
  if (vercelState !== "registered") return { ...row, status: DELIVERY_STATUSES.PRODUCTION_EVIDENCE_REQUIRED, reason: "No Vercel project is registered; production evidence must be supplied by another verifier." };
  if (!evidence.source?.production || !evidence.production) return { ...row, status: DELIVERY_STATUSES.PRODUCTION_EVIDENCE_REQUIRED, reason: "No production deployment evidence was found for the exact merge commit." };
  if (evidence.production.status === "failed") return { ...row, status: DELIVERY_STATUSES.PRODUCTION_FAILED, reason: "Production deployment for the merge commit failed." };
  if (evidence.production.status === "pending") return { ...row, status: DELIVERY_STATUSES.PRODUCTION_PENDING, reason: "Production deployment for the merge commit is still pending." };
  if (evidence.production.status === "cancelled") return { ...row, status: DELIVERY_STATUSES.PRODUCTION_CANCELLED, reason: "Production deployment for the merge commit was cancelled." };
  if (evidence.production.status !== "ready") return { ...row, status: DELIVERY_STATUSES.PRODUCTION_UNKNOWN, reason: `Production deployment state for the merge commit is not conclusively READY${evidence.production.rawStatus ? ` (${evidence.production.rawStatus})` : ""}.` };

  const verification = record.deliveryVerification;
  if (!verification || verification.mergeCommit !== evidence.pr.mergeCommit) {
    return { ...row, status: DELIVERY_STATUSES.VERIFICATION_REQUIRED, reason: "Production is READY, but the exact merge commit has not been manually/browser verified." };
  }
  if (verification.url && evidence.production.url && verification.url !== evidence.production.url) {
    return { ...row, status: DELIVERY_STATUSES.VERIFICATION_REQUIRED, reason: "Stored production verification targets a different deployment URL; verify the current deployment." };
  }
  return { ...row, status: DELIVERY_STATUSES.DELIVERED, reason: `Certified PR #${certification.prNumber} merged and the exact merge commit is READY and verified in production.` };
}

export function verifyDelivery(project, sessionId, { url = null, note = null, now = new Date() } = {}) {
  const record = getSession(project, sessionId);
  const gate = getDeliveryReadiness(project, sessionId, { now, maxAgeMinutes: 15 });
  if (![DELIVERY_STATUSES.VERIFICATION_REQUIRED, DELIVERY_STATUSES.DELIVERED].includes(gate.status)) {
    throw new Error(`Cannot verify production while Delivery Gate is ${gate.status}.`);
  }
  const evidence = record.deliveryEvidence;
  record.deliveryVerification = {
    verifiedAt: asDate(now).toISOString(),
    mergeCommit: evidence.pr.mergeCommit,
    url: url || evidence.production?.url || null,
    note: note || null
  };
  touch(project);
  return getDeliveryReadiness(project, sessionId, { now, maxAgeMinutes: 15 });
}

export function getDeliveryQueue(projects, { includeAll = false, now = new Date(), maxAgeMinutes = 15 } = {}) {
  const rows = [];
  for (const project of Object.values(projects || {})) {
    if (project.archived) continue;
    for (const record of project.sessions || []) {
      if (!includeAll && !record.releaseCertification && !record.deliveryEvidence) continue;
      if (record.workspace?.mode !== "worktree") continue;
      rows.push(getDeliveryReadiness(project, record.id, { now, maxAgeMinutes }));
    }
  }
  return rows.sort((a, b) =>
    (STATUS_ORDER.get(a.status) ?? 99) - (STATUS_ORDER.get(b.status) ?? 99)
    || a.priority - b.priority
    || a.projectId.localeCompare(b.projectId)
    || a.sessionId.localeCompare(b.sessionId)
  );
}

export function formatDeliveryReadiness(row) {
  return [
    `DELIVERY GATE — ${row.projectName} / ${row.sessionId}`,
    `${row.scopeId} ${row.task}`,
    `Decision: ${row.status}`,
    `PR: ${row.prNumber ? `#${row.prNumber}` : "—"}${row.prUrl ? ` ${row.prUrl}` : ""}`,
    `Certified HEAD: ${row.certifiedHead || "—"}`,
    `Merged HEAD: ${row.mergedHead || "—"}`,
    `Merge commit: ${row.mergeCommit || "—"}`,
    `Production: ${row.productionStatus || "—"}${row.productionUrl ? ` ${row.productionUrl}` : ""}`,
    `Observed: ${row.observedAt || "—"} | Verified: ${row.verifiedAt || "—"}`,
    `Reason: ${row.reason}`,
    row.status === DELIVERY_STATUSES.DELIVERED ? "Result: the certified change is confirmed delivered; no merge or deploy action was performed by SUMI." : null
  ].filter(Boolean).join("\n");
}

export function formatDeliveryQueue(rows) {
  const lines = ["SUMI DELIVERY QUEUE", "=".repeat(72)];
  if (!rows.length) return lines.concat("No certified sessions are currently in the post-merge delivery pipeline.").join("\n");
  for (const row of rows) {
    lines.push(`${row.status.padEnd(32)} P${row.priority} ${row.projectName} [${row.projectId}] ${row.sessionId} ${row.scopeId}`);
    lines.push(`  ${row.prNumber ? `PR #${row.prNumber} | ` : ""}${row.task}`);
    lines.push(`  ${row.reason}`);
  }
  return lines.join("\n");
}
