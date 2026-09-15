import { buildNextQueue, classifyAction, effectiveScopeStatus, remediationDependencies } from "./next.js";
import { getActiveClaim } from "./claims.js";

export const AGENTS = new Set(["claude-code", "codex", "browser", "human"]);

function stripScopePrefix(text) {
  return String(text || "").replace(/^(C\d{3})\s+/, "").trim();
}

function scopeIdFromText(text) {
  return String(text || "").match(/^(C\d{3})\s+/)?.[1] || null;
}

function routeForKey(key, text, project = null, scopeId = null) {
  switch (key) {
    case "ci-billing": {
      const criterion = scopeId ? (project?.scope?.criteria || []).find((item) => item.id === scopeId) : null;
      if (criterion && criterion.status !== "blocked" && project?.deployment?.ci === "failed") {
        return {
          agent: "claude-code",
          mode: "execute",
          rationale: "The billing gate is no longer blocked, but CI is still failing; route the remaining workflow failure to the local coding agent."
        };
      }
      return {
        agent: "human",
        mode: "action",
        rationale: "GitHub billing/spending-limit changes require an account owner action rather than code changes."
      };
    }
    case "ci-baseline":
    case "ci-failure":
    case "local-changes":
    case "preview-failure":
      return {
        agent: "claude-code",
        mode: "execute",
        rationale: "Repository/CI diagnosis and code or workflow changes are best handled in the local coding agent."
      };
    case "cloudflare-config":
    case "vercel-config":
    case "supabase-config":
      return {
        agent: "human",
        mode: "action",
        rationale: "This gate requires an authorized account owner to change managed-platform settings."
      };
    case "pr-review-merge":
      return {
        agent: "codex",
        mode: "review",
        rationale: "Use an independent coding agent to review the current PR and challenge the implementation before merge."
      };
    case "browser-verification":
    case "production-smoke":
    case "preview-cancel-reason":
      return {
        agent: "browser",
        mode: "verify",
        rationale: "This gate requires observed runtime/browser evidence rather than more code generation."
      };
    default:
      return {
        agent: "claude-code",
        mode: "execute",
        rationale: `No specialized route matched; defaulting actionable development work to Claude Code (${text}).`
      };
  }
}

function dependencyState(project, key, criterion = null) {
  if (criterion) {
    const remediation = remediationDependencies(project, criterion.id)
      .find((item) => !["done", "cancelled"].includes(effectiveScopeStatus(project, item)));
    if (remediation) {
      return {
        state: "waiting",
        reason: `${remediation.id} must resolve the remediation dependency before ${criterion.id} can continue.`
      };
    }
    if (effectiveScopeStatus(project, criterion) === "blocked" && key !== "ci-billing") {
      return {
        state: "waiting",
        reason: `${criterion.id} is blocked; resolve its blocker before routing verification or implementation work.`
      };
    }
  }
  if (key === "pr-review-merge") {
    const blocker = (project.scope?.criteria || []).find((item) =>
      item.status === "blocked" && classifyAction(item.text) === "ci-billing"
    );
    if (blocker) {
      return {
        state: "waiting",
        reason: `${blocker.id} is blocking CI; do not repeat the final PR readiness review until that external blocker is cleared.`
      };
    }
  }
  if (key === "production-smoke") {
    if (project.deployment?.pr) {
      return {
        state: "waiting",
        reason: `PR #${project.deployment.pr} is still open/current; production smoke test belongs after merge and deployment.`
      };
    }
    if (project.deployment?.production !== "ready" && project.deployment?.production !== "verified") {
      return {
        state: "waiting",
        reason: `Production is ${project.deployment?.production || "unknown"}; wait for a ready deployment before smoke testing.`
      };
    }
  }

  if (key === "browser-verification") {
    const preview = project.deployment?.preview;
    if (preview === "failed") {
      return { state: "waiting", reason: "Current Preview failed; produce a runnable environment before browser verification." };
    }
    if (preview === "cancelled") {
      return {
        state: "ready",
        reason: "Preview is cancelled, so verify against an explicit local/current-branch environment rather than assuming Production contains this PR."
      };
    }
  }

  return { state: "ready", reason: null };
}

export function getRoutePlan(project, { limit = 8 } = {}) {
  const queue = buildNextQueue(project, { limit });
  return queue.map((display, index) => {
    const scopeId = scopeIdFromText(display);
    const task = stripScopePrefix(display);
    const key = classifyAction(task);
    const route = routeForKey(key, task, project, scopeId);
    const criterion = scopeId ? (project.scope?.criteria || []).find((entry) => entry.id === scopeId) : null;
    const dependency = dependencyState(project, key, criterion);
    const claim = dependency.state === "ready" ? getActiveClaim(criterion) : null;
    const availability = claim
      ? { state: "claimed", reason: `Claimed by ${claim.owner || claim.agent} until ${claim.expiresAt}.`, claim }
      : dependency;
    return {
      order: index + 1,
      scopeId,
      display,
      task,
      key,
      ...route,
      ...availability
    };
  });
}

