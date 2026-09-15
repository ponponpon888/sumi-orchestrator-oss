import { buildAgentPrompt } from "./router.js";
import { getGlobalQueue } from "./queue.js";
import { buildSessionPrompt, rollbackSessionStart, startSession } from "./sessions.js";

const AI_AGENTS = new Set(["codex", "claude-code", "browser"]);

function normalizePositiveInteger(value, { name, fallback, max }) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}.`);
  }
  return parsed;
}

function normalizeAgent(agent) {
  if (!agent) return null;
  if (![...AI_AGENTS, "human"].includes(agent)) {
    throw new Error(`Batch agent must be one of: ${[...AI_AGENTS, "human"].join(", ")}.`);
  }
  return agent;
}

/**
 * Build a conservative portfolio execution plan.
 *
 * Safety rules:
 * - only READY work is scheduled;
 * - human work is surfaced separately and never counted as an AI slot;
 * - at most one assignment from a project can enter the same batch, preventing
 *   two agents from concurrently mutating or reviewing the same repository state;
 * - batches preserve global-queue ordering, so blockers/priority decisions remain deterministic.
 */
export function buildBatchPlan(projects, { agent = null, limit = 50, maxConcurrency = 3 } = {}) {
  const selectedAgent = normalizeAgent(agent);
  const maxItems = normalizePositiveInteger(limit, { name: "Batch limit", fallback: 50, max: 200 });
  const concurrency = normalizePositiveInteger(maxConcurrency, { name: "Batch max concurrency", fallback: 3, max: 16 });

  const readyRows = getGlobalQueue(projects, { state: "ready", limit: 200 });
  const waitingRows = getGlobalQueue(projects, { state: "waiting", limit: 200 });
  const humanActions = readyRows.filter((item) => item.agent === "human");

  let candidates = readyRows.filter((item) => item.agent !== "human");
  if (selectedAgent === "human") candidates = [];
  else if (selectedAgent) candidates = candidates.filter((item) => item.agent === selectedAgent);
  candidates = candidates.slice(0, maxItems);

  const pending = [...candidates];
  const batches = [];

  while (pending.length) {
    const batch = [];
    const lockedProjects = new Set();

    for (let index = 0; index < pending.length && batch.length < concurrency;) {
      const item = pending[index];
      if (lockedProjects.has(item.projectId)) {
        index += 1;
        continue;
      }
      batch.push(item);
      lockedProjects.add(item.projectId);
      pending.splice(index, 1);
    }

    // Defensive guard: every pending item should be schedulable in a fresh batch.
    if (!batch.length) break;
    batches.push(batch);
  }

  return {
    maxConcurrency: concurrency,
    agent: selectedAgent,
    humanActions,
    waitingCount: waitingRows.length,
    candidateCount: candidates.length,
    batches
  };
}

function assignmentLine(item, index) {
  const scope = item.scopeId ? `${item.scopeId} ` : "";
  return `  ${index + 1}. P${item.projectPriority ?? 3} ${item.projectName} [${item.projectId}] ${scope}${item.task}\n     -> ${item.agent} / ${item.mode}`;
}

export function formatBatchPlan(projects, plan) {
  const activeProjects = Object.values(projects || {}).filter((project) => project?.lifecycle !== "archived").length;
  const lines = [
    "SUMI PARALLEL PLAN",
    "=".repeat(72),
    `Projects: ${activeProjects} | AI assignments: ${plan.candidateCount} | Batches: ${plan.batches.length} | Max concurrency: ${plan.maxConcurrency} | Human actions: ${plan.humanActions.length} | Waiting: ${plan.waitingCount}${plan.agent ? ` | Filter: agent=${plan.agent}` : ""}`,
    "",
    "CONCURRENCY POLICY",
    "  - Ready work only",
    "  - One assignment per project in each batch",
    "  - Human actions are separate from AI concurrency",
    ""
  ];

  if (plan.humanActions.length) {
    lines.push("HUMAN ACTIONS");
    for (const [index, item] of plan.humanActions.entries()) lines.push(assignmentLine(item, index));
    lines.push("");
  }

  if (!plan.batches.length) {
    lines.push("No AI work is ready for this plan.");
    return lines.join("\n");
  }

  for (const [batchIndex, batch] of plan.batches.entries()) {
    lines.push(`BATCH ${batchIndex + 1} — ${batch.length} parallel assignment${batch.length === 1 ? "" : "s"}`);
    for (const [index, item] of batch.entries()) lines.push(assignmentLine(item, index));
    lines.push("");
  }

  lines.push("Generate copy-ready prompts for one batch with:", "  sumi batch --prompts <batch-number>");
  return lines.join("\n").trimEnd();
}

export function selectBatch(plan, selector) {
  const number = Number(selector);
  if (!Number.isInteger(number) || number < 1 || number > plan.batches.length) {
    throw new Error(`Batch not found: ${selector}`);
  }
  return { number, items: plan.batches[number - 1] };
}

export function buildBatchPromptBundle(projects, plan, selector) {
  const selected = selectBatch(plan, selector);
  const lines = [
    `# SUMI PARALLEL BATCH ${selected.number}`,
    "",
    `Assignments: ${selected.items.length}`,
    `Concurrency policy: each assignment targets a different project; do not cross project boundaries.`,
    ""
  ];

  for (const [index, item] of selected.items.entries()) {
    const project = projects[item.projectId];
    if (!project) throw new Error(`Unknown project in batch: ${item.projectId}`);
    lines.push(`--- ASSIGNMENT ${index + 1}/${selected.items.length} ---`, "", buildAgentPrompt(project, item).trimEnd(), "");
  }

  return lines.join("\n").trimEnd();
}


