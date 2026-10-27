import { getCompletion, getProjectStateLabel, getServiceState, getSetupGaps, PROJECT_STATES } from "./domain.js";
import { buildNextQueue } from "./next.js";
import { formatCiHealth, formatDeployHealth, getHealthAlerts } from "./health.js";

export function healthAlertLines(project, indent = "  ") {
  return getHealthAlerts(project).map((alert) => `${indent}! [${alert.severity}] ${alert.text}`);
}

function healthSection(project) {
  const lines = healthAlertLines(project);
  return lines.length ? `\nHEALTH ALERTS\n${lines.join("\n")}\n` : "";
}

function ciDetail(project) {
  const failedJobs = project.observations?.github?.failedJobs || [];
  const summary = project.observations?.github?.ciFailureSummary || [];
  const baseline = project.observations?.github?.baselineCi || null;
  if (!failedJobs.length && !summary.length && !baseline) return "";
  const rows = failedJobs.map((job) => {
    const steps = job.failedSteps?.length ? ` / failed step: ${job.failedSteps.join(", ")}` : " / failed step: unavailable";
    return `  ${job.name}${steps}`;
  });
  if (summary.length) rows.push(...summary.map((line) => `    ↳ ${line}`));
  if (baseline) {
    rows.push(`  BASELINE ${baseline.branch}: ${baseline.status}${project.observations?.github?.baselineFailureLikely ? " (same failure class likely)" : ""}`);
  }
  return `\nCI DETAIL\n${rows.join("\n")}\n`;
}


export function sourceLabel(project) {
  if (project.source !== "github") return "local clone";
  const observed = project.observations?.source;
  if (observed?.error) {
    const last = observed.lastKnownCommit ? `; last seen ${observed.lastKnownCommit.slice(0, 12)}, not current` : "";
    return `GitHub (mirror refresh failed: ${observed.error}${last})`;
  }
  if (observed?.commit) return `GitHub ${observed.branch} @ ${observed.commit.slice(0, 12)} (refreshed ${observed.refreshedAt})`;
  return "GitHub (not refreshed yet; run sumi sync)";
}

function localChanges(project) {
  const changes = project.observations?.local?.changes || [];
  if (!changes.length) return "";
  return `\nLOCAL CHANGES\n${changes.slice(0, 10).map((item) => `  ${item.status} ${item.path}`).join("\n")}\n`;
}

function openScope(project) {
  const criteria = project.scope?.criteria || [];
  if (!criteria.length) return "";
  const open = criteria.filter((item) => !["done", "cancelled"].includes(item.status));
  const lines = open.slice(0, 8).map((item) => `  ${item.id} [${item.status}] ${item.text}`);
  if (!lines.length) lines.push("  すべての完成条件がdone");
  return `\nOPEN SCOPE — ${project.scope?.title || "Project completion"}\n${lines.join("\n")}\n`;
}


function latestAgentResult(project) {
  const item = project.agentResults?.at(-1);
  if (!item) return "";
  const disposition = item.targetDisposition?.action ? ` / ${item.targetDisposition.action}` : "";
  return `\nLATEST RESULT\n  ${item.id} ${item.scopeId} via ${item.agent}${disposition} / evidence ${item.evidence?.length || 0}\n`;
}

function setupSection(project) {
  const gaps = getSetupGaps(project);
  if (!gaps.length) return "";
  const rows = gaps.flatMap((gap, index) => [
    `  ${index + 1}. ${gap.title}`,
    ...gap.commands.map((command) => `     ${command}`)
  ]);
  return `\nSETUP REQUIRED\n${rows.join("\n")}\n`;
}

function recentDone(project) {
  const prs = project.observations?.github?.recentMergedPrs || [];
  if (!prs.length) return "";
  return `\nRECENT MERGED\n${prs.slice(0, 5).map((pr) => `  #${pr.number} ${pr.title}`).join("\n")}\n`;
}

