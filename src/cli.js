#!/usr/bin/env node
import fs from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  addDecision,
  addNextAction,
  addScopeCriterion,
  addTask,
  createProject,
  getScopeProgress,
  setDeployment,
  setScopeCriterionStatus,
  setScopeTitle,
  setTaskStatus,
  touch,
  setProjectPriority
} from "./domain.js";
import { appendAudit, defaultDataPath, loadState, saveState } from "./store.js";
import { formatDashboard, formatProject } from "./format.js";
import { formatHandoff } from "./handoff.js";
import { diagnoseProject, syncProject } from "./sync.js";
import { applyScopeStatusSuggestions, formatScopeStatusSuggestions, formatScopeSuggestions, getScopeStatusSuggestions, getScopeSuggestions } from "./scope.js";
import { buildAgentPrompt, formatRoutePlan, getRoutePlan, selectRouteItem } from "./router.js";
import { analyzeAgentResult, applyAgentResult, formatAgentResultAnalysis, recordAgentResult } from "./result.js";
import { formatEvidenceLedger, formatResultDetail, formatResultList, getAgentResult, getEvidenceLedger, listAgentResults } from "./ledger.js";
import { applyBlockerRecovery, formatBlockerRecovery, getBlockerRecovery } from "./recovery.js";
import { completeManualDispatch, dispatchProject, formatDispatchDetail, formatDispatchList, formatDispatchOutcome, formatManualDispatchCompletion, getDispatch, listDispatches } from "./dispatch.js";
import { closeBrowserDispatch, formatBrowserCheck, formatBrowserStart, parseExpectedUrls, startBrowserDispatch, checkBrowserDispatch } from "./browser.js";
import { formatContinue } from "./continue.js";
import { formatGlobalQueue, getGlobalQueue, selectGlobalQueueItem } from "./queue.js";
import { buildBatchPlan, buildBatchPromptBundle, buildBatchSessionPromptBundle, formatBatchPlan, formatBatchSessions, startBatchSessions } from "./batch.js";
import { claimScopeCriterion, formatClaim, formatClaimRelease, formatClaims, listClaims, releaseScopeClaim } from "./claims.js";
import { abandonSession, buildSessionPrompt, cleanupSessionWorkspace, finishSession, formatSession, formatSessionCleanup, formatSessionEnd, formatSessionInspection, formatSessionResult, formatSessions, formatSessionStart, getSession, ingestSessionResult, inspectSessionWorkspace, listSessions, renewSession, startSession } from "./sessions.js";
import { formatSessionReview, reviewSession } from "./review.js";
import { buildReviewerPrompt, formatReviewerResult, ingestReviewerResult } from "./reviewer.js";
import { formatMergeQueue, formatMergeReadiness, getMergeQueue, getMergeReadiness } from "./merge.js";
import { formatReleaseQueue, formatReleaseReadiness, getReleaseQueue, getReleaseReadiness, recordReleaseGate, syncReleaseEvidence } from "./release.js";
import { formatDeliveryQueue, formatDeliveryReadiness, getDeliveryQueue, getDeliveryReadiness, syncDeliveryEvidence, verifyDelivery } from "./delivery.js";
import { finalizeDeliveredSession, formatReleaseFinalization, formatReleaseHistory, getReleaseHistory } from "./releases.js";

