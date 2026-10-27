/**
 * Project health signals: states of a project that nobody asked about but
 * somebody should know — independent of whether the project has a Scope.
 *
 * Two signals: CI health on the default branch, and whether that branch
 * reached production (further below).
 *
 * CI health: a CI that silently stopped (a workflow disabled by hand, Actions minutes exhausted, a workflow that
 * never triggers) looks exactly like a CI that is "not failing", and every
 * merge after it lands unverified. SUMI reports what it observed and how far
 * the default branch has moved since CI last ran, and never reports "ready"
 * for a commit no run covered.
 */

// No run for the head commit is "stale" (an alert) once either is reached;
// below both it is "unverified" (shown, not alerted): a run may still be
// starting, or path filters may legitimately skip a docs-only commit.
export const CI_STALE_DAYS = 7;
export const CI_STALE_COMMITS = 20;
// A head commit younger than this may simply not have its run created yet.
export const CI_START_GRACE_MINUTES = 15;

const DAY_MS = 24 * 60 * 60 * 1000;

export const CI_HEALTH_STATUSES = new Set(["current", "unverified", "stale", "disabled", "never", "none", "unknown"]);

function sameCommit(left, right) {
  return Boolean(left && right && String(left).toLowerCase() === String(right).toLowerCase());
}

function asTime(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : null;
}

/**
 * Pure assessment. Inputs come from GitHub REST:
 * - workflows: [{ name, state, path }]  (state: active | disabled_manually | disabled_inactivity | disabled_fork | deleted)
 * - runs: default-branch runs, newest first: [{ headSha, createdAt, url, status, conclusion, workflowName }]
 * - head: { sha, committedAt } of the default branch
 * - aheadBy: commits on the default branch since the last run's commit (null if unknown)
 */
export function assessCiHealth({ branch = null, workflows = null, runs = null, head = null, aheadBy = null, now = new Date() } = {}) {
  const at = now instanceof Date ? now.getTime() : Date.parse(now);
  const base = { branch, headSha: head?.sha || null, disabledWorkflows: [], lastRun: null, commitsSince: null, daysSince: null };
  if (!Array.isArray(workflows) || !Array.isArray(runs) || !head?.sha) {
    return { ...base, status: "unknown", summary: "CI health could not be read from GitHub" };
  }

  const live = workflows.filter((workflow) => workflow.state !== "deleted");
  const active = live.filter((workflow) => workflow.state === "active");
  const disabledWorkflows = live
    .filter((workflow) => workflow.state !== "active")
    .map((workflow) => ({ name: workflow.name, state: workflow.state, path: workflow.path || null }));
  if (!live.length) {
    return { ...base, status: "none", summary: "no GitHub Actions workflow is configured" };
  }

  const covering = runs.find((run) => sameCommit(run.headSha, head.sha));
  const last = runs[0] || null;
  const lastRun = last ? { sha: last.headSha || null, at: last.createdAt || null, url: last.url || null, workflowName: last.workflowName || null } : null;
  const lastAt = asTime(lastRun?.at);
  const daysSince = lastAt === null ? null : Math.floor((at - lastAt) / DAY_MS);
  const result = { ...base, disabledWorkflows, lastRun, commitsSince: covering ? 0 : aheadBy, daysSince };

  if (!active.length) {
    const names = disabledWorkflows.map((workflow) => `${workflow.name} (${workflow.state})`).join(", ");
    return {
      ...result,
      status: "disabled",
      summary: `every workflow is disabled: ${names}${describeGap(result)}`
    };
  }
  if (covering) {
    return { ...result, status: "current", summary: `CI ran for the current ${branch || "default branch"} commit` };
  }
  if (!last) {
    return { ...result, status: "never", summary: `${active.length} active workflow(s) but no run on ${branch || "the default branch"}` };
  }

  const headAt = asTime(head.committedAt);
  const fresh = headAt !== null && at - headAt < CI_START_GRACE_MINUTES * 60 * 1000;
  const stale = !fresh && (
    (daysSince !== null && daysSince >= CI_STALE_DAYS) ||
    (aheadBy !== null && aheadBy >= CI_STALE_COMMITS)
  );
  return {
    ...result,
    status: stale ? "stale" : "unverified",
    summary: `no CI run for the current ${branch || "default branch"} commit${describeGap(result)}`
  };
}

