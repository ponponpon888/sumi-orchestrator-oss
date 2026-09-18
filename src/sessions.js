import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ensureProjectShape, touch } from "./domain.js";
import { claimScopeCriterion, getActiveClaim, releaseScopeClaim } from "./claims.js";
import { buildAgentPrompt, getRoutePlan } from "./router.js";
import { analyzeAgentResult, applyAgentResult, formatAgentResultAnalysis, recordAgentResult } from "./result.js";
import { AGENT_IDS, CODE_AGENT_IDS } from "./adapters.js";

const SESSION_AGENTS = new Set(AGENT_IDS);
const CODE_AGENTS = new Set(CODE_AGENT_IDS);
const ACTIVE_STATUS = "active";

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid session timestamp: ${value}`);
  return date;
}

function normalizeTtl(value) {
  if (value === undefined || value === null || value === "") return 120;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1440) {
    throw new Error("Session TTL must be an integer between 1 and 1440 minutes.");
  }
  return parsed;
}

function criterion(project, scopeId) {
  ensureProjectShape(project);
  const id = String(scopeId || "").toUpperCase();
  const item = project.scope.criteria.find((entry) => entry.id === id);
  if (!item) throw new Error(`Scope criterion not found: ${scopeId}`);
  return item;
}

function session(project, sessionId) {
  ensureProjectShape(project);
  const id = String(sessionId || "").toUpperCase();
  const item = project.sessions.find((entry) => entry.id === id);
  if (!item) throw new Error(`Session not found: ${sessionId}`);
  return item;
}

function nextSessionId(project) {
  ensureProjectShape(project);
  const seq = project.sessions.reduce((max, item) => {
    const match = String(item.id || "").match(/^S(\d+)$/i);
    return Math.max(max, match ? Number(match[1]) : 0);
  }, 0) + 1;
  return `S${String(seq).padStart(3, "0")}`;
}

function safeSegment(value) {
  return String(value || "session")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "session";
}

function defaultWorktreeRoot() {
  return process.env.SUMI_WORKTREE_ROOT || path.join(os.homedir(), ".sumi", "worktrees");
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  const suffix = [];
  let existing = resolved;

  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return resolved;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }

  try {
    return path.join(fs.realpathSync.native(existing), ...suffix);
  } catch {
    return resolved;
  }
}

function runGit(args, { cwd = null } = {}) {
  try {
    return execFileSync("git", args, {
      cwd: cwd || undefined,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch (error) {
    const stderr = String(error?.stderr || "").trim();
    const stdout = String(error?.stdout || "").trim();
    const detail = stderr || stdout || error.message;
    throw new Error(`Git command failed: git ${args.join(" ")}\n${detail}`);
  }
}

function resolveRepoRoot(project) {
  if (!project.local) throw new Error(`Project ${project.id} has no local repository path configured.`);
  if (!fs.existsSync(project.local)) throw new Error(`Local repository path does not exist: ${project.local}`);
  return runGit(["-C", project.local, "rev-parse", "--show-toplevel"]);
}

function createWorktree(project, sessionId, scopeId, { root = defaultWorktreeRoot(), baseRef = "HEAD", branch = null } = {}) {
  const repoRoot = canonicalPath(resolveRepoRoot(project));
  const dirtyBase = runGit(["-C", repoRoot, "status", "--porcelain"]);
  if (dirtyBase) {
    throw new Error(`Primary worktree is dirty; commit or stash changes before creating an isolated session worktree: ${repoRoot}`);
  }
  const workspacePath = canonicalPath(path.resolve(root, safeSegment(project.id), sessionId.toLowerCase()));
  const relativeToRepo = path.relative(repoRoot, workspacePath);
  if (relativeToRepo === "" || (!relativeToRepo.startsWith("..") && !path.isAbsolute(relativeToRepo))) {
    throw new Error(`Session worktree must be outside the primary repository: ${workspacePath}`);
  }
  if (fs.existsSync(workspacePath)) {
    throw new Error(`Session worktree path already exists: ${workspacePath}`);
  }

  fs.mkdirSync(path.dirname(workspacePath), { recursive: true });
  const branchName = branch || `sumi/${safeSegment(project.id)}/${safeSegment(scopeId)}-${sessionId.toLowerCase()}`;
  const baseCommit = runGit(["-C", repoRoot, "rev-parse", baseRef]);
  runGit(["-C", repoRoot, "worktree", "add", "-b", branchName, workspacePath, baseCommit]);

  return {
    mode: "worktree",
    path: workspacePath,
    repoRoot,
    branch: branchName,
    baseRef,
    baseCommit,
    created: true,
    removedAt: null
  };
}

function sharedWorkspace(project) {
  return {
    mode: "shared",
    path: project.local || null,
    repoRoot: project.local || null,
    branch: project.deployment?.branch || null,
    baseRef: null,
    baseCommit: project.deployment?.commit || null,
    created: false,
    removedAt: null
  };
}

function shouldCreateWorktree(agent, requested) {
  if (requested === true) return true;
  if (requested === false) return false;
  return CODE_AGENTS.has(agent);
}

function attachSessionClaim(item, sessionId) {
  if (item?.claim) item.claim.sessionId = sessionId;
}

function releaseOwnClaim(project, item, sessionId, now) {
  if (item.claim?.sessionId !== sessionId) return null;
  return releaseScopeClaim(project, item.id, { now });
}

export function startSession(project, scopeId, {
  agent,
  owner = null,
  ttlMinutes = 120,
  worktree = undefined,
  worktreeRoot = undefined,
  branch = null,
  baseRef = "HEAD",
  now = new Date()
} = {}) {
  ensureProjectShape(project);
  const current = asDate(now);
  const item = criterion(project, scopeId);
  const routeItem = getRoutePlan(project, { limit: 200 }).find((entry) => entry.scopeId === item.id);
  const routedAgent = routeItem?.agent || null;
  const selectedAgent = agent || routedAgent;
  if (!selectedAgent || !SESSION_AGENTS.has(selectedAgent)) {
    throw new Error(`Session agent must be one of: ${[...SESSION_AGENTS].join(", ")}.`);
  }
  if (agent && routedAgent && agent !== routedAgent) {
    throw new Error(`${item.id} routes to ${routedAgent}, not ${agent}. Start the session without --agent to use the Router decision.`);
  }
  agent = selectedAgent;
  if (["done", "cancelled"].includes(item.status)) {
    throw new Error(`Cannot start session for ${item.id}; scope status is ${item.status}.`);
  }

  const activeSession = project.sessions.find((entry) => entry.status === ACTIVE_STATUS && entry.scopeId === item.id);
  if (activeSession) {
    const activeLease = getActiveClaim(item, { now: current });
    if (activeLease?.sessionId === activeSession.id) {
      throw new Error(`${item.id} already has active session ${activeSession.id}.`);
    }
    // A session whose lease expired is stale. Preserve its workspace/history, but
    // close the orchestration record so a new worker can safely take over.
    activeSession.status = "expired";
    activeSession.endedAt = current.toISOString();
    activeSession.claimReleased = false;
  }

  const id = nextSessionId(project);
  const duration = normalizeTtl(ttlMinutes);
  const sessionOwner = String(owner || `${agent}-${id.toLowerCase()}`);
  const claimOutcome = claimScopeCriterion(project, item.id, {
    agent,
    owner: sessionOwner,
    ttlMinutes: duration,
    now: current
  });
  attachSessionClaim(item, id);

  let workspace;
  try {
    workspace = shouldCreateWorktree(agent, worktree)
      ? createWorktree(project, id, item.id, { root: worktreeRoot, baseRef, branch })
      : sharedWorkspace(project);
  } catch (error) {
    // Session creation is atomic from SUMI's perspective: if workspace setup fails,
    // do not leave a claim behind that would block the queue.
    releaseOwnClaim(project, item, id, current);
    throw error;
  }

  const record = {
    id,
    scopeId: item.id,
    task: item.text,
    agent,
    owner: sessionOwner,
    status: ACTIVE_STATUS,
    startedAt: current.toISOString(),
    endedAt: null,
    ttlMinutes: duration,
    claimExpiresAt: claimOutcome.claim.expiresAt,
    workspace
  };
  project.sessions.push(record);
  touch(project);
  return { session: record, criterion: item, claim: claimOutcome.claim };
}

export function renewSession(project, sessionId, { ttlMinutes = null, now = new Date() } = {}) {
  const current = asDate(now);
  const record = session(project, sessionId);
  if (record.status !== ACTIVE_STATUS) throw new Error(`Session ${record.id} is ${record.status}; only active sessions can be renewed.`);
  const item = criterion(project, record.scopeId);
  const activeClaim = getActiveClaim(item, { now: current });
  if (activeClaim && activeClaim.sessionId && activeClaim.sessionId !== record.id) {
    throw new Error(`${item.id} is now claimed by another session: ${activeClaim.sessionId}.`);
  }
  if (activeClaim && !activeClaim.sessionId && activeClaim.owner !== record.owner) {
    throw new Error(`${item.id} is now claimed by ${activeClaim.owner || activeClaim.agent}; cannot renew ${record.id}.`);
  }

  const duration = normalizeTtl(ttlMinutes ?? record.ttlMinutes ?? 120);
  const outcome = claimScopeCriterion(project, item.id, {
    agent: record.agent,
    owner: record.owner,
    ttlMinutes: duration,
    force: Boolean(activeClaim),
    now: current
  });
  attachSessionClaim(item, record.id);
  record.ttlMinutes = duration;
  record.claimExpiresAt = outcome.claim.expiresAt;
  touch(project);
  return { session: record, criterion: item, claim: outcome.claim };
}

function endSession(project, sessionId, status, { now = new Date() } = {}) {
  const current = asDate(now);
  const record = session(project, sessionId);
  if (record.status !== ACTIVE_STATUS) throw new Error(`Session ${record.id} is already ${record.status}.`);
  const item = criterion(project, record.scopeId);
  const released = releaseOwnClaim(project, item, record.id, current);
  record.status = status;
  record.endedAt = current.toISOString();
  record.claimReleased = Boolean(released);
  touch(project);
  return { session: record, criterion: item, released };
}

export function ingestSessionResult(project, sessionId, text, { apply = false, finish = false, now = new Date() } = {}) {
  const record = session(project, sessionId);
  if (record.status !== ACTIVE_STATUS) {
    throw new Error(`Session ${record.id} is ${record.status}; results can only be ingested into an active session.`);
  }
  const analysis = analyzeAgentResult(project, record.scopeId, text, { agent: record.agent });
  const result = recordAgentResult(project, analysis);
  result.sessionId = record.id;

  let applied = { appliedChanges: [], addedCriteria: [] };
  if (apply) {
    applied = applyAgentResult(project, analysis);
    result.appliedChanges = applied.appliedChanges.map((item) => ({ ...item }));
    result.addedCriteria = applied.addedCriteria.map((item) => ({ ...item }));
    result.appliedAt = asDate(now).toISOString();
  }

  // Applying a done/cancelled transition closes the session via domain state.
  // --finish is for reviewed work that should release the lease even when the gate stays open.
  if (finish && record.status === ACTIVE_STATUS) finishSession(project, record.id, { now });
  touch(project);
  return { session: record, analysis, result, applied };
}

export function formatSessionResult(project, outcome, { applied = false } = {}) {
  const lines = [
    formatAgentResultAnalysis(project, outcome.analysis, outcome.result),
    "",
    "SESSION",
    `  ${outcome.session.id}: ${outcome.session.status}`,
    `  Result linked: ${outcome.result.id}`,
    `  Scope: ${outcome.session.scopeId}`,
    `  Applied: ${applied ? "yes" : "no"}`
  ];
  if (outcome.session.status === ACTIVE_STATUS) {
    lines.push(`  Lease remains active until: ${outcome.session.claimExpiresAt}`);
    lines.push(`  Continue with: sumi session prompt ${project.id} ${outcome.session.id}`);
  } else if (outcome.session.workspace?.mode === "worktree" && !outcome.session.workspace.removedAt) {
    lines.push(`  Worktree retained: ${outcome.session.workspace.path}`);
  }
  return lines.join("\n");
}

export function finishSession(project, sessionId, options = {}) {
  return endSession(project, sessionId, "completed", options);
}

export function abandonSession(project, sessionId, options = {}) {
  return endSession(project, sessionId, "abandoned", options);
}

export function cleanupSessionWorkspace(project, sessionId, { now = new Date() } = {}) {
  const current = asDate(now);
  const record = session(project, sessionId);
  const workspace = record.workspace;
  if (!workspace || workspace.mode !== "worktree" || !workspace.created) {
    throw new Error(`Session ${record.id} does not own a SUMI-created worktree.`);
  }
  if (record.status === ACTIVE_STATUS) {
    throw new Error(`Session ${record.id} is active; finish or abandon it before cleanup.`);
  }
  if (workspace.removedAt) return { session: record, alreadyRemoved: true };

  if (!fs.existsSync(workspace.path)) {
    runGit(["-C", workspace.repoRoot, "worktree", "prune"]);
    workspace.removedAt = current.toISOString();
    touch(project);
    return { session: record, missing: true };
  }

  const dirty = runGit(["-C", workspace.path, "status", "--porcelain"]);
  if (dirty) {
    throw new Error(`Refusing to remove dirty session worktree: ${workspace.path}`);
  }
  runGit(["-C", workspace.repoRoot, "worktree", "remove", workspace.path]);
  workspace.removedAt = current.toISOString();
  touch(project);
  return { session: record, removed: true };
}

function parsePorcelain(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }));
}

export function inspectSessionWorkspace(project, sessionId) {
  const record = session(project, sessionId);
  const workspace = record.workspace || {};
  if (workspace.mode !== "worktree") {
    return {
      sessionId: record.id,
      mode: workspace.mode || "shared",
      path: workspace.path || null,
      exists: Boolean(workspace.path && fs.existsSync(workspace.path)),
      git: false,
      note: "Session does not own an isolated Git worktree."
    };
  }

  if (workspace.removedAt) {
    return { sessionId: record.id, mode: "worktree", path: workspace.path, exists: false, removed: true, removedAt: workspace.removedAt };
  }
  if (!workspace.path || !fs.existsSync(workspace.path)) {
    return { sessionId: record.id, mode: "worktree", path: workspace.path || null, exists: false, missing: true };
  }

  const head = runGit(["-C", workspace.path, "rev-parse", "HEAD"]);
  const branch = runGit(["-C", workspace.path, "rev-parse", "--abbrev-ref", "HEAD"]);
  const changes = parsePorcelain(runGit(["-C", workspace.path, "status", "--porcelain"]));
  const baseCommit = workspace.baseCommit || null;
  let commitsAhead = null;
  let commitsBehind = null;
  if (baseCommit) {
    commitsAhead = Number(runGit(["-C", workspace.path, "rev-list", "--count", `${baseCommit}..HEAD`]) || 0);
    commitsBehind = Number(runGit(["-C", workspace.path, "rev-list", "--count", `HEAD..${baseCommit}`]) || 0);
  }
  const warnings = [];
  if (workspace.branch && branch !== workspace.branch) warnings.push(`Expected branch ${workspace.branch}, found ${branch}.`);

  return {
    sessionId: record.id,
    mode: "worktree",
    path: workspace.path,
    exists: true,
    git: true,
    branch,
    expectedBranch: workspace.branch || null,
    head,
    baseCommit,
    commitsAhead,
    commitsBehind,
    dirty: changes.length > 0,
    changedFiles: changes,
    warnings
  };
}

export function formatSessionInspection(project, record, inspection) {
  const lines = [
    `SESSION WORKSPACE — ${project.name} / ${record.id}`,
    `${record.scopeId} ${record.task}`,
    `Session status: ${record.status}`,
    `Mode: ${inspection.mode}`,
    `Path: ${inspection.path || "—"}`,
    `Exists: ${inspection.exists ? "yes" : "no"}`
  ];
  if (!inspection.exists) {
    if (inspection.removed) lines.push(`Removed: ${inspection.removedAt}`);
    else if (inspection.missing) lines.push("State: MISSING worktree path");
    else if (inspection.note) lines.push(`Note: ${inspection.note}`);
    return lines.join("\n");
  }
  if (!inspection.git) {
    if (inspection.note) lines.push(`Note: ${inspection.note}`);
    return lines.join("\n");
  }
  lines.push(`Branch: ${inspection.branch}`);
  lines.push(`HEAD: ${inspection.head}`);
  lines.push(`Base: ${inspection.baseCommit || "—"}`);
  lines.push(`Commits ahead: ${inspection.commitsAhead ?? "—"} | behind base: ${inspection.commitsBehind ?? "—"}`);
  lines.push(`Worktree: ${inspection.dirty ? `dirty (${inspection.changedFiles.length} files)` : "clean"}`);
  for (const change of inspection.changedFiles.slice(0, 20)) lines.push(`  ${change.status} ${change.path}`);
  if (inspection.changedFiles.length > 20) lines.push(`  ... ${inspection.changedFiles.length - 20} more`);
  if (inspection.warnings?.length) {
    lines.push("WARNINGS");
    for (const warning of inspection.warnings) lines.push(`  ! ${warning}`);
  }
  return lines.join("\n");
}

export function rollbackSessionStart(project, sessionId, { now = new Date() } = {}) {
  const record = session(project, sessionId);
  const workspace = record.workspace;

  if (record.status === ACTIVE_STATUS) abandonSession(project, record.id, { now });

  if (workspace?.mode === "worktree" && workspace.created && !workspace.removedAt) {
    cleanupSessionWorkspace(project, record.id, { now });
    if (workspace.branch && workspace.repoRoot) {
      try {
        runGit(["-C", workspace.repoRoot, "branch", "-D", workspace.branch]);
      } catch (error) {
        throw new Error(`Rolled back worktree but could not remove SUMI-created branch ${workspace.branch}: ${error.message}`);
      }
    }
  }

  const index = project.sessions.findIndex((entry) => entry.id === record.id);
  if (index >= 0) project.sessions.splice(index, 1);
  touch(project);
  return { sessionId: record.id, removed: true };
}

export function getSession(project, sessionId) {
  return session(project, sessionId);
}

export function listSessions(projects, { projectId = null, includeEnded = false, now = new Date() } = {}) {
  const current = asDate(now);
  const rows = [];
  for (const project of Object.values(projects || {})) {
    if (!project || project.lifecycle === "archived") continue;
    if (projectId && project.id !== projectId) continue;
    ensureProjectShape(project);
    for (const record of project.sessions) {
      if (!includeEnded && record.status !== ACTIVE_STATUS) continue;
      const item = project.scope.criteria.find((entry) => entry.id === record.scopeId) || null;
      const activeClaim = getActiveClaim(item, { now: current });
      rows.push({
        ...record,
        projectId: project.id,
        projectName: project.name,
        leaseActive: Boolean(activeClaim?.sessionId === record.id)
      });
    }
  }
  rows.sort((a, b) => {
    if (a.status !== b.status) return a.status === ACTIVE_STATUS ? -1 : b.status === ACTIVE_STATUS ? 1 : a.status.localeCompare(b.status);
    return String(b.startedAt).localeCompare(String(a.startedAt));
  });
  return rows;
}

export function buildSessionPrompt(project, sessionId) {
  const record = session(project, sessionId);
  if (record.status !== ACTIVE_STATUS) throw new Error(`Session ${record.id} is ${record.status}; only active sessions can generate execution prompts.`);
  const item = getRoutePlan(project, { limit: 50 }).find((entry) => entry.scopeId === record.scopeId);
  if (!item) throw new Error(`No route item found for ${project.id}:${record.scopeId}.`);
  const ownedItem = {
    ...item,
    state: "ready",
    reason: `Execution session ${record.id} owns the active lease until ${record.claimExpiresAt}.`
  };
  const base = buildAgentPrompt(project, ownedItem).trimEnd().replace(
    "- Work in the registered local repository and verify repository state before changing anything.",
    "- Work only in the execution-session workspace specified below and verify its repository state before changing anything."
  );
  const workspaceLines = record.workspace?.mode === "worktree"
    ? [
        `Session: ${record.id}`,
        `Workspace: ${record.workspace.path}`,
        `Branch: ${record.workspace.branch}`,
        `Base: ${record.workspace.baseRef}`,
        "Isolation: perform all repository reads/writes for this assignment inside this worktree. Do not modify the primary worktree."
      ]
    : [
        `Session: ${record.id}`,
        `Workspace: ${record.workspace?.path || "not applicable"}`,
        "Isolation: this session does not own a separate worktree. Do not perform repository writes unless the assignment explicitly requires them."
      ];
  return `${base}\n\n## Execution session\n${workspaceLines.map((line) => `- ${line}`).join("\n")}\n- Include the session ID in your completion response.\n`;
}

