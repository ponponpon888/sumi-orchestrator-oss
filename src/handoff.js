import { getCompletion, getServiceState, getSetupGaps } from "./domain.js";
import { buildNextQueue } from "./next.js";

function bullet(items, fallback = "- なし") {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : fallback;
}

export function formatHandoff(project) {
  const c = getCompletion(project);
  const done = project.tasks.filter((t) => t.status === "done").map((t) => `${t.id} ${t.title}`);
  const doing = project.tasks.filter((t) => t.status === "doing").map((t) => `${t.id} ${t.title}`);
  const blocked = project.tasks.filter((t) => t.status === "blocked").map((t) => `${t.id} ${t.title}`);
  const todo = project.tasks.filter((t) => t.status === "todo").map((t) => `${t.id} ${t.title}`);
  const next = buildNextQueue(project, { limit: 8 });
  const decisions = project.decisions.slice(-5).map((d) => d.reason ? `${d.text} — ${d.reason}` : d.text);
  const o = project.observations || {};
  const scopeDoing = (project.scope?.criteria || []).filter((item) => item.status === "doing").map((item) => `${item.id} ${item.text}`);
  const scopeBlocked = (project.scope?.criteria || []).filter((item) => item.status === "blocked").map((item) => `${item.id} ${item.text}`);
  const inferredCurrent = doing.length === 0 && scopeDoing.length === 0 && o.github?.openPrTitle ? [`PR #${project.deployment.pr}: ${o.github.openPrTitle}`] : [];
  const current = [...doing, ...scopeDoing, ...inferredCurrent];
  const allBlocked = [...blocked, ...scopeBlocked];
  const progress = c.percent === null ? "未算出" : `${c.percent}% (${c.done}/${c.total}, basis=${c.basis})`;
  const readiness = o.readiness?.total ? `${o.readiness.ready}/${o.readiness.total} ready${o.readiness.failed ? `, ${o.readiness.failed} failed` : ""}${o.readiness.pending ? `, ${o.readiness.pending} pending` : ""}${o.readiness.cancelled ? `, ${o.readiness.cancelled} cancelled` : ""}` : "未算出";
  const failedJobs = (o.github?.failedJobs || []).map((job) => job.failedSteps?.length ? `${job.name} — failed step: ${job.failedSteps.join(", ")}` : `${job.name} — failed step detail unavailable`);
  const failureSummary = (o.github?.ciFailureSummary || []).map((line) => `log: ${line}`);
  const recentMerged = (o.github?.recentMergedPrs || []).slice(0, 8).map((pr) => `PR #${pr.number} ${pr.title}${pr.mergedAt ? ` (${pr.mergedAt})` : ""}`);
  const baselineCi = o.github?.baselineCi ? `${o.github.baselineCi.branch}: ${o.github.baselineCi.status}${o.github.baselineFailureLikely ? " — current failure may be baseline/infrastructure-related" : ""}` : "unknown";
  const verification = o.verification?.required ? `${o.verification.status}: ${o.verification.label}${o.verification.evidence ? ` — ${o.verification.evidence}` : ""}` : "not detected";
  const preview = o.vercel?.preview?.url ? `${project.deployment.preview} — ${o.vercel.preview.url}` : project.deployment.preview;
  const production = o.vercel?.production?.url ? `${project.deployment.production} — ${o.vercel.production.url}` : project.deployment.production;
  const vercelService = getServiceState(project, "vercel");
  const supabaseService = getServiceState(project, "supabase");
  const serviceLabel = (service) => service.state === "registered" ? service.name : service.state === "unused" ? "不使用（none）" : "未登録";
  const setupGapLines = getSetupGaps(project).map((gap) => `${gap.title} — ${gap.commands[0]}`);
  const supabase = supabaseService.state === "unused"
    ? "不使用（none）"
    : supabaseService.state === "unregistered"
      ? "not configured"
      : o.supabase?.found ? `${o.supabase.status || "unknown"}${o.supabase.region ? ` (${o.supabase.region})` : ""}` : "unknown";
  const localChanges = (o.local?.changes || []).slice(0, 10).map((item) => `${item.status} ${item.path}`);
  const scope = (project.scope?.criteria || []).map((item) => `${item.id} [${item.status}] ${item.text}`);
  const progressBasis = c.basis === "scope" ? `scope: ${project.scope?.title || "Project completion"}` : c.basis === "tasks" ? "managed tasks (no explicit completion scope)" : "none";
  const agentResults = (project.agentResults || []).slice(-3).map((item) => `${item.id} ${item.scopeId} via ${item.agent}${item.targetDisposition?.action ? ` — ${item.targetDisposition.action}` : ""} — evidence ${item.evidence?.length || 0}`);

  return `# SUMI HANDOFF — ${project.name}\n\n## Project\n- ID: ${project.id}\n- Repository: ${project.repo ?? "未設定"}\n- Local: ${project.local ?? "未設定"}\n- Vercel: ${serviceLabel(vercelService)}\n- Supabase: ${serviceLabel(supabaseService)}\n\n## Current state\n- Project progress: ${progress}\n- Progress basis: ${progressBasis}\n- Current work readiness: ${readiness}\n- Branch: ${project.deployment.branch ?? "不明"}\n- Commit: ${project.deployment.commit ?? "不明"}\n- PR: ${project.deployment.pr ?? "なし/不明"}\n- CI: ${project.deployment.ci}\n- Manual verification: ${verification}\n- Preview: ${preview}\n- Production: ${production}\n- Supabase health: ${supabase}\n- Local working tree: ${o.local?.dirty === true ? `DIRTY (${o.local.changedFiles ?? "?"} files)` : o.local?.dirty === false ? "clean" : "不明"}\n- Last local commit: ${o.local?.lastCommitSubject ?? "不明"}\n\n## Current\n${bullet(current)}\n\n## Completion scope\n${bullet(scope)}\n\n## Done (managed tasks)\n${bullet(done)}\n\n## Recent observed done (merged PRs)\n${bullet(recentMerged)}\n\n## Blocked\n${bullet(blocked)}\n\n## Next\n${bullet(next.length ? next : todo.slice(0, 5))}\n\n## CI diagnostics\n${bullet([...failedJobs, ...failureSummary])}\n- Baseline CI: ${baselineCi}\n\n## Recent decisions\n${bullet(decisions)}\n\n## Observed GitHub\n- Open PR title: ${o.github?.openPrTitle ?? "なし/不明"}\n- Open PR URL: ${o.github?.openPrUrl ?? "なし/不明"}\n\n## Sync notes\n${bullet(o.warnings || [])}\n\n## Setup gaps\n${bullet(setupGapLines)}\n\n## Instruction to the next AI\nBefore changing code, verify the repository state and the items above. Treat project progress and current-work readiness as different concepts. Do not infer that the whole project is complete from a single PR. Do not redo merged/completed work unless current evidence shows it is invalid. Resolve failed checks and pending verification before declaring the current work complete.\n`;
}