function describeGap(health) {
  if (!health.lastRun) return "; CI has never run on this branch";
  const parts = [];
  if (health.lastRun.at) parts.push(`last run ${String(health.lastRun.at).slice(0, 10)}`);
  if (health.lastRun.sha) parts.push(`@ ${String(health.lastRun.sha).slice(0, 12)}`);
  const since = [];
  if (health.commitsSince !== null && health.commitsSince !== undefined) since.push(`${health.commitsSince} commit(s)`);
  if (health.daysSince !== null && health.daysSince !== undefined) since.push(`${health.daysSince} day(s)`);
  return `; ${parts.join(" ")}${since.length ? `, ${since.join(" / ")} since` : ""}`;
}

// --- Production deploy health -------------------------------------------
//
// Whether the default branch's latest commit reached production, read from
// the commit statuses Vercel's Git integration posts on GitHub. Works in
// GitHub-source mode with no Vercel CLI or token. What it cannot see: a
// rollback or promotion done inside Vercel, which leaves no status on GitHub.

// A deploy pending longer than this is "stuck".
export const DEPLOY_STUCK_MINUTES = 30;
// Commits scanned back from the head to find the last completed deploy.
export const DEPLOY_SCAN_COMMITS = 30;

/** deployed | ignored | pending | failed | canceled | none */
export function classifyVercelStatus(status) {
  if (!status) return "none";
  const state = String(status.state || "").toLowerCase();
  const text = String(status.description || "");
  if (state === "pending") return "pending";
  if (state === "success") return /ignored build step/i.test(text) ? "ignored" : "deployed";
  if (state === "failure" || state === "error") return /cancel/i.test(text) ? "canceled" : "failed";
  return "none";
}

const DEPLOY_RANK = { failed: 6, behind: 5, canceled: 4, stuck: 3, stale: 2, unknown: 1, unverified: 1, deploying: 1, current: 0 };

/**
 * Pure assessment.
 * - commits: the default branch's newest commits, newest first, each
 *   { sha, committedAt, statuses: [{ context, state, description, url, updatedAt }] | null }
 *   (statuses null = not read; the scan may stop early)
 * - scanLimit: how many commits a full scan would have read
 * - truncated: the scan stopped on a read error, so commits past it are unknown
 */
export function assessDeployHealth({ branch = null, commits = null, scanLimit = DEPLOY_SCAN_COMMITS, truncated = false, now = new Date() } = {}) {
  const at = now instanceof Date ? now.getTime() : Date.parse(now);
  const base = { branch, headSha: commits?.[0]?.sha || null, targets: [] };
  if (!Array.isArray(commits) || !commits.length || !Array.isArray(commits[0].statuses)) {
    return { ...base, status: "unknown", summary: "production deploy state could not be read from GitHub" };
  }
  const read = commits.filter((commit) => Array.isArray(commit.statuses));
  const contexts = [...new Set(read.flatMap((commit) => commit.statuses.map((status) => status.context)))];
  if (!contexts.length) {
    return { ...base, status: "none", summary: `no Vercel deploy status on the last ${read.length} ${branch || "default branch"} commit(s)` };
  }
  const targets = contexts.map((context) => assessTarget(context, read, { at, scanLimit, branch, truncated }));
  const worst = targets.reduce((a, b) => (DEPLOY_RANK[b.status] > DEPLOY_RANK[a.status] ? b : a));
  const summary = targets.length === 1 ? worst.summary : targets.map((target) => `${target.context}: ${target.status} — ${target.summary}`).join("; ");
  return { ...base, status: worst.status, summary, targets };
}