function compactState(project) {
  const o = project.observations || {};
  const previewUrl = o.vercel?.preview?.url || null;
  const productionUrl = o.vercel?.production?.url || null;
  return [
    `Repository: ${project.repo || "unknown"}`,
    `Local: ${project.local || "unknown"}`,
    `Branch: ${project.deployment?.branch || "unknown"}`,
    `Commit: ${project.deployment?.commit || "unknown"}`,
    `PR: ${project.deployment?.pr || "none/unknown"}`,
    `CI: ${project.deployment?.ci || "unknown"}`,
    `Preview: ${project.deployment?.preview || "unknown"}${previewUrl ? ` ${previewUrl}` : ""}`,
    `Production: ${project.deployment?.production || "unknown"}${productionUrl ? ` ${productionUrl}` : ""}`,
    `Supabase: ${o.supabase?.found ? `${o.supabase.status || "unknown"}${o.supabase.region ? ` (${o.supabase.region})` : ""}` : project.supabase ? "configured; current health unknown" : "not configured"}`,
    `Worktree: ${o.local?.dirty === false ? "clean" : o.local?.dirty === true ? `dirty (${o.local.changedFiles ?? "?"})` : "unknown"}`
  ];
}

function agentInstructions(agent, item) {
  if (agent === "human") {
    return [
      "Resolve the account/platform blocker described by this gate.",
      "Use the authorized provider dashboard for account or platform configuration; do not hand that action to a coding agent.",
      "After the blocker is cleared, re-run the affected check and return concrete evidence to SUMI."
    ];
  }
  if (agent === "codex") {
    return [
      "Act as an independent reviewer, not the original implementer.",
      "Inspect the current diff/PR and repository evidence before proposing changes.",
      "Focus on correctness, regressions, security, and whether the stated gate can actually be considered complete.",
      "Do not merge or mutate production unless explicitly authorized."
    ];
  }
  if (agent === "browser") {
    return [
      "Collect runtime/browser evidence for the target gate.",
      "Use the current branch/Preview only when it actually contains the target commit; do not mistake the existing Production deployment for the open PR.",
      "Report exact paths/actions checked, observed result, console/runtime errors, and whether the gate passed.",
      "Do not change code unless the task is handed back to a coding agent."
    ];
  }
  return [
    "Work in the registered local repository and verify repository state before changing anything.",
    "Diagnose first, then make the smallest safe change needed for this target only.",
    "Run the relevant tests/typecheck/build/diff checks and report concrete evidence.",
    "Do not redo already completed scope items or perform destructive/production mutations without explicit approval."
  ];
}

export function buildAgentPrompt(project, item) {
  const scopeLine = item.scopeId ? `${item.scopeId}: ${item.task}` : item.task;
  const dependency = item.state === "waiting"
    ? `\nPrecondition: WAITING — ${item.reason}`
    : item.state === "claimed"
      ? `\nPrecondition: CLAIMED — ${item.reason}`
      : item.reason ? `\nRouting note: ${item.reason}` : "";
  return `# SUMI DISPATCH — ${project.name}\n\nTarget agent: ${item.agent}\nMode: ${item.mode}\nTarget: ${scopeLine}\nRoute state: ${item.state}${dependency}\n\n## Current evidence\n${compactState(project).map((line) => `- ${line}`).join("\n")}\n\n## Assignment\n${item.task}\n\n## Agent instructions\n${agentInstructions(item.agent, item).map((line) => `- ${line}`).join("\n")}\n\n## Completion response\nReturn:\n1. What you inspected\n2. What you changed (if anything)\n3. Verification evidence\n4. Remaining blockers or uncertainty\n5. Whether this SUMI scope gate should stay open or can move to done\n`;
}

export function formatRoutePlan(project, plan = getRoutePlan(project)) {
  const ready = plan.filter((x) => x.state === "ready").length;
  const claimed = plan.filter((x) => x.state === "claimed").length;
  const waiting = plan.filter((x) => x.state === "waiting").length;
  const lines = [
    `ROUTE PLAN — ${project.name}`,
    `Assignments: ${plan.length} (${ready} ready${claimed ? `, ${claimed} claimed` : ""}${waiting ? `, ${waiting} waiting` : ""})`,
    ""
  ];
  if (!plan.length) {
    lines.push("No actionable NEXT items.");
    return lines.join("\n");
  }
  for (const item of plan) {
    const id = item.scopeId ? `${item.scopeId} ` : "";
    lines.push(`${item.order}. [${item.state.toUpperCase()}] ${id}${item.task}`);
    lines.push(`   -> ${item.agent} / ${item.mode}`);
    lines.push(`   Why: ${item.rationale}`);
    if (item.reason) lines.push(`   Note: ${item.reason}`);
  }
  lines.push("", "Generate one assignment prompt with:", "  sumi route <project> --prompt <scopeId|number>");
  return lines.join("\n");
}

export function selectRouteItem(plan, selector) {
  if (!selector) throw new Error("Route prompt selector is required (scope ID or route number).");
  const normalized = String(selector).toUpperCase();
  const byScope = plan.find((x) => x.scopeId === normalized);
  if (byScope) return byScope;
  const number = Number(selector);
  if (Number.isInteger(number) && number >= 1) {
    const byNumber = plan.find((x) => x.order === number);
    if (byNumber) return byNumber;
  }
  throw new Error(`Route item not found: ${selector}`);
}