export function formatProject(project) {
  const c = getCompletion(project);
  const p = c.percent === null ? "—" : `${c.percent}% (${c.done}/${c.total} ${c.basis})`;
  const observedPr = project.observations?.github?.openPrTitle;
  const scopeCriteria = project.scope?.criteria || [];
  const currentItems = c.current.map((t) => `${t.id} ${t.title}`);
  currentItems.push(...scopeCriteria.filter((item) => item.status === "doing").map((item) => `${item.id} ${item.text}`));
  if (currentItems.length === 0 && observedPr) currentItems.push(`PR #${project.deployment.pr}: ${observedPr}`);
  const current = currentItems.join("\n  ") || "なし";
  const blockedItems = [
    ...c.blockers.map((t) => `${t.id} ${t.title}`),
    ...scopeCriteria.filter((item) => item.status === "blocked").map((item) => `${item.id} ${item.text}`)
  ];
  const blocked = blockedItems.join("\n  ") || "なし";
  const next = buildNextQueue(project, { limit: 5 });
  const nextText = next.length ? next.map((text, i) => `${i + 1}. ${text}`).join("\n") : "なし";
  const latestDecision = project.decisions.at(-1);
  const doneLabel = getProjectStateLabel(project);
  const setupGaps = getSetupGaps(project);
  const setupLabel = setupGaps.length ? `incomplete: ${setupGaps.map((gap) => gap.key).join(", ")}` : "ok";
  const o = project.observations;
  const localState = o?.local?.dirty === true ? `dirty (${o.local.changedFiles ?? "?"})` : o?.local?.dirty === false ? "clean" : "unknown";
  const synced = o?.observedAt ? new Date(o.observedAt).toLocaleString() : "—";
  const vercelService = getServiceState(project, "vercel");
  const vercelLink = vercelService.state === "unused"
    ? "not used"
    : o?.vercel?.linked
      ? `linked${o.vercel.projectId ? ` (${o.vercel.projectId})` : ""}`
      : vercelService.state === "registered" ? `registered (${vercelService.name})` : "not registered";
  const vercelPreview = o?.vercel?.preview?.url ? `${project.deployment.preview} ${o.vercel.preview.url}` : project.deployment.preview;
  const vercelProduction = o?.vercel?.production?.url ? `${project.deployment.production} ${o.vercel.production.url}` : project.deployment.production;
  const supabaseService = getServiceState(project, "supabase");
  const supabaseState = supabaseService.state === "unused"
    ? "not used"
    : supabaseService.state === "unregistered"
      ? "not configured"
      : o?.supabase?.found ? `${o.supabase.status || "unknown"}${o.supabase.region ? ` (${o.supabase.region})` : ""}` : o?.supabase?.cliAvailable ? "not found" : "unknown";
  const readiness = o?.readiness?.total ? `${o.readiness.ready}/${o.readiness.total} ready${o.readiness.failed ? ` / ${o.readiness.failed} failed` : ""}${o.readiness.pending ? ` / ${o.readiness.pending} pending` : ""}${o.readiness.cancelled ? ` / ${o.readiness.cancelled} cancelled` : ""}` : "—";
  const verification = o?.verification?.required ? `${o.verification.status} (${o.verification.label})` : "not detected";

  return `\n${project.name} [${project.id}]\n${"─".repeat(Math.max(24, project.name.length + project.id.length + 3))}\nSTATE       ${doneLabel}\nPRIORITY    P${project.priority ?? 3}\nPROGRESS    ${p}\nSETUP       ${setupLabel}\nWORK READY  ${readiness}\nREPO        ${project.repo ?? "—"}\nSOURCE      ${sourceLabel(project)}\nLOCAL       ${project.local ?? "—"}\nBRANCH      ${project.deployment.branch ?? "—"}\nCOMMIT      ${project.deployment.commit ? project.deployment.commit.slice(0, 12) : "—"}\nPR          ${project.deployment.pr ?? "—"}\nCI          ${project.deployment.ci}\nCI HEALTH   ${formatCiHealth(project.observations?.github?.ciHealth)}\nPROD DEPLOY ${formatDeployHealth(project.observations?.github?.deployHealth)}\nVERIFY      ${verification}\nPREVIEW     ${vercelPreview}\nPRODUCTION  ${vercelProduction}\nVERCEL      ${vercelLink}\nSUPABASE    ${supabaseState}\nWORKTREE    ${localState}\nSYNCED      ${synced}\n${healthSection(project)}\nCURRENT\n  ${current}\n\nBLOCKED\n  ${blocked}\n\nNEXT\n${nextText}\n${setupSection(project)}${localChanges(project)}${ciDetail(project)}${recentDone(project)}${openScope(project)}${latestAgentResult(project)}\nLATEST DECISION\n${latestDecision ? `  ${latestDecision.text}${latestDecision.reason ? `\n  Reason: ${latestDecision.reason}` : ""}` : "  なし"}\n`;
}

export function formatDashboard(projects) {
  const rows = Object.values(projects)
    .sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3) || a.name.localeCompare(b.name))
    .map((p) => {
      const c = getCompletion(p);
      const progress = c.percent === null ? "  —" : `${String(c.percent).padStart(3)}%`;
      const scopeBlocked = (p.scope?.criteria || []).some((item) => item.status === "blocked");
      const scopeDoing = (p.scope?.criteria || []).some((item) => item.status === "doing");
      const gaps = getSetupGaps(p);
      const unscoped = getProjectStateLabel(p) === PROJECT_STATES.UNSCOPED;
      const state = c.complete
        ? "DONE"
        : c.blockers.length || scopeBlocked
          ? "BLOCKED"
          : c.current.length || scopeDoing || p.observations?.github?.openPrTitle
            ? "DOING"
            : unscoped ? "UNSCOPED" : "READY";
      const next = buildNextQueue(p, { limit: 1 })[0]
        ?? c.todos[0]?.title
        ?? p.observations?.github?.openPrTitle
        ?? (gaps.length ? `setup: ${gaps.map((gap) => gap.key).join(", ")}` : "—");
      return `${p.id.padEnd(20)} P${p.priority ?? 3}   ${progress.padEnd(5)} ${state.padEnd(8)} ${next}`;
    });
  const alerts = Object.values(projects)
    .sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3) || a.name.localeCompare(b.name))
    .flatMap((p) => getHealthAlerts(p).map((alert) => `  ! ${p.id}: [${alert.severity}] ${alert.text}`));
  const alertBlock = alerts.length ? `\nHEALTH ALERTS\n${alerts.join("\n")}\n` : "";
  return `SUMI DASHBOARD\n${"=".repeat(72)}\nPROJECT              PRI  PROG  STATE    NEXT\n${"-".repeat(72)}\n${rows.join("\n") || "No projects yet."}\n${alertBlock}`;
}
