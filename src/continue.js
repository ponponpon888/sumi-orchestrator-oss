import { getHealthAlerts } from "./health.js";
import { getCompletion, getSetupGaps } from "./domain.js";
import { effectiveScopeStatus } from "./next.js";
import { getRoutePlan } from "./router.js";

function progressLabel(completion) {
  return completion.percent === null
    ? "— (completion scope not defined)"
    : `${completion.percent}% (${completion.done}/${completion.total} ${completion.basis})`;
}

function projectBlockers(project, completion) {
  const taskBlockers = completion.blockers.map((item) => ({ id: item.id, text: item.title }));
  const scopeBlockers = (project.scope?.criteria || [])
    .filter((item) => effectiveScopeStatus(project, item) === "blocked")
    .map((item) => ({ id: item.id, text: item.text }));
  return [...taskBlockers, ...scopeBlockers];
}

export function getContinueSummary(project) {
  const completion = getCompletion(project);
  const blockers = projectBlockers(project, completion);
  const plan = getRoutePlan(project, { limit: 8 });
  const ready = plan.filter((item) => item.state === "ready");
  const claimed = plan.filter((item) => item.state === "claimed");
  const waiting = plan.filter((item) => item.state === "waiting");
  const queue = [...ready, ...claimed, ...waiting].map((item) => item.display);
  const recommended = ready[0] || waiting[0] || null;

  return {
    completion,
    blockers,
    queue,
    plan,
    ready,
    claimed,
    waiting,
    recommended,
    setupGaps: getSetupGaps(project)
  };
}

export function formatContinue(project, summary = getContinueSummary(project)) {
  const lines = [
    `SUMI CONTINUE — ${project.name}`,
    "=".repeat(72),
    `Progress: ${progressLabel(summary.completion)}`,
    `Branch: ${project.deployment?.branch || "unknown"}`,
    `PR: ${project.deployment?.pr || "none/unknown"}`,
    `CI: ${project.deployment?.ci || "unknown"}`,
    `Worktree: ${project.observations?.local?.dirty === false ? "clean" : project.observations?.local?.dirty === true ? "dirty" : "unknown"}`,
    ""
  ];

  const alerts = getHealthAlerts(project);
  if (alerts.length) {
    lines.push("HEALTH ALERTS");
    for (const alert of alerts) lines.push(`  ! [${alert.severity}] ${alert.text}`);
    lines.push("");
  }

  if (summary.blockers.length) {
    lines.push("BLOCKERS");
    for (const item of summary.blockers) lines.push(`  ! ${item.id} ${item.text}`);
    lines.push("");
  }

  if (summary.recommended) {
    const item = summary.recommended;
    lines.push("RECOMMENDED NEXT");
    lines.push(`  ${item.scopeId ? `${item.scopeId} ` : ""}${item.task}`);
    lines.push(`  Owner: ${item.agent} / ${item.mode}`);
    lines.push(`  State: ${item.state}`);
    if (item.reason) lines.push(`  Note: ${item.reason}`);
    lines.push("");
  } else if (summary.setupGaps?.length) {
    // Nothing can be dispatched yet, but the reason is a missing registration
    // rather than an absence of work. Point at the command that unblocks it.
    const gap = summary.setupGaps[0];
    lines.push("RECOMMENDED NEXT");
    lines.push(`  ${gap.title}`);
    lines.push("  Owner: human / setup");
    lines.push("  State: setup");
    lines.push(`  Command: ${gap.commands[0]}`);
    lines.push("");
  } else {
    lines.push("RECOMMENDED NEXT", "  No actionable work detected.", "");
  }

  const parallel = summary.ready.filter((item) => item !== summary.recommended).slice(0, 3);
  if (parallel.length) {
    lines.push("PARALLEL READY");
    for (const item of parallel) {
      lines.push(`  - ${item.scopeId ? `${item.scopeId} ` : ""}${item.task} -> ${item.agent}`);
    }
    lines.push("");
  }

  if (summary.claimed.length) {
    lines.push("CLAIMED / IN PROGRESS");
    for (const item of summary.claimed.slice(0, 4)) {
      lines.push(`  - ${item.scopeId ? `${item.scopeId} ` : ""}${item.task}${item.reason ? ` — ${item.reason}` : ""}`);
    }
    lines.push("");
  }

  if (summary.waiting.length) {
    lines.push("WAITING");
    for (const item of summary.waiting.slice(0, 4)) {
      lines.push(`  - ${item.scopeId ? `${item.scopeId} ` : ""}${item.task}${item.reason ? ` — ${item.reason}` : ""}`);
    }
    lines.push("");
  }

  if (summary.setupGaps?.length) {
    lines.push("SETUP REQUIRED");
    for (const gap of summary.setupGaps) {
      lines.push(`  - ${gap.title}`);
      for (const command of gap.commands) lines.push(`      ${command}`);
    }
    lines.push("");
  }

  lines.push("NEXT QUEUE");
  if (!summary.queue.length) lines.push("  none");
  else summary.queue.slice(0, 5).forEach((text, index) => lines.push(`  ${index + 1}. ${text}`));

  return lines.join("\n");
}
