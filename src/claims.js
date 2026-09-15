import { ensureProjectShape, touch } from "./domain.js";

const CLAIM_AGENTS = new Set(["codex", "claude-code", "browser", "human"]);

function criterion(project, scopeId) {
  ensureProjectShape(project);
  const id = String(scopeId || "").toUpperCase();
  const item = project.scope.criteria.find((entry) => entry.id === id);
  if (!item) throw new Error(`Scope criterion not found: ${scopeId}`);
  return item;
}

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid claim timestamp: ${value}`);
  return date;
}

function ttl(value) {
  if (value === undefined || value === null || value === "") return 120;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1440) {
    throw new Error("Claim TTL must be an integer between 1 and 1440 minutes.");
  }
  return parsed;
}

export function getActiveClaim(item, { now = new Date() } = {}) {
  const claim = item?.claim;
  if (!claim?.expiresAt || !claim?.agent) return null;
  const current = asDate(now);
  const expires = new Date(claim.expiresAt);
  if (Number.isNaN(expires.getTime()) || expires.getTime() <= current.getTime()) return null;
  return claim;
}

export function claimScopeCriterion(project, scopeId, { agent, owner = null, ttlMinutes = 120, force = false, now = new Date() } = {}) {
  if (!CLAIM_AGENTS.has(agent)) {
    throw new Error(`Claim agent must be one of: ${[...CLAIM_AGENTS].join(", ")}.`);
  }
  const item = criterion(project, scopeId);
  if (["done", "cancelled"].includes(item.status)) {
    throw new Error(`Cannot claim ${item.id}; scope status is ${item.status}.`);
  }

  const current = asDate(now);
  const active = getActiveClaim(item, { now: current });
  if (active && !force) {
    throw new Error(`${item.id} is already claimed by ${active.owner || active.agent} until ${active.expiresAt}.`);
  }

  const duration = ttl(ttlMinutes);
  const expires = new Date(current.getTime() + duration * 60_000);
  item.claim = {
    agent,
    owner: String(owner || agent),
    claimedAt: current.toISOString(),
    expiresAt: expires.toISOString()
  };
  item.updatedAt = current.toISOString();
  touch(project);
  return { criterion: item, claim: item.claim };
}

export function releaseScopeClaim(project, scopeId, { now = new Date() } = {}) {
  const item = criterion(project, scopeId);
  const previous = item.claim || null;
  delete item.claim;
  item.updatedAt = asDate(now).toISOString();
  touch(project);
  return { criterion: item, previous };
}

export function listClaims(projects, { includeExpired = false, projectId = null, now = new Date() } = {}) {
  const current = asDate(now);
  const rows = [];
  for (const project of Object.values(projects || {})) {
    if (!project || project.lifecycle === "archived") continue;
    if (projectId && project.id !== projectId) continue;
    ensureProjectShape(project);
    for (const item of project.scope.criteria) {
      if (!item.claim) continue;
      const active = getActiveClaim(item, { now: current });
      if (!active && !includeExpired) continue;
      rows.push({
        projectId: project.id,
        projectName: project.name,
        scopeId: item.id,
        task: item.text,
        status: item.status,
        claim: item.claim,
        active: Boolean(active)
      });
    }
  }
  rows.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.projectId !== b.projectId) return a.projectId.localeCompare(b.projectId);
    return a.scopeId.localeCompare(b.scopeId);
  });
  return rows;
}

function claimLabel(claim) {
  return `${claim.owner || claim.agent} (${claim.agent}) until ${claim.expiresAt}`;
}

export function formatClaim(project, outcome) {
  return [
    `CLAIMED — ${project.name} / ${outcome.criterion.id}`,
    outcome.criterion.text,
    `Owner: ${outcome.claim.owner}`,
    `Agent: ${outcome.claim.agent}`,
    `Claimed: ${outcome.claim.claimedAt}`,
    `Expires: ${outcome.claim.expiresAt}`
  ].join("\n");
}

export function formatClaimRelease(project, outcome) {
  const prior = outcome.previous ? claimLabel(outcome.previous) : "none";
  return `RELEASED — ${project.name} / ${outcome.criterion.id}\nPrevious claim: ${prior}`;
}

export function formatClaims(rows) {
  const active = rows.filter((row) => row.active).length;
  const lines = ["SUMI CLAIMS", "=".repeat(72), `Entries: ${rows.length} | Active: ${active} | Expired: ${rows.length - active}`, ""];
  if (!rows.length) return lines.concat("No claims recorded.").join("\n");
  for (const row of rows) {
    lines.push(`${row.active ? "ACTIVE " : "EXPIRED"} ${row.projectName} [${row.projectId}] ${row.scopeId} ${row.task}`);
    lines.push(`        ${claimLabel(row.claim)}`);
  }
  return lines.join("\n");
}