export function startBatchSessions(projects, plan, selector, { ttlMinutes = 120, worktreeRoot = undefined, ownerPrefix = "batch" } = {}) {
  const selected = selectBatch(plan, selector);
  const started = [];
  try {
    for (const item of selected.items) {
      const project = projects[item.projectId];
      if (!project) throw new Error(`Unknown project in batch: ${item.projectId}`);
      if (!item.scopeId) throw new Error(`Batch assignment has no scope ID: ${item.projectId} route ${item.order}`);
      const outcome = startSession(project, item.scopeId, {
        agent: item.agent,
        owner: `${ownerPrefix}-${selected.number}-${item.projectId}-${item.agent}`,
        ttlMinutes,
        worktreeRoot
      });
      started.push({ projectId: item.projectId, outcome });
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const entry of [...started].reverse()) {
      try {
        rollbackSessionStart(projects[entry.projectId], entry.outcome.session.id);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError.message);
      }
    }
    const rollbackNote = rollbackErrors.length
      ? ` Rollback errors: ${rollbackErrors.join(" | ")}`
      : ` Rolled back ${started.length} started session${started.length === 1 ? "" : "s"}.`;
    throw new Error(`Batch session start failed: ${error.message}.${rollbackNote}`);
  }

  return { batchNumber: selected.number, items: started };
}

export function formatBatchSessions(projects, outcome) {
  const lines = [
    `SUMI BATCH SESSIONS — BATCH ${outcome.batchNumber}`,
    "=".repeat(72),
    `Sessions started: ${outcome.items.length}`,
    ""
  ];
  for (const [index, entry] of outcome.items.entries()) {
    const project = projects[entry.projectId];
    const record = entry.outcome.session;
    lines.push(`${index + 1}. ${project.name} [${project.id}] ${record.id} ${record.scopeId}`);
    lines.push(`   -> ${record.agent} / ${record.owner}`);
    lines.push(`   Workspace: ${record.workspace?.path || "shared/no local path"}`);
    if (record.workspace?.branch) lines.push(`   Branch: ${record.workspace.branch}`);
    lines.push(`   Prompt: sumi session prompt ${project.id} ${record.id}`);
  }
  lines.push("", "All assignments now hold active session leases and are excluded from subsequent ready batches.");
  return lines.join("\n");
}

export function buildBatchSessionPromptBundle(projects, outcome) {
  const lines = [
    `# SUMI SESSION BATCH ${outcome.batchNumber}`,
    "",
    `Sessions: ${outcome.items.length}`,
    "Each assignment owns its lease and, for code agents, its own isolated Git worktree.",
    ""
  ];
  for (const [index, entry] of outcome.items.entries()) {
    const project = projects[entry.projectId];
    const record = entry.outcome.session;
    lines.push(`--- SESSION ${index + 1}/${outcome.items.length}: ${project.id}/${record.id} ---`, "", buildSessionPrompt(project, record.id).trimEnd(), "");
  }
  return lines.join("\n").trimEnd();
}
