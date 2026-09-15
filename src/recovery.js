import { classifyAction } from "./next.js";
import { setScopeCriterionStatus } from "./domain.js";

function findCriterion(project, scopeId) {
  return (project.scope?.criteria || []).find((item) => item.id === scopeId) || null;
}

function sourceResultForCriterion(project, criterionId) {
  const rows = [...(project.agentResults || [])].reverse();
  return rows.find((result) =>
    (result.addedCriteria || []).some((item) => item.criterionId === criterionId) ||
    (result.statusChanges || []).some((item) => item.criterionId === criterionId)
  ) || null;
}

function billingEvidence(result) {
  if (!result) return [];
  return (result.evidence || []).filter((item) => item.key === "github-billing");
}

function failedSteps(project) {
  return (project.observations?.github?.failedJobs || []).flatMap((job) =>
    (job.failedSteps || []).map((step) => ({ job: job.name || "job", step }))
  );
}

export function getBlockerRecovery(project, scopeId) {
  const criterion = findCriterion(project, scopeId);
  if (!criterion) throw new Error(`Scope criterion not found: ${scopeId}`);

  const key = classifyAction(criterion.text);
  const sourceResult = sourceResultForCriterion(project, criterion.id);
  const sourceEvidence = billingEvidence(sourceResult);
  const ci = project.deployment?.ci || "unknown";
  const steps = failedSteps(project);
  const workflowRuns = project.observations?.github?.workflowRuns || [];
  const latestRun = workflowRuns[0] || null;

  const result = {
    criterion,
    key,
    currentStatus: criterion.status,
    ci,
    sourceResult,
    sourceEvidence,
    liveEvidence: [],
    suggestion: null
  };

  if (criterion.status !== "blocked") {
    result.liveEvidence.push(`Gate is currently ${criterion.status}, not blocked`);
    return result;
  }

  if (key !== "ci-billing") {
    result.liveEvidence.push("No automatic recovery rule exists for this blocker type");
    return result;
  }

  if (ci === "ready") {
    result.liveEvidence.push("Current PR CI is ready");
    result.suggestion = {
      from: "blocked",
      to: "done",
      confidence: "high",
      reason: "CI is now ready, so the billing blocker is no longer preventing execution and the gate's CI-success condition is satisfied."
    };
    return result;
  }

  if (steps.length > 0) {
    result.liveEvidence.push(...steps.map((item) => `Runner executed failing step: ${item.job} / ${item.step}`));
    result.suggestion = {
      from: "blocked",
      to: "doing",
      confidence: "high",
      reason: "A GitHub Actions runner executed workflow steps, proving billing is no longer blocking runner startup; the remaining CI failure needs normal engineering diagnosis."
    };
    return result;
  }

  if (ci === "pending") {
    result.liveEvidence.push(latestRun?.status ? `Current workflow status: ${latestRun.status}` : "Current CI is pending");
    result.suggestion = {
      from: "blocked",
      to: "doing",
      confidence: "medium",
      reason: "CI is pending, which may indicate runner scheduling has resumed, but successful runner execution is not yet proven."
    };
    return result;
  }

  if (ci === "failed") {
    const failedJobs = project.observations?.github?.failedJobs || [];
    if (failedJobs.length) {
      result.liveEvidence.push(`CI still failed: ${failedJobs.map((job) => job.name).join(", ")}`);
      result.liveEvidence.push("No failed workflow step was reported, so runner startup recovery is not proven.");
    } else {
      result.liveEvidence.push("CI is still failed and no runner-step evidence is available.");
    }
    if (sourceEvidence.length) result.liveEvidence.push("Previous evidence identified GitHub Billing / spending limit as the blocker.");
    return result;
  }

  result.liveEvidence.push(`Current CI state is ${ci}; blocker recovery cannot be proven.`);
  return result;
}

export function applyBlockerRecovery(project, recovery) {
  if (!recovery?.suggestion || recovery.suggestion.confidence !== "high") return null;
  const item = setScopeCriterionStatus(project, recovery.criterion.id, recovery.suggestion.to);
  return {
    criterionId: item.id,
    from: recovery.suggestion.from,
    to: item.status,
    reason: recovery.suggestion.reason
  };
}

export function formatBlockerRecovery(project, recovery) {
  const lines = [
    `BLOCKER RECOVERY — ${project.name} / ${recovery.criterion.id}`,
    `Gate: ${recovery.criterion.text}`,
    `Current status: ${recovery.currentStatus}`,
    `Live CI: ${recovery.ci}`,
    ""
  ];

  if (recovery.sourceResult) {
    lines.push(`SOURCE ${recovery.sourceResult.id} ${recovery.sourceResult.agent || "unknown"}`);
    for (const item of recovery.sourceEvidence) {
      lines.push(`  ✓ ${item.label}${item.detail ? ` — ${item.detail}` : ""}`);
    }
    lines.push("");
  }

  lines.push("LIVE EVIDENCE");
  for (const item of recovery.liveEvidence) lines.push(`  ${item}`);
  if (!recovery.liveEvidence.length) lines.push("  No live recovery evidence available.");
  lines.push("");

  if (recovery.suggestion) {
    lines.push("SUGGESTED TRANSITION");
    lines.push(`  ${recovery.criterion.id} ${recovery.suggestion.from} -> ${recovery.suggestion.to} [${recovery.suggestion.confidence.toUpperCase()}]`);
    lines.push(`  ${recovery.suggestion.reason}`);
    if (recovery.suggestion.confidence === "high") lines.push("", "Use --apply to apply this high-confidence recovery transition.");
    else lines.push("", "This transition needs more evidence and is not auto-applied.");
  } else {
    lines.push("NO TRANSITION");
    lines.push("  Keep this gate blocked until current evidence proves the external blocker has cleared.");
  }

  return lines.join("\n");
}