function workspaceLabel(record) {
  if (!record.workspace) return "none";
  if (record.workspace.mode === "worktree") {
    const removed = record.workspace.removedAt ? " [removed]" : "";
    return `${record.workspace.path} (${record.workspace.branch})${removed}`;
  }
  return record.workspace.path || "shared/no local path";
}

export function formatSessionStart(project, outcome) {
  const record = outcome.session;
  return [
    `SESSION STARTED — ${project.name} / ${record.id}`,
    `${record.scopeId} ${record.task}`,
    `Agent: ${record.agent}`,
    `Owner: ${record.owner}`,
    `Lease expires: ${record.claimExpiresAt}`,
    `Workspace mode: ${record.workspace.mode}`,
    `Workspace: ${workspaceLabel(record)}`,
    "",
    `Generate the isolated execution prompt with: sumi session prompt ${project.id} ${record.id}`
  ].join("\n");
}

export function formatSession(record, { projectName = null, projectId = null, leaseActive = null } = {}) {
  const title = projectName ? `${projectName}${projectId ? ` [${projectId}]` : ""} / ${record.id}` : record.id;
  const lines = [
    `SESSION — ${title}`,
    `${record.scopeId} ${record.task}`,
    `Status: ${record.status}`,
    `Agent: ${record.agent}`,
    `Owner: ${record.owner}`,
    `Started: ${record.startedAt}`,
    `Ended: ${record.endedAt || "—"}`,
    `Lease expires: ${record.claimExpiresAt || "—"}${leaseActive === null ? "" : leaseActive ? " [active]" : " [expired/released]"}`,
    `Workspace: ${workspaceLabel(record)}`
  ];
  return lines.join("\n");
}