function assessTarget(context, commits, { at, scanLimit, branch, truncated }) {
  const kindOf = (commit) => classifyVercelStatus(commit.statuses.find((status) => status.context === context));
  const head = commits[0];
  const headStatus = head.statuses.find((status) => status.context === context) || null;
  const headKind = kindOf(head);
  const deployedAt = commits.findIndex((commit) => kindOf(commit) === "deployed");
  const between = (deployedAt === -1 ? commits : commits.slice(0, deployedAt)).map(kindOf);
  const lastDeploy = deployedAt === -1 ? null : { sha: commits[deployedAt].sha, committedAt: commits[deployedAt].committedAt };
  const behind = deployedAt === -1 ? null : deployedAt;
  const where = lastDeploy
    ? `production is at ${lastDeploy.sha.slice(0, 12)}${lastDeploy.committedAt ? ` (${String(lastDeploy.committedAt).slice(0, 10)})` : ""}, ${behind} commit(s) behind ${branch || "the default branch"}`
    : `no completed deploy in the last ${commits.length} commit(s)${commits.length >= scanLimit ? " scanned" : ""}`;
  const result = { context, headKind, lastDeploy, commitsBehind: behind, url: headStatus?.url || null };

  if (headKind === "deployed") return { ...result, status: "current", summary: `the latest ${branch || "default branch"} commit is deployed` };
  if (headKind === "pending") {
    const since = Date.parse(headStatus?.updatedAt || "");
    const minutes = Number.isFinite(since) ? Math.floor((at - since) / 60000) : null;
    if (minutes !== null && minutes >= DEPLOY_STUCK_MINUTES) {
      return { ...result, status: "stuck", summary: `the deploy of the latest commit has been pending for ${minutes} minute(s); ${where}` };
    }
    return { ...result, status: "deploying", summary: `the latest commit is deploying; ${where}` };
  }
  if (headKind === "failed") return { ...result, status: "failed", summary: `the deploy of the latest commit failed (${headStatus.description || "failure"}); ${where}` };
  if (headKind === "canceled") return { ...result, status: "canceled", summary: `the deploy of the latest commit was canceled (${headStatus.description || "canceled"}); ${where}` };

  // The head was skipped (Ignored Build Step) or has no status.
  if (between.some((kind) => kind === "failed" || kind === "canceled")) {
    return { ...result, status: "behind", summary: `a commit after the last production deploy failed or was canceled and no later commit deployed; ${where}` };
  }
  if (!lastDeploy) {
    if (truncated) return { ...result, status: "unknown", summary: `the scan stopped before the last completed deploy was found (${commits.length} commit(s) read)` };
    return { ...result, status: "behind", summary: where };
  }
  if (headKind === "ignored") {
    return { ...result, status: "current", summary: `the latest commit was skipped by Ignored Build Step; ${where}` };
  }
  const days = lastDeploy.committedAt ? Math.floor((at - Date.parse(lastDeploy.committedAt)) / DAY_MS) : null;
  const headAge = Date.parse(head.committedAt || "");
  const fresh = Number.isFinite(headAge) && at - headAge < DEPLOY_STUCK_MINUTES * 60000;
  if (!fresh && ((days !== null && days >= CI_STALE_DAYS) || behind >= CI_STALE_COMMITS)) {
    return { ...result, status: "stale", summary: `Vercel posted no deploy for the latest commit; ${where}` };
  }
  return { ...result, status: "unverified", summary: `no Vercel deploy status on the latest commit yet; ${where}` };
}

export function formatDeployHealth(health) {
  if (!health) return "not observed";
  return `${health.status} — ${health.summary}`;
}

function deployServesHead(project) {
  const deploy = project?.observations?.github?.deployHealth;
  const ci = project?.observations?.github?.ciHealth;
  return Boolean(deploy && ci?.headSha && deploy.headSha === ci.headSha && deploy.status === "current");
}

/**
 * Alerts are what `queue`, `dashboard`, `continue` and `handoff` surface for
 * every project, scoped or not. They are not work items: they carry no Scope
 * ID and are never numbered, so they cannot shift `queue --prompt <n>`.
 */
export function getHealthAlerts(project) {
  return [...ciAlerts(project), ...deployAlerts(project)];
}

function ciAlerts(project) {
  const health = project?.observations?.github?.ciHealth;
  if (!health) return [];
  const live = deployServesHead(project) ? "; production is serving these unverified commits" : "";
  if (health.status === "disabled") {
    return [{ key: "ci-disabled", severity: "high", owner: "human", text: `CI is switched off — ${health.summary}${live}` }];
  }
  if (health.status === "stale") {
    return [{ key: "ci-stale", severity: "high", owner: "human", text: `CI has stopped running — ${health.summary}${live}` }];
  }
  if (health.status === "never") {
    return [{ key: "ci-never", severity: "medium", owner: "human", text: `CI never ran — ${health.summary}` }];
  }
  return [];
}

const DEPLOY_ALERTS = {
  failed: ["deploy-failed", "high", "Production is behind main — the latest deploy failed"],
  behind: ["deploy-behind", "high", "Production is behind main"],
  canceled: ["deploy-canceled", "medium", "Production is behind main — the latest deploy was canceled"],
  stuck: ["deploy-stuck", "medium", "Production deploy is stuck"],
  stale: ["deploy-stale", "medium", "Vercel has stopped deploying main"]
};

function deployAlerts(project) {
  const health = project?.observations?.github?.deployHealth;
  const spec = health && DEPLOY_ALERTS[health.status];
  if (!spec) return [];
  const [key, severity, title] = spec;
  return [{ key, severity, owner: "human", text: `${title} — ${health.summary}` }];
}