function usage() {
  console.log(`SUMI Orchestrator v1.14.3

Core:
  sumi continue <project> [--no-sync]
  sumi dashboard [--sync]
  sumi queue [--sync] [--agent codex|claude-code|browser|human] [--state ready|claimed|waiting] [--limit n] [--prompt <number|project:scopeId>]
  sumi merge-queue [--all]
  sumi release-queue [--sync] [--all] [--max-age-min n]
  sumi delivery-queue [--sync] [--all] [--max-age-min n]
  sumi releases [project] [--limit n]
  sumi batch [--sync] [--agent codex|claude-code|browser|human] [--limit n] [--max-concurrency n] [--prompts <batch-number>] [--start-sessions <batch-number> [--emit-prompts] [--ttl-min n] [--worktree-root path] [--owner-prefix label]]
  sumi claim <project> <scopeId> --agent codex|claude-code|browser|human [--owner label] [--ttl-min n] [--force]
  sumi release <project> <scopeId>
  sumi claims [project] [--all]
  sumi session start <project> <scopeId> [--agent codex|claude-code|browser|human] [--owner label] [--ttl-min n] [--worktree|--no-worktree] [--worktree-root path] [--branch name] [--base ref]
  sumi session prompt <project> <sessionId>
  sumi session result <project> <sessionId> [--file path|--text text] [--apply] [--finish]
  sumi session renew <project> <sessionId> [--ttl-min n]
  sumi session finish <project> <sessionId>
  sumi session abandon <project> <sessionId>
  sumi session cleanup <project> <sessionId>
  sumi session list [project] [--all]
  sumi session show <project> <sessionId>
  sumi session inspect <project> <sessionId>
  sumi session review <project> <sessionId> [--run-checks]
  sumi session reviewer-prompt <project> <sessionId> [--agent codex|claude-code]
  sumi session reviewer-result <project> <sessionId> [--agent codex|claude-code] [--file path|--text text] [--apply]
  sumi session merge-status <project> <sessionId>
  sumi session release-status <project> <sessionId> [--sync] [--max-age-min n]
  sumi session delivery-status <project> <sessionId> [--sync] [--max-age-min n]
  sumi session delivery-verify <project> <sessionId> [--url url] [--note text]
  sumi session delivery-finalize <project> <sessionId> [--cleanup] [--max-age-min n]
  sumi status <project>
  sumi sync <project>
  sumi scope list <project>
  sumi route <project> [--prompt <scopeId|number>]
  sumi result <project> <scopeId> [--agent codex|claude-code|browser|human] [--file path|--text text] [--apply]
  sumi evidence <project> <scopeId>
  sumi handoff <project>

Project setup:
  sumi project list
  sumi project add <id> --name <name> [--repo owner/repo] [--local path] [--vercel name|none] [--supabase id|none] [--priority 1-5]
  sumi project set <id> [--name name] [--repo owner/repo] [--local path] [--vercel name|none] [--supabase id|none] [--priority 1-5]
    Pass "none" to record that a project deliberately does not use that service.
    Unregistered and "not used" are reported differently by status/queue, and a
    project with no completion Scope is shown as UNSCOPED instead of IN DEVELOPMENT.
  sumi scope title <project> <title>
  sumi scope add <project> <criterion> [--status todo|doing|blocked|done]
  sumi scope set <project> <criterionId> --status todo|doing|blocked|done|cancelled
  sumi scope suggest <project> [--apply]
  sumi scope review <project> [--apply]

Advanced:
  sumi doctor <project>
  sumi dispatch ...
  sumi browser ...
  sumi result list/show ...
  sumi task ...
  sumi decision ...
  sumi next ...
  sumi deploy ...

Global:
  --data <path>   Override state file (default: ${defaultDataPath()})
`);
}

const argv = process.argv.slice(2);
const global = parseArgs({ args: argv, options: { data: { type: "string" }, help: { type: "boolean", short: "h" } }, allowPositionals: true, strict: false });
if (global.values.help || global.positionals.length === 0) {
  usage();
  process.exit(0);
}

const dataPath = global.values.data || defaultDataPath();
const args = global.positionals;
const state = loadState(dataPath);
const [group, action, a, b] = args;

function project(id) {
  const p = state.projects[id];
  if (!p) throw new Error(`Unknown project: ${id}`);
  return p;
}

