import { getProjectProgress, getSetupGaps } from "./domain.js";
import { getRoutePlan } from "./router.js";
import { effectiveScopeStatus } from "./next.js";
import { getHealthAlerts } from "./health.js";

function criterionFor(project, scopeId) {
  if (!scopeId) return null;
  return (project.scope?.criteria || []).find((item) => item.id === scopeId) || null;
}

function queueClass(project, item) {
  const criterion = criterionFor(project, item.scopeId);
  if (item.state === "claimed") return "claimed";
  const isBlocker = effectiveScopeStatus(project, criterion) === "blocked" || item.key === "ci-billing";

  if (item.state === "ready" && isBlocker && item.agent === "human") return "human-blocker";
  if (item.state === "ready") return "agent-ready";
  if (item.state === "waiting") return "waiting";
  return "other";
}

function classRank(value) {
  if (value === "human-blocker") return 0;
  if (value === "agent-ready") return 1;
  if (value === "claimed") return 2;
  if (value === "waiting") return 3;
  return 4;
}

function normalizeLimit(value) {
  if (value === undefined || value === null || value === "") return 20;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new Error("Queue limit must be an integer between 1 and 200.");
  }
  return parsed;
}

export function getGlobalQueue(projects, { agent = null, state = null, limit = 20 } = {}) {
  const allowedAgents = new Set(["codex", "claude-code", "browser", "human"]);
  if (agent && !allowedAgents.has(agent)) {
    throw new Error(`Queue agent must be one of: ${[...allowedAgents].join(", ")}.`);
  }
  if (state && !["ready", "claimed", "waiting"].includes(state)) {
    throw new Error("Queue state must be ready, claimed, or waiting.");
  }
  const maxItems = normalizeLimit(limit);
  const rows = [];

  for (const project of Object.values(projects || {})) {
    if (!project || project.lifecycle === "archived") continue;
    if (!(project.scope?.criteria || []).length) continue;
    const progress = getProjectProgress(project);
    const plan = getRoutePlan(project, { limit: 8 });

    for (const item of plan) {
      if (agent && item.agent !== agent) continue;
      if (state && item.state !== state) continue;
      rows.push({
        ...item,
        projectId: project.id,
        projectName: project.name,
        projectPriority: project.priority ?? 3,
        progress,
        queueClass: queueClass(project, item)
      });
    }
  }

  rows.sort((a, b) => {
    const rank = classRank(a.queueClass) - classRank(b.queueClass);
    if (rank !== 0) return rank;
    const priority = (a.projectPriority ?? 3) - (b.projectPriority ?? 3);
    if (priority !== 0) return priority;
    if (a.order !== b.order) return a.order - b.order;
    return a.projectId.localeCompare(b.projectId);
  });

  return rows.slice(0, maxItems);
}

export function selectGlobalQueueItem(rows, selector) {
  if (!selector) throw new Error("Global queue selector is required (number or project:scopeId).");
  const value = String(selector).trim();
  const number = Number(value);
  if (Number.isInteger(number) && number >= 1) {
    const item = rows[number - 1];
    if (item) return item;
    throw new Error(`Global queue item not found: ${selector}`);
  }

  const match = value.match(/^([^:]+):([^:]+)$/);
  if (match) {
    const projectId = match[1];
    const scopeId = match[2].toUpperCase();
    const item = rows.find((row) => row.projectId === projectId && row.scopeId === scopeId);
    if (item) return item;
  }

  throw new Error(`Global queue item not found: ${selector}`);
}

function progressLabel(progress) {
  return progress.percent === null ? "—" : `${progress.percent}%`;
}

function renderItem(item, index) {
  const id = item.scopeId ? `${item.scopeId} ` : "";
  const note = item.reason ? `\n     Note: ${item.reason}` : "";
  return `${String(index + 1).padStart(2)}. P${item.projectPriority ?? 3} ${item.projectName} [${item.projectId}] ${id}${item.task}\n     ${progressLabel(item.progress)} -> ${item.agent} / ${item.mode} [${item.state}]${note}`;
}

export function formatGlobalQueue(projects, rows = getGlobalQueue(projects), filters = {}) {
  const active = Object.values(projects || {}).filter((project) => project?.lifecycle !== "archived");
  const projectCount = active.length;
  // Configuration gaps are reported next to the queue but never as queue rows:
  // they are not dispatchable, and numbering them would shift `--prompt <n>`.
  const setupRows = active
    .map((project) => ({ project, gaps: getSetupGaps(project) }))
    .filter((entry) => entry.gaps.length)
    .sort((a, b) => (a.project.priority ?? 3) - (b.project.priority ?? 3) || a.project.id.localeCompare(b.project.id));
  const setupLines = setupRows.length
    ? [
      "SETUP REQUIRED (not dispatchable until registered)",
      ...setupRows.flatMap(({ project, gaps }) => [
        `  P${project.priority ?? 3} ${project.name} [${project.id}] — ${gaps.map((gap) => gap.key).join(", ")}`,
        `      詳細: sumi status ${project.id}`
      ])
    ]
    : [];
  const humanBlockers = rows.filter((item) => item.queueClass === "human-blocker");
  const agentReady = rows.filter((item) => item.queueClass === "agent-ready");
  const claimed = rows.filter((item) => item.queueClass === "claimed");
  const waiting = rows.filter((item) => item.queueClass === "waiting");
  const filterBits = [];
  if (filters.agent) filterBits.push(`agent=${filters.agent}`);
  if (filters.state) filterBits.push(`state=${filters.state}`);

  // Health alerts cover every project, scoped or not. Like setup gaps they
  // are not queue rows: unnumbered, so `--prompt <n>` keeps its meaning.
  const alerts = [...active]
    .sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3) || a.id.localeCompare(b.id))
    .flatMap((project) => getHealthAlerts(project).map((alert) => `  ! P${project.priority ?? 3} ${project.name} [${project.id}] [${alert.severity}] ${alert.text}`));
  const lines = [
    "SUMI GLOBAL QUEUE",
    "=".repeat(72),
    `Projects: ${projectCount} | Items: ${rows.length} | Human blockers: ${humanBlockers.length} | Agent ready: ${agentReady.length} | Claimed: ${claimed.length} | Waiting: ${waiting.length}${setupRows.length ? ` | Setup: ${setupRows.length}` : ""}${alerts.length ? ` | Health alerts: ${alerts.length}` : ""}${filterBits.length ? ` | Filter: ${filterBits.join(", ")}` : ""}`,
    ""
  ];
  if (alerts.length) lines.push("HEALTH ALERTS (human; not work items)", ...alerts, "");

  if (!rows.length) {
    lines.push("No matching work items.");
    if (setupLines.length) lines.push("", ...setupLines);
    return lines.join("\n").trimEnd();
  }

  let offset = 0;
  const sections = [
    ["HUMAN BLOCKERS", humanBlockers],
    ["AGENT READY", agentReady],
    ["CLAIMED", claimed],
    ["WAITING", waiting]
  ];

  for (const [title, items] of sections) {
    if (!items.length) continue;
    lines.push(title);
    for (const item of items) {
      lines.push(renderItem(item, offset));
      offset += 1;
    }
    lines.push("");
  }

  const other = rows.filter((item) => !["human-blocker", "agent-ready", "claimed", "waiting"].includes(item.queueClass));
  if (other.length) {
    lines.push("OTHER");
    for (const item of other) {
      lines.push(renderItem(item, offset));
      offset += 1;
    }
    lines.push("");
  }

  if (setupLines.length) lines.push(...setupLines);

  return lines.join("\n").trimEnd();
}