export function formatSessions(rows) {
  const active = rows.filter((row) => row.status === ACTIVE_STATUS).length;
  const stale = rows.filter((row) => row.status === ACTIVE_STATUS && !row.leaseActive).length;
  const lines = ["SUMI SESSIONS", "=".repeat(72), `Entries: ${rows.length} | Active: ${active} | Stale lease: ${stale}`, ""];
  if (!rows.length) return lines.concat("No matching sessions.").join("\n");
  for (const row of rows) {
    const lease = row.status === ACTIVE_STATUS ? (row.leaseActive ? "lease-active" : "LEASE-STALE") : row.status;
    lines.push(`${row.projectName} [${row.projectId}] ${row.id} ${row.scopeId} -> ${row.agent} / ${lease}`);
    lines.push(`  ${workspaceLabel(row)}`);
  }
  return lines.join("\n");
}

export function formatSessionEnd(project, outcome) {
  const record = outcome.session;
  return [
    `SESSION ${record.status.toUpperCase()} — ${project.name} / ${record.id}`,
    `${record.scopeId} ${record.task}`,
    `Claim released: ${record.claimReleased ? "yes" : "no (lease was already absent or reassigned)"}`,
    `Workspace retained: ${record.workspace?.mode === "worktree" && !record.workspace?.removedAt ? "yes" : "n/a"}`
  ].join("\n");
}

export function formatSessionCleanup(project, outcome) {
  const record = outcome.session;
  const detail = outcome.alreadyRemoved ? "already removed" : outcome.missing ? "path already missing; metadata reconciled" : "removed";
  return `SESSION WORKTREE CLEANUP — ${project.name} / ${record.id}\nWorkspace: ${record.workspace.path}\nResult: ${detail}\nBranch retained: ${record.workspace.branch}`;
}