function option(name) {
  const idx = argv.indexOf(`--${name}`);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

function persist(kind, details = {}) {
  saveState(state, dataPath);
  appendAudit({ kind, ...details }, dataPath);
}

async function readAgentResultText() {
  const file = option("file");
  const inline = option("text");
  if (file) return fs.readFileSync(file, "utf8");
  if (inline !== undefined) return inline;
  if (!process.stdin.isTTY) return fs.readFileSync(0, "utf8");

  console.log("Paste the agent result below. Finish with a line containing only .end");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lines = [];
  for await (const line of rl) {
    if (line.trim() === ".end") break;
    lines.push(line);
  }
  rl.close();
  return lines.join("\n");
}

try {
  if (group === "init") {
    saveState(state, dataPath);
    console.log(`Initialized: ${dataPath}`);
  } else if (group === "continue") {
    const p = project(action);
    if (!argv.includes("--no-sync")) {
      const observations = syncProject(p);
      persist("project.continue.sync", { projectId: action, warnings: observations.warnings });
      if (observations.warnings.length) {
        console.log(`SYNC NOTES — ${p.name}`);
        for (const warning of observations.warnings) console.log(`- ${warning}`);
        console.log("");
      }
    }
    console.log(formatContinue(p));
  } else if (group === "dashboard") {
    if (argv.includes("--sync")) {
      for (const [projectId, p] of Object.entries(state.projects)) {
        try {
          syncProject(p);
        } catch (error) {
          appendAudit({ kind: "dashboard.sync.error", projectId, error: error.message }, dataPath);
        }
      }
      persist("dashboard.sync", { projects: Object.keys(state.projects) });
    }
    console.log(formatDashboard(state.projects));
  } else if (group === "queue") {
    if (argv.includes("--sync")) {
      for (const [projectId, p] of Object.entries(state.projects)) {
        try {
          syncProject(p);
        } catch (error) {
          appendAudit({ kind: "queue.sync.error", projectId, error: error.message }, dataPath);
        }
      }
      persist("queue.sync", { projects: Object.keys(state.projects) });
    }
    const filters = {
      agent: option("agent") ?? null,
      state: option("state") ?? null,
      limit: option("limit") ?? 20
    };
    const rows = getGlobalQueue(state.projects, filters);
    const selector = option("prompt");
    if (selector) {
      const item = selectGlobalQueueItem(rows, selector);
      if (item.state === "claimed") throw new Error(`${item.projectId}:${item.scopeId || item.order} is already claimed by ${item.claim?.owner || item.claim?.agent || "another worker"}.`);
      const p = project(item.projectId);
      console.log(buildAgentPrompt(p, item));
    } else {
      console.log(formatGlobalQueue(state.projects, rows, filters));
    }
  } else if (group === "merge-queue") {
    console.log(formatMergeQueue(getMergeQueue(state.projects, { includeAll: argv.includes("--all") })));
  } else if (group === "release-queue") {
    const maxAgeMinutes = option("max-age-min") ?? 15;
    if (argv.includes("--sync")) {
      for (const p of Object.values(state.projects)) {
        for (const record of p.sessions || []) {
          if (record.workspace?.mode !== "worktree") continue;
          const merge = getMergeReadiness(p, record.id);
          if (merge.status !== "MERGE_READY" && !argv.includes("--all")) continue;
          syncReleaseEvidence(p, record.id);
        }
      }
      persist("release.queue.sync", { projects: Object.keys(state.projects) });
    }
    console.log(formatReleaseQueue(getReleaseQueue(state.projects, { includeAll: argv.includes("--all"), maxAgeMinutes })));
  } else if (group === "delivery-queue") {
    const maxAgeMinutes = option("max-age-min") ?? 15;
    if (argv.includes("--sync")) {
      for (const p of Object.values(state.projects)) {
        for (const record of p.sessions || []) {
          if (record.workspace?.mode !== "worktree") continue;
          if (!record.releaseCertification && !argv.includes("--all")) continue;
          syncDeliveryEvidence(p, record.id);
        }
      }
      persist("delivery.queue.sync", { projects: Object.keys(state.projects) });
    }
    console.log(formatDeliveryQueue(getDeliveryQueue(state.projects, { includeAll: argv.includes("--all"), maxAgeMinutes })));
  } else if (group === "releases") {
    if (action && !state.projects[action]) throw new Error(`Unknown project: ${action}`);
    const rows = getReleaseHistory(state.projects, { projectId: action || null, limit: option("limit") ?? 50 });
    console.log(formatReleaseHistory(rows));
  } else if (group === "batch") {
    if (argv.includes("--sync")) {
      for (const [projectId, p] of Object.entries(state.projects)) {
        try {
          syncProject(p);
        } catch (error) {
          appendAudit({ kind: "batch.sync.error", projectId, error: error.message }, dataPath);
        }
      }
      persist("batch.sync", { projects: Object.keys(state.projects) });
    }
    const filters = {
      agent: option("agent") ?? null,
      limit: option("limit") ?? 50,
      maxConcurrency: option("max-concurrency") ?? 3
    };
    const plan = buildBatchPlan(state.projects, filters);
    const startSelector = option("start-sessions");
    const batchSelector = option("prompts");
    if (startSelector) {
      const outcome = startBatchSessions(state.projects, plan, startSelector, {
        ttlMinutes: option("ttl-min") ?? 120,
        worktreeRoot: option("worktree-root") ?? undefined,
        ownerPrefix: option("owner-prefix") ?? "batch"
      });
      persist("batch.sessions.start", {
        batchNumber: outcome.batchNumber,
        sessions: outcome.items.map((entry) => ({ projectId: entry.projectId, sessionId: entry.outcome.session.id, scopeId: entry.outcome.session.scopeId, agent: entry.outcome.session.agent, workspace: entry.outcome.session.workspace.path, branch: entry.outcome.session.workspace.branch }))
      });
      console.log(argv.includes("--emit-prompts") ? buildBatchSessionPromptBundle(state.projects, outcome) : formatBatchSessions(state.projects, outcome));
    } else if (batchSelector) console.log(buildBatchPromptBundle(state.projects, plan, batchSelector));
    else console.log(formatBatchPlan(state.projects, plan));
  } else if (group === "session" && action === "start") {
    const p = project(a);
    const scopeId = b;
    if (!scopeId) throw new Error("Scope criterion ID is required.");
    const agent = option("agent") ?? null;
    const worktree = argv.includes("--worktree") ? true : argv.includes("--no-worktree") ? false : undefined;
    const outcome = startSession(p, scopeId, {
      agent,
      owner: option("owner") ?? null,
      ttlMinutes: option("ttl-min") ?? 120,
      worktree,
      worktreeRoot: option("worktree-root") ?? undefined,
      branch: option("branch") ?? null,
      baseRef: option("base") ?? "HEAD"
    });
    persist("session.start", { projectId: a, sessionId: outcome.session.id, scopeId: outcome.session.scopeId, agent: outcome.session.agent, owner: outcome.session.owner, workspaceMode: outcome.session.workspace.mode, workspace: outcome.session.workspace.path, branch: outcome.session.workspace.branch, expiresAt: outcome.session.claimExpiresAt });
    console.log(formatSessionStart(p, outcome));
  } else if (group === "session" && action === "prompt") {
    const p = project(a);
    if (!b) throw new Error("Session ID is required.");
    console.log(buildSessionPrompt(p, b));
  } else if (group === "session" && action === "result") {
    const p = project(a);
    if (!b) throw new Error("Session ID is required.");
    const text = await readAgentResultText();
    const outcome = ingestSessionResult(p, b, text, { apply: argv.includes("--apply"), finish: argv.includes("--finish") });
    persist("session.result", {
      projectId: a,
      sessionId: outcome.session.id,
      scopeId: outcome.session.scopeId,
      agent: outcome.session.agent,
      resultId: outcome.result.id,
      applied: argv.includes("--apply"),
      finishRequested: argv.includes("--finish"),
      sessionStatus: outcome.session.status,
      changes: outcome.applied.appliedChanges,
      addedCriteria: outcome.applied.addedCriteria
    });
    console.log(formatSessionResult(p, outcome, { applied: argv.includes("--apply") }));
  } else if (group === "session" && action === "renew") {
    const p = project(a);
    if (!b) throw new Error("Session ID is required.");
    const outcome = renewSession(p, b, { ttlMinutes: option("ttl-min") ?? null });
    persist("session.renew", { projectId: a, sessionId: outcome.session.id, scopeId: outcome.session.scopeId, expiresAt: outcome.session.claimExpiresAt });
    console.log(formatSession(outcome.session, { projectName: p.name, projectId: p.id, leaseActive: true }));
  } else if (group === "session" && action === "finish") {
    const p = project(a);
    if (!b) throw new Error("Session ID is required.");
    const outcome = finishSession(p, b);
    persist("session.finish", { projectId: a, sessionId: outcome.session.id, scopeId: outcome.session.scopeId, claimReleased: outcome.session.claimReleased });
    console.log(formatSessionEnd(p, outcome));
  } else if (group === "session" && action === "abandon") {
    const p = project(a);
    if (!b) throw new Error("Session ID is required.");
    const outcome = abandonSession(p, b);
    persist("session.abandon", { projectId: a, sessionId: outcome.session.id, scopeId: outcome.session.scopeId, claimReleased: outcome.session.claimReleased });
    console.log(formatSessionEnd(p, outcome));
  } else if (group === "session" && action === "cleanup") {
    const p = project(a);
    if (!b) throw new Error("Session ID is required.");
    const outcome = cleanupSessionWorkspace(p, b);
    persist("session.cleanup", { projectId: a, sessionId: outcome.session.id, scopeId: outcome.session.scopeId, workspace: outcome.session.workspace.path, removedAt: outcome.session.workspace.removedAt });
    console.log(formatSessionCleanup(p, outcome));
  } else if (group === "session" && action === "list") {
    if (a && !state.projects[a]) throw new Error(`Unknown project: ${a}`);
    const rows = listSessions(state.projects, { projectId: a || null, includeEnded: argv.includes("--all") });
    console.log(formatSessions(rows));
  } else if (group === "session" && action === "inspect") {
    const p = project(a);
    if (!b) throw new Error("Session ID is required.");
    const record = getSession(p, b);
    const inspection = inspectSessionWorkspace(p, b);
    console.log(formatSessionInspection(p, record, inspection));
  } else if (group === "session" && action === "review") {
    const p = project(a);
    if (!b) throw new Error("Session ID is required.");
    const review = reviewSession(p, b, { runChecks: argv.includes("--run-checks") });
    const record = getSession(p, b);
    persist("session.review", { projectId: a, sessionId: record.id, scopeId: record.scopeId, decision: review.status, head: review.workspace.head || null, checksRun: review.checksRun, checks: review.checks.map((item) => ({ id: item.id, ok: item.ok, exitCode: item.exitCode, durationMs: item.durationMs })) });
    console.log(formatSessionReview(p, record, review));
  } else if (group === "session" && action === "reviewer-prompt") {
    const p = project(a);
    if (!b) throw new Error("Session ID is required.");
    console.log(buildReviewerPrompt(p, b, { agent: option("agent") ?? null }));
  } else if (group === "session" && action === "reviewer-result") {
    const p = project(a);
    if (!b) throw new Error("Session ID is required.");
    const text = await readAgentResultText();
    const outcome = ingestReviewerResult(p, b, text, { agent: option("agent") ?? null, apply: argv.includes("--apply") });
    persist("session.reviewer.result", { projectId: a, sessionId: outcome.session.id, scopeId: outcome.session.scopeId, reviewer: outcome.reviewer, verdict: outcome.verdict, resultId: outcome.result.id, reviewedHead: outcome.gate.workspace.head, applied: argv.includes("--apply"), changes: outcome.applied.appliedChanges, addedCriteria: outcome.applied.addedCriteria });
    console.log(formatReviewerResult(p, outcome, { applied: argv.includes("--apply") }));
  } else if (group === "session" && action === "merge-status") {
    const p = project(a);
    if (!b) throw new Error("Session ID is required.");
    console.log(formatMergeReadiness(getMergeReadiness(p, b)));
  } else if (group === "session" && action === "release-status") {
    const p = project(a);
    if (!b) throw new Error("Session ID is required.");
    if (argv.includes("--sync")) {
      const evidence = syncReleaseEvidence(p, b);
      persist("session.release.sync", { projectId: a, sessionId: b, ok: evidence.ok, pr: evidence.pr?.number || null, observedAt: evidence.observedAt, error: evidence.error || null });
    }
    const readiness = getReleaseReadiness(p, b, { maxAgeMinutes: option("max-age-min") ?? 15 });
    recordReleaseGate(p, b, readiness);
    persist("session.release.gate", { projectId: a, sessionId: b, decision: readiness.releaseStatus, pr: readiness.prNumber || null, head: readiness.head || null, observedAt: readiness.observedAt || null });
    console.log(formatReleaseReadiness(readiness));
  } else if (group === "session" && action === "delivery-status") {
    const p = project(a);
    if (!b) throw new Error("Session ID is required.");
    if (argv.includes("--sync")) {
      const evidence = syncDeliveryEvidence(p, b);
      persist("session.delivery.sync", { projectId: a, sessionId: b, ok: evidence.ok, pr: evidence.pr?.number || null, mergeCommit: evidence.pr?.mergeCommit || null, production: evidence.production?.status || null, observedAt: evidence.observedAt, error: evidence.error || null });
    }
    console.log(formatDeliveryReadiness(getDeliveryReadiness(p, b, { maxAgeMinutes: option("max-age-min") ?? 15 })));
  } else if (group === "session" && action === "delivery-verify") {
    const p = project(a);
    if (!b) throw new Error("Session ID is required.");
    const row = verifyDelivery(p, b, { url: option("url") ?? null, note: option("note") ?? null });
    persist("session.delivery.verify", { projectId: a, sessionId: b, mergeCommit: row.mergeCommit || null, url: row.productionUrl || null, verifiedAt: row.verifiedAt || null, decision: row.status });
    console.log(formatDeliveryReadiness(row));
  } else if (group === "session" && action === "delivery-finalize") {
    const p = project(a);
    if (!b) throw new Error("Session ID is required.");
    const outcome = finalizeDeliveredSession(p, b, {
      cleanup: argv.includes("--cleanup"),
      maxAgeMinutes: option("max-age-min") ?? 15
    });
    persist("session.delivery.finalize", {
      projectId: a,
      sessionId: outcome.session.id,
      scopeId: outcome.session.scopeId,
      releaseId: outcome.release.id,
      pr: outcome.release.prNumber || null,
      mergeCommit: outcome.release.mergeCommit || null,
      deliveredAt: outcome.release.deliveredAt,
      alreadyFinalized: outcome.alreadyFinalized,
      cleanup: outcome.cleanup.status
    });
    console.log(formatReleaseFinalization(p, outcome));
  } else if (group === "session" && action === "show") {
    const p = project(a);
    if (!b) throw new Error("Session ID is required.");
    const record = getSession(p, b);
    const rows = listSessions({ [p.id]: p }, { projectId: p.id, includeEnded: true });
    const row = rows.find((entry) => entry.id === record.id);
    console.log(formatSession(record, { projectName: p.name, projectId: p.id, leaseActive: row?.leaseActive ?? false }));
  } else if (group === "claim") {
    const p = project(action);
    const scopeId = a;
    if (!scopeId) throw new Error("Scope criterion ID is required.");
    const agent = option("agent");
    if (!agent) throw new Error("--agent is required for claim.");
    const outcome = claimScopeCriterion(p, scopeId, {
      agent,
      owner: option("owner") ?? null,
      ttlMinutes: option("ttl-min") ?? 120,
      force: argv.includes("--force")
    });
    persist("scope.claim", { projectId: action, scopeId: outcome.criterion.id, agent: outcome.claim.agent, owner: outcome.claim.owner, expiresAt: outcome.claim.expiresAt });
    console.log(formatClaim(p, outcome));
  } else if (group === "release") {
    const p = project(action);
    const scopeId = a;
    if (!scopeId) throw new Error("Scope criterion ID is required.");
    const outcome = releaseScopeClaim(p, scopeId);
    persist("scope.release", { projectId: action, scopeId: outcome.criterion.id, previousOwner: outcome.previous?.owner || null });
    console.log(formatClaimRelease(p, outcome));
  } else if (group === "claims") {
    if (action && !state.projects[action]) throw new Error(`Unknown project: ${action}`);
    const rows = listClaims(state.projects, { projectId: action || null, includeExpired: argv.includes("--all") });
    console.log(formatClaims(rows));
  } else if (group === "status") {
    console.log(formatProject(project(action)));
  } else if (group === "sync") {
    const p = project(action);
    const observations = syncProject(p);
    persist("project.sync", { projectId: action, warnings: observations.warnings });
    console.log(`Synced: ${action}`);
    console.log(formatProject(p));
    if (observations.warnings.length) {
      console.log("SYNC NOTES");
      for (const warning of observations.warnings) console.log(`- ${warning}`);
    }
  } else if (group === "handoff") {
    console.log(formatHandoff(project(action)));
  } else if (group === "route") {
    const p = project(action);
    const plan = getRoutePlan(p);
    const selector = option("prompt");
    if (selector) {
      const item = selectRouteItem(plan, selector);
      if (item.state === "claimed") throw new Error(`${p.id}:${item.scopeId || item.order} is already claimed by ${item.claim?.owner || item.claim?.agent || "another worker"}.`);
      console.log(buildAgentPrompt(p, item));
    } else {
      console.log(formatRoutePlan(p, plan));
    }
  } else if (group === "browser" && action === "start") {
    const p = project(a);
    const dispatchId = b;
    if (!dispatchId) throw new Error("Dispatch ID is required.");
    const outcome = startBrowserDispatch(p, dispatchId, { url: option("url"), headed: argv.includes("--headed") });
    persist("browser.start", { projectId: a, dispatchId: outcome.dispatch.id, scopeId: outcome.dispatch.scopeId, session: outcome.dispatch.browser?.session, url: outcome.dispatch.browser?.url, headed: outcome.dispatch.browser?.headed });
    console.log(formatBrowserStart(p, outcome));
  } else if (group === "browser" && action === "check") {
    const p = project(a);
    const dispatchId = b;
    if (!dispatchId) throw new Error("Dispatch ID is required.");
    const outcome = checkBrowserDispatch(p, dispatchId, { expectUrls: parseExpectedUrls(option("expect-url")), apply: argv.includes("--apply") });
    persist("browser.check", { projectId: a, dispatchId: outcome.dispatch.id, scopeId: outcome.dispatch.scopeId, matched: outcome.matched, completed: outcome.completed, resultId: outcome.result?.id || null, applied: argv.includes("--apply") });
    console.log(formatBrowserCheck(p, outcome, { applied: argv.includes("--apply") }));
  } else if (group === "browser" && action === "close") {
    const p = project(a);
    const dispatchId = b;
    if (!dispatchId) throw new Error("Dispatch ID is required.");
    const outcome = closeBrowserDispatch(p, dispatchId);
    persist("browser.close", { projectId: a, dispatchId: outcome.dispatch.id, scopeId: outcome.dispatch.scopeId });
    console.log(`Closed browser session: ${outcome.dispatch.browser?.session || outcome.dispatch.id}`);
  } else if (group === "dispatch" && action === "list") {
    const p = project(a);
    const rows = listDispatches(p, { limit: option("limit") ?? 20 });
    console.log(formatDispatchList(p, rows));
  } else if (group === "dispatch" && action === "show") {
    const p = project(a);
    const item = getDispatch(p, b);
    if (!item) throw new Error(`Dispatch not found: ${b}`);
    console.log(formatDispatchDetail(p, item));
  } else if (group === "dispatch" && action === "complete") {
    const p = project(a);
    const dispatchId = b;
    if (!dispatchId) throw new Error("Dispatch ID is required.");
    const existingDispatch = getDispatch(p, dispatchId);
    if (!existingDispatch) throw new Error(`Dispatch not found: ${dispatchId}`);
    if (existingDispatch.status !== "manual") {
      throw new Error(`Dispatch ${existingDispatch.id} is ${existingDispatch.status}; only manual dispatches can be completed with external results.`);
    }
    const text = await readAgentResultText();
    const outcome = await completeManualDispatch(p, dispatchId, text, { apply: argv.includes("--apply") });
    persist("agent.dispatch.complete", {
      projectId: a,
      scopeId: outcome.dispatch.scopeId,
      dispatchId: outcome.dispatch.id,
      agent: outcome.dispatch.agent,
      resultId: outcome.result.id,
      applied: argv.includes("--apply"),
      changes: outcome.applied.appliedChanges,
      addedCriteria: outcome.applied.addedCriteria
    });
    console.log(formatManualDispatchCompletion(p, outcome, { applied: argv.includes("--apply") }));
  } else if (group === "dispatch") {
    const p = project(action);
    const selector = a;
    if (!selector) throw new Error("Dispatch selector is required (scope ID or route number).");
    console.log(`DISPATCH START — ${p.name} / ${String(selector).toUpperCase()}`);
    const outcome = await dispatchProject(p, selector, { apply: argv.includes("--apply") });
    persist("agent.dispatch", {
      projectId: action,
      scopeId: outcome.item?.scopeId || null,
      dispatchId: outcome.dispatch.id,
      agent: outcome.dispatch.agent,
      status: outcome.dispatch.status,
      resultId: outcome.dispatch.resultId,
      applied: argv.includes("--apply")
    });
    console.log(formatDispatchOutcome(p, outcome, { applied: argv.includes("--apply") }));
  } else if (group === "result" && action === "list") {
    const p = project(a);
    const rows = listAgentResults(p, { scopeId: option("scope"), agent: option("agent"), limit: option("limit") ?? 20 });
    console.log(formatResultList(p, rows));
  } else if (group === "result" && action === "show") {
    const p = project(a);
    const item = getAgentResult(p, b);
    if (!item) throw new Error(`Agent result not found: ${b}`);
    console.log(formatResultDetail(p, item));
  } else if (group === "evidence") {
    const p = project(action);
    const ledger = getEvidenceLedger(p, a);
    console.log(formatEvidenceLedger(p, ledger));
  } else if (group === "unblock") {
    const p = project(action);
    console.log(`BLOCKER RECOVERY — ${p.name} / ${String(a || "").toUpperCase()}`);
    console.log("Refreshing GitHub/local recovery evidence...");
    const observations = syncProject(p, { skipVercel: true, skipSupabase: true });
    const recovery = getBlockerRecovery(p, String(a || "").toUpperCase());
    let applied = null;
    if (argv.includes("--apply")) applied = applyBlockerRecovery(p, recovery);
    persist("blocker.recovery", { projectId: action, scopeId: String(a || "").toUpperCase(), warnings: observations.warnings, applied });
    const formatted = formatBlockerRecovery(p, recovery);
    console.log(formatted.replace(/^BLOCKER RECOVERY[^\n]*\n/, ""));
    if (argv.includes("--apply")) {
      console.log("\nAPPLIED");
      console.log(applied ? `  ${applied.criterionId}: ${applied.from} -> ${applied.to}` : "  No high-confidence recovery transition to apply.");
    }
  } else if (group === "result") {
    const p = project(action);
    const scopeId = String(a || "").toUpperCase();
    const text = await readAgentResultText();
    const analysis = analyzeAgentResult(p, scopeId, text, { agent: option("agent") ?? "unknown" });
    const record = recordAgentResult(p, analysis);
    let applied = { appliedChanges: [], addedCriteria: [] };
    if (argv.includes("--apply")) {
      applied = applyAgentResult(p, analysis);
      record.appliedChanges = applied.appliedChanges.map((item) => ({ ...item }));
      record.addedCriteria = applied.addedCriteria.map((item) => ({ ...item }));
      record.appliedAt = new Date().toISOString();
    }
    persist("agent.result", {
      projectId: action,
      scopeId,
      resultId: record.id,
      agent: analysis.agent,
      applied: argv.includes("--apply"),
      changes: applied.appliedChanges,
      addedCriteria: applied.addedCriteria
    });
    console.log(formatAgentResultAnalysis(p, analysis, record));
    if (argv.includes("--apply")) {
      console.log("\nAPPLIED");
      if (!applied.appliedChanges.length && !applied.addedCriteria.length) console.log("  No high-confidence state changes or fresh criteria to apply.");
      for (const item of applied.appliedChanges) console.log(`  ${item.criterionId}: ${item.from} -> ${item.to}`);
      for (const item of applied.addedCriteria) console.log(`  ${item.criterionId} [${item.status}] ${item.text}`);
    }
  } else if (group === "doctor") {
    const p = project(action);
    const rows = diagnoseProject(p);
    console.log(`SUMI DOCTOR — ${p.name}`);
    for (const row of rows) {
      const state = row.ok ? "OK" : row.timedOut ? "TIMEOUT" : row.available ? "ERROR" : "MISSING";
      console.log(`${row.name.padEnd(10)} ${state.padEnd(8)} ${row.resolved || "—"}`);
      if (!row.ok && (row.output || row.error)) console.log(`  ${String(row.output || row.error).split(/\r?\n/)[0]}`);
    }
  } else if (group === "project" && action === "list") {
    const rows = Object.values(state.projects).sort((x, y) => (x.priority ?? 3) - (y.priority ?? 3) || x.name.localeCompare(y.name));
    console.log(`SUMI PROJECTS — ${rows.length}`);
    for (const p of rows) console.log(`P${p.priority ?? 3}  ${p.id.padEnd(20)} ${p.name}${p.repo ? `  ${p.repo}` : ""}`);
  } else if (group === "project" && action === "add") {
    const id = a;
    if (state.projects[id]) throw new Error(`Project already exists: ${id}`);
    const p = createProject({
      id,
      name: option("name"),
      repo: option("repo") ?? null,
      local: option("local") ?? null,
      vercel: option("vercel") ?? null,
      supabase: option("supabase") ?? null,
      priority: option("priority") ?? 3
    });
    state.projects[id] = p;
    persist("project.add", { projectId: id });
    console.log(`Added project: ${id}`);
  } else if (group === "project" && action === "set") {
    const p = project(a);
    for (const key of ["name", "repo", "local", "vercel", "supabase"]) {
      const value = option(key);
      if (value !== undefined) p[key] = value;
    }
    const priority = option("priority");
    if (priority !== undefined) setProjectPriority(p, priority);
    else touch(p);
    persist("project.set", { projectId: a });
    console.log(`Updated project: ${a}`);
  } else if (group === "scope" && action === "title") {
    const p = project(a);
    setScopeTitle(p, b);
    persist("scope.title", { projectId: a, title: b });
    console.log(`Scope title updated: ${a}`);
  } else if (group === "scope" && action === "add") {
    const p = project(a);
    const item = addScopeCriterion(p, b, option("status") ?? "todo");
    persist("scope.add", { projectId: a, criterionId: item.id });
    console.log(`Added ${item.id}: ${item.text}`);
  } else if (group === "scope" && action === "set") {
    const p = project(a);
    const item = setScopeCriterionStatus(p, b, option("status"));
    persist("scope.set", { projectId: a, criterionId: item.id, status: item.status });
    console.log(`${item.id} -> ${item.status}`);
  } else if (group === "scope" && action === "list") {
    const p = project(a);
    const progress = getScopeProgress(p);
    console.log(`${p.scope.title} — ${p.name}`);
    console.log(`Progress: ${progress.percent === null ? "—" : `${progress.percent}% (${progress.done}/${progress.total})`}`);
    if (!p.scope.criteria.length) console.log("No completion criteria yet.");
    for (const item of p.scope.criteria) console.log(`${item.id}  ${item.status.padEnd(9)} ${item.text}`);
  } else if (group === "scope" && action === "suggest") {
    const p = project(a);
    const result = getScopeSuggestions(p);
    console.log(formatScopeSuggestions(p, result));
    if (argv.includes("--apply")) {
      const added = [];
      for (const suggestion of result.fresh) {
        added.push(addScopeCriterion(p, suggestion.text, suggestion.status));
      }
      if (added.length) persist("scope.suggest.apply", { projectId: a, criterionIds: added.map((item) => item.id) });
      console.log(`\nApplied: ${added.length}`);
      for (const item of added) console.log(`  ${item.id} [${item.status}] ${item.text}`);
    }
  } else if (group === "scope" && action === "review") {
    const p = project(a);
    const result = getScopeStatusSuggestions(p);
    console.log(formatScopeStatusSuggestions(p, result));
    if (argv.includes("--apply")) {
      const applied = applyScopeStatusSuggestions(p, result);
      if (applied.length) {
        persist("scope.review.apply", { projectId: a, changes: applied.map((x) => ({ criterionId: x.criterion.id, from: x.from, to: x.to })) });
        console.log("\nAPPLIED");
        for (const item of applied) console.log(`  ${item.criterion.id}: ${item.from} -> ${item.to}`);
      } else {
        console.log("\nNo high-confidence status changes to apply.");
      }
    }
  } else if (group === "task" && action === "add") {
    const p = project(a);
    const title = b;
    const task = addTask(p, title, option("status") ?? "todo");
    persist("task.add", { projectId: a, taskId: task.id });
    console.log(`Added ${task.id}: ${task.title}`);
  } else if (group === "task" && action === "set") {
    const p = project(a);
    const task = setTaskStatus(p, b, option("status"));
    persist("task.set", { projectId: a, taskId: task.id, status: task.status });
    console.log(`${task.id} -> ${task.status}`);
  } else if (group === "decision" && action === "add") {
    const p = project(a);
    const decision = addDecision(p, b, option("reason") ?? "");
    persist("decision.add", { projectId: a, decisionId: decision.id });
    console.log(`Added ${decision.id}`);
  } else if (group === "next" && action === "add") {
    const p = project(a);
    const item = addNextAction(p, b);
    persist("next.add", { projectId: a, nextId: item.id });
    console.log(`Added ${item.id}`);
  } else if (group === "deploy" && action === "set") {
    const p = project(a);
    const patch = {};
    for (const key of ["branch", "commit", "pr", "ci", "preview", "production"]) {
      const v = option(key);
      if (v !== undefined) patch[key] = key === "pr" && /^\d+$/.test(v) ? Number(v) : v;
    }
    setDeployment(p, patch);
    persist("deploy.set", { projectId: a, patch });
    console.log(`Updated deployment: ${a}`);
  } else {
    usage();
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`SUMI error: ${error.message}`);
  process.exitCode = 1;
}