export function formatCiHealth(health) {
  if (!health) return "not observed";
  return `${health.status} — ${health.summary}`;
}

// --- Health report (`sumi health`) ----------------------------------------

const SEVERITY_RANK = { medium: 1, high: 2 };

/**
 * One row per project: CI health, production deploy health, alerts, and what
 * could not be observed. A project whose health could not be read is listed
 * under NOT OBSERVED, never folded into "no alerts".
 */
export function buildHealthReport(projects, { syncErrors = {}, now = new Date() } = {}) {
  const rows = Object.values(projects || {})
    .sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3) || String(a.id).localeCompare(String(b.id)))
    .map((project) => {
      const github = project.observations?.github || {};
      const ci = github.ciHealth || null;
      const deploy = github.deployHealth || null;
      const vercelUnused = project.vercel === "none";
      const gaps = [];
      if (syncErrors[project.id]) gaps.push(`sync failed: ${syncErrors[project.id]}`);
      if (!project.repo) gaps.push("no repository registered");
      else {
        if (!ci || ci.status === "unknown") gaps.push(`CI health ${ci ? "unknown" : "not observed"}`);
        if (!vercelUnused && (!deploy || deploy.status === "unknown")) gaps.push(`production deploy ${deploy ? "unknown" : "not observed"}`);
      }
      const notes = gaps.length
        ? (project.observations?.warnings || []).filter((w) => /CI health|Production deploy|Default branch|Baseline CI|GitHub/i.test(w))
        : [];
      return {
        id: project.id,
        name: project.name,
        priority: project.priority ?? 3,
        syncedAt: project.observations?.syncedAt ?? null,
        ciHealth: ci ? { status: ci.status, summary: ci.summary } : null,
        deployHealth: deploy ? { status: deploy.status, summary: deploy.summary } : null,
        vercelUnused,
        alerts: getHealthAlerts(project),
        notObserved: gaps,
        notes
      };
    });
  const count = (severity) => rows.reduce((n, row) => n + row.alerts.filter((a) => a.severity === severity).length, 0);
  return {
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    totals: { projects: rows.length, high: count("high"), medium: count("medium"), notObserved: rows.filter((row) => row.notObserved.length).length },
    projects: rows
  };
}

/** Whether any alert is at or above `level` (high | medium). */
export function reportHasAlertsAtLeast(report, level) {
  const min = SEVERITY_RANK[level];
  if (!min) throw new Error(`--fail-on must be high or medium, not ${level}`);
  return report.projects.some((row) => row.alerts.some((alert) => (SEVERITY_RANK[alert.severity] || 0) >= min));
}

export function formatHealthReport(report) {
  const { totals } = report;
  const status = (h, unused = false) => (h ? h.status : unused ? "(no vercel)" : "—");
  const clip = (text, max = 200) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  const lines = [
    `SUMI HEALTH — ${report.generatedAt}`,
    "=".repeat(72),
    `${totals.projects} project(s): ${totals.high} high, ${totals.medium} medium alert(s); ${totals.notObserved} not fully observed`,
    "",
    `${"PROJECT".padEnd(22)}${"CI HEALTH".padEnd(13)}${"PROD DEPLOY".padEnd(13)}ALERTS`,
    "-".repeat(72)
  ];
  for (const row of report.projects) {
    const alerts = row.alerts.length ? row.alerts.map((a) => a.severity).join(", ") : row.notObserved.length ? "? (not observed)" : "—";
    lines.push(`${String(row.id).padEnd(22)}${status(row.ciHealth).padEnd(13)}${status(row.deployHealth, row.vercelUnused).padEnd(13)}${alerts}`);
  }
  const alerting = report.projects.filter((row) => row.alerts.length);
  if (alerting.length) {
    lines.push("", "ALERTS (human; not work items)");
    for (const row of alerting) for (const alert of row.alerts) lines.push(`  ! ${row.id} [${alert.severity}] ${alert.text}`);
  }
  const blind = report.projects.filter((row) => row.notObserved.length);
  if (blind.length) {
    lines.push("", "NOT OBSERVED (absence of alerts here means nothing)");
    for (const row of blind) {
      lines.push(`  ? ${row.id}: ${row.notObserved.join("; ")}`);
      for (const note of row.notes.slice(0, 2)) lines.push(`      - ${clip(note)}`);
    }
  }
  if (!alerting.length && !blind.length) lines.push("", "No health alerts.");
  return `${lines.join("\n")}\n`;
}
