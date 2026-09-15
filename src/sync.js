import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getCompletion, touch } from "./domain.js";
import { classifyAction } from "./next.js";

const commandPathCache = new Map();

export function chooseResolvedCommand(stdout, platform = process.platform) {
  const candidates = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!candidates.length) return null;
  if (platform !== "win32") return candidates[0];

  // `where.exe` can return the extensionless npm shim before the Windows-executable
  // `.cmd` shim. spawnSync cannot execute that extensionless POSIX shim on Windows.
  const executable = candidates.find((item) => /\.(exe|cmd|bat|com)$/i.test(item));
  return executable || null;
}

function resolveCommand(command) {
  if (commandPathCache.has(command)) return commandPathCache.get(command);
  const checker = process.platform === "win32" ? "where.exe" : "which";
  const probe = spawnSync(checker, [command], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  const resolved = probe.status === 0 ? chooseResolvedCommand(probe.stdout, process.platform) : null;
  commandPathCache.set(command, resolved);
  return resolved;
}

function quoteCmdToken(value) {
  const text = String(value);
  if (/[\r\n\0]/.test(text)) throw new Error("Unsafe newline/NUL in command argument");
  // Explicit cmd.exe invocation is used only for Windows .cmd/.bat shims.
  // Reject cmd metacharacters instead of delegating escaping to shell:true.
  if (/[&|<>^%!]/.test(text)) throw new Error(`Unsafe cmd metacharacter in argument: ${text}`);
  return `"${text.replace(/"/g, '""')}"`;
}

export function buildSpawnInvocation(resolved, args, platform = process.platform, env = process.env) {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(resolved)) {
    const command = env.ComSpec || env.COMSPEC || "cmd.exe";
    // cmd.exe uses the active Windows console code page for its own error text.
    // Force UTF-8 before invoking the npm .cmd shim so stderr can be decoded reliably.
    // windowsVerbatimArguments avoids Node adding backslash-escaped quote characters
    // that cmd.exe can interpret as part of the command name.
    const commandLine = `chcp 65001>nul & call ${[quoteCmdToken(resolved), ...args.map(quoteCmdToken)].join(" ")}`;
    return {
      command,
      args: ["/d", "/c", commandLine],
      shell: false,
      windowsVerbatimArguments: true
    };
  }
  return { command: resolved, args, shell: false, windowsVerbatimArguments: false };
}

export function runCommand(command, args, options = {}) {
  const resolved = resolveCommand(command) || command;
  let invocation;
  try {
    invocation = buildSpawnInvocation(resolved, args);
  } catch (error) {
    return { ok: false, status: null, signal: null, stdout: "", stderr: "", error: error.message, errorCode: "EUNSAFEARG", timedOut: false };
  }
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    encoding: "utf8",
    shell: invocation.shell,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    windowsHide: true,
    timeout: options.timeout ?? 15000,
    env: { ...process.env, CI: process.env.CI || "1" },
    maxBuffer: 1024 * 1024 * 4
  });
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal || null,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    error: result.error?.message || null,
    errorCode: result.error?.code || null,
    timedOut: result.error?.code === "ETIMEDOUT"
  };
}

export function commandExists(command) {
  return Boolean(resolveCommand(command));
}

function statusOfCheck(check) {
  return String(check?.conclusion || check?.state || check?.status || "").toUpperCase();
}

export function mapChecks(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return "unknown";
  const states = checks.map(statusOfCheck);
  if (states.some((s) => ["FAILURE", "FAILED", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(s))) return "failed";
  if (states.some((s) => ["QUEUED", "IN_PROGRESS", "PENDING", "EXPECTED", "REQUESTED", "WAITING"].includes(s))) return "pending";
  if (states.every((s) => ["SUCCESS", "NEUTRAL", "SKIPPED", "COMPLETED"].includes(s))) return "ready";
  return "unknown";
}

export function summarizeChecks(checks) {
  if (!Array.isArray(checks)) return [];
  return checks.map((check) => ({
    name: check.name || check.context || check.workflowName || "check",
    status: check.status || check.state || null,
    conclusion: check.conclusion || null,
    url: check.detailsUrl || check.targetUrl || check.url || null
  }));
}

function readVercelLink(localPath) {
  const file = path.join(localPath, ".vercel", "project.json");
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      projectId: parsed.projectId ?? null,
      orgId: parsed.orgId ?? null,
      projectName: parsed.projectName ?? null
    };
  } catch {
    return null;
  }
}

export function mapVercelStatus(status) {
  const value = String(status || "").toUpperCase();
  if (value === "READY") return "ready";
  if (value === "ERROR") return "failed";
  if (["CANCELED", "CANCELLED"].includes(value)) return "cancelled";
  if (["BUILDING", "INITIALIZING", "QUEUED"].includes(value)) return "pending";
  return "unknown";
}

export function parseVercelList(text) {
  const rows = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (!line) continue;
    const url = line.match(/https?:\/\/[^\s]+|[a-z0-9][a-z0-9.-]*\.vercel\.app/i)?.[0] || null;
    // Do not parse deployment state/environment from the deployment URL itself.
    // Branch aliases can legitimately contain words like "cancelled" or "preview".
    const metadataText = url ? line.replace(url, " ") : line;
    const status = metadataText.match(/\b(READY|ERROR|BUILDING|INITIALIZING|QUEUED|CANCELED|CANCELLED)\b/i)?.[1]?.toUpperCase() || null;
    const environment = metadataText.match(/\b(Production|Preview|Development|Staging)\b/i)?.[1] || null;
    if (url || status) rows.push({ url: url && !/^https?:\/\//i.test(url) ? `https://${url}` : url, status, environment, raw: line });
  }
  return rows;
}

function pickVercelDeployment(text, preferredEnvironment = null) {
  const rows = parseVercelList(text);
  if (!rows.length) return null;
  if (preferredEnvironment) {
    const found = rows.find((row) => String(row.environment || "").toLowerCase() === preferredEnvironment.toLowerCase());
    if (found) return found;
  }
  return rows.find((row) => row.url) || rows[0];
}

function isEmptyVercelList(text) {
  return /(?:^|\n)\s*>?\s*No deployments found\.?\s*(?:\n|$)/i.test(String(text || ""));
}

export function parseSupabaseProjects(text) {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.projects)) return parsed.projects;
    return [];
  } catch {
    return [];
  }
}

function resolveSupabaseCli(localPath) {
  if (commandExists("supabase")) return { command: "supabase", prefix: [] };
  if (!localPath) return null;
  try {
    const packageFile = path.join(localPath, "package.json");
    if (!fs.existsSync(packageFile)) return null;
    const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
    if (pkg.dependencies?.supabase || pkg.devDependencies?.supabase) {
      return { command: "npx", prefix: ["--no-install", "supabase"] };
    }
  } catch {
    return null;
  }
  return null;
}

export function shouldSyncVercelPreview(project) {
  if (!project.deployment?.commit) return false;
  if (project.deployment.pr !== null && project.deployment.pr !== undefined) return true;
  return !getCompletion(project).complete;
}

export function syncVercel(project, observations, dependencies = {}) {
  const runner = dependencies.runner || runCommand;
  observations.vercel.cliAvailable = dependencies.commandAvailable ?? commandExists("vercel");
  if (!observations.vercel.cliAvailable) {
    if (observations.vercel.linked || project.vercel) observations.warnings.push("Vercel CLI is not installed; deployment sync skipped");
    return;
  }
  const projectName = project.vercel || observations.vercel.projectName;
  if (!projectName) return;

  const cwd = project.local && fs.existsSync(project.local) ? project.local : undefined;
  const sha = project.deployment.commit;
  if (shouldSyncVercelPreview(project)) {
    const preview = runner("vercel", ["list", projectName, "--environment=preview", "--meta", `githubCommitSha=${sha}`, "--no-color"], { cwd, timeout: 30000 });
    if (preview.ok) {
      const output = [preview.stdout, preview.stderr].filter(Boolean).join("\n");
      const item = pickVercelDeployment(output, "Preview");
      const status = item ? mapVercelStatus(item.status) : "unknown";
      if (item && status !== "unknown") {
        observations.vercel.preview = { status: item.status, url: item.url, environment: item.environment, raw: item.raw };
        project.deployment.preview = status;
      } else if (isEmptyVercelList(output)) {
        observations.warnings.push(`Vercel preview deployment not found for commit ${sha.slice(0, 12)}`);
      } else {
        observations.warnings.push("Vercel preview command succeeded but deployment output could not be parsed");
      }
    } else {
      observations.warnings.push(`Vercel preview sync failed: ${preview.stderr || preview.error || "unknown error"}`);
    }
  }

  const prod = runner("vercel", ["list", projectName, "--prod", "--no-color"], { cwd, timeout: 30000 });
  if (prod.ok) {
    const item = pickVercelDeployment([prod.stdout, prod.stderr].filter(Boolean).join("\n"), "Production");
    if (item) {
      observations.vercel.production = { status: item.status, url: item.url, environment: item.environment, raw: item.raw };
      // "ready" means the latest production deployment is healthy. Only an explicit human/browser check promotes it to "verified".
      if (project.deployment.production !== "verified") project.deployment.production = mapVercelStatus(item.status);
    } else {
      observations.warnings.push("Vercel production command succeeded but deployment output could not be parsed");
    }
  } else {
    observations.warnings.push(`Vercel production sync failed: ${prod.stderr || prod.error || "unknown error"}`);
  }
}

function syncSupabase(project, observations) {
  observations.supabase.configured = Boolean(project.supabase);
  if (!project.supabase) return;
  const cli = resolveSupabaseCli(project.local);
  observations.supabase.cliAvailable = Boolean(cli);
  if (!cli) {
    observations.warnings.push("Supabase CLI is not installed for this project; health sync skipped");
    return;
  }
  const result = runCommand(cli.command, [...cli.prefix, "projects", "list", "--output", "json"], { cwd: project.local && fs.existsSync(project.local) ? project.local : undefined, timeout: 45000 });
  if (!result.ok) {
    observations.warnings.push(result.timedOut
      ? "Supabase project sync timed out after 45s; CLI/network authentication should be checked with `sumi doctor`"
      : `Supabase project sync failed: ${result.stderr || result.error || "unknown error"}`);
    return;
  }
  const projects = parseSupabaseProjects(result.stdout);
  const match = projects.find((item) => item.ref === project.supabase || item.id === project.supabase);
  if (!match) {
    observations.warnings.push(`Supabase project not found in CLI account: ${project.supabase}`);
    return;
  }
  const status = match.status || match.state || null;
  observations.supabase = {
    ...observations.supabase,
    found: true,
    id: match.id || match.ref || project.supabase,
    ref: match.ref || match.id || project.supabase,
    name: match.name || null,
    region: match.region || null,
    status,
    healthy: String(status || "").toUpperCase() === "ACTIVE_HEALTHY"
  };
}

function pushUnique(list, text) {
  if (text && !list.includes(text)) list.push(text);
}

function redactLine(line) {
  return line
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED_API_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .slice(0, 240);
}

function summarizeFailureLog(text) {
  if (!text) return [];
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim())
    .filter(Boolean)
    .filter((line) => /##\[error\]|\berror\b|\bfail(?:ed|ure)?\b|npm ERR!/i.test(line))
    .map(redactLine);
  return [...new Set(rows)].slice(-6);
}

function inferManualVerification(body) {
  if (!body) return { required: false, status: "unknown", label: null, evidence: null };
  const mentionsBrowser = /ブラウザ|browser/i.test(body);
  if (!mentionsBrowser) return { required: false, status: "unknown", label: null, evidence: null };
  if (/未実施|未確認|未検証|not\s+(tested|verified|checked)/i.test(body)) {
    return { required: true, status: "pending", label: "browser/manual verification", evidence: "PR body says browser/manual verification is not complete" };
  }
  if (/実施済|確認済|検証済|verified|tested|checked/i.test(body)) {
    return { required: true, status: "ready", label: "browser/manual verification", evidence: "PR body indicates browser/manual verification is complete" };
  }
  return { required: true, status: "pending", label: "browser/manual verification", evidence: "PR body mentions browser verification" };
}

function hasProductionVerificationFailure(text) {
  const normalized = String(text || "").normalize("NFKC");
  return /(?:^|[\r\n.!?]\s*)(?:[-*]\s*)?(?:FAIL(?:ED|URE)?|CANCELLED|CANCELED)\s*:/i.test(normalized) ||
    /(?:production|smoke\s+test|verification|authentication|login|本番|検証|認証|ログイン)[^\r\n.]{0,120}(?:\b(?:failed|failure|cancelled|canceled|incomplete|not\s+(?:complete|completed|verified|successful)|did\s+not\s+(?:succeed|complete))\b|失敗|キャンセル|未完了|未検証)/i.test(normalized);
}

export function findStoredProductionVerification(project) {
  const completedProductionScopes = new Set(
    (project.scope?.criteria || [])
      .filter((item) => item.status === "done" && classifyAction(item.text) === "production-smoke")
      .map((item) => item.id)
  );
  if (!completedProductionScopes.size) return null;

  const result = [...(project.agentResults || [])].reverse().find((item) =>
    completedProductionScopes.has(item.scopeId) && ["browser", "human"].includes(item.agent)
  );
  if (!result) return null;

  return (
    completedProductionScopes.has(result.scopeId) &&
    result.targetDisposition?.action === "done" &&
    !(result.blockers || []).length &&
    (result.evidence || []).some((item) => item.key === "production-smoke") &&
    !hasProductionVerificationFailure(result.rawText)
  ) ? result : null;
}

export function aggregateStoredProductionVerification(project, observations) {
  const result = findStoredProductionVerification(project);
  if (!result) return null;

  const directVerification = observations.verification?.required && observations.verification.status !== "unknown";
  if (directVerification && !["ready", "verified"].includes(observations.verification.status)) return null;

  if (!directVerification) {
    const checks = (result.evidence || []).filter((item) => item.key === "production-smoke").length;
    observations.verification = {
      required: true,
      status: "ready",
      label: "production verification",
      evidence: `${result.id} ${result.scopeId} via ${result.agent}; ${checks} production smoke checks`,
      source: "stored-result",
      resultId: result.id
    };
  }

  project.deployment.production = "verified";
  const resultAt = Date.parse(result.createdAt);
  const checkedAt = Date.parse(project.deployment.productionCheckedAt);
  if (Number.isFinite(resultAt) && (!Number.isFinite(checkedAt) || resultAt > checkedAt)) {
    project.deployment.productionCheckedAt = result.createdAt;
  }
  return result;
}

function computeReadiness(project, observations) {
  const checks = [];
  if (observations.local.dirty !== null) {
    checks.push({ name: "local working tree clean", status: observations.local.dirty ? "failed" : "ready" });
  }
  if (project.deployment.pr) checks.push({ name: "pull request open", status: "ready" });
  if (project.deployment.ci !== "unknown") checks.push({ name: "CI", status: project.deployment.ci });
  if (observations.verification.required) {
    checks.push({ name: observations.verification.label, status: observations.verification.status });
  }
  if (project.deployment.preview !== "unknown") checks.push({ name: "preview", status: project.deployment.preview });

  const known = checks.filter((c) => c.status !== "unknown");
  return {
    checks,
    ready: known.filter((c) => c.status === "ready" || c.status === "verified").length,
    total: known.length,
    failed: known.filter((c) => c.status === "failed").length,
    pending: known.filter((c) => c.status === "pending").length,
    cancelled: known.filter((c) => c.status === "cancelled").length
  };
}

function inferNext(project, observations) {
  const inferred = [];
  if (observations.local.dirty) pushUnique(inferred, `ローカルの未コミット変更（${observations.local.changedFiles ?? "?"}件）を確認する`);
  if (project.deployment.ci === "failed") {
    const failedJob = observations.github.failedJobs?.[0];
    if (observations.github.baselineFailureLikely) {
      pushUnique(inferred, `CI障害が${observations.github.baselineCi?.branch || "default branch"}にもあるため、PR固有か基盤障害か切り分ける`);
    } else {
      pushUnique(inferred, failedJob ? `CI失敗を修正する: ${failedJob.name}` : "GitHub ActionsのCI失敗原因を確認して修正する");
    }
  } else if (project.deployment.ci === "pending") {
    pushUnique(inferred, "GitHub ActionsのCI完了を確認する");
  }
  if (observations.verification.required && observations.verification.status !== "ready") {
    pushUnique(inferred, `PR #${project.deployment.pr}を実ブラウザで検証する`);
  }
  if (project.deployment.preview === "failed") pushUnique(inferred, "Vercel Previewの失敗原因を確認する");
  if (project.deployment.preview === "cancelled") pushUnique(inferred, "Vercel Previewがキャンセルされた理由を確認する（Ignored Build Stepの可能性）");
  if (project.deployment.pr && project.deployment.ci === "ready" && project.deployment.preview === "unknown") pushUnique(inferred, `PR #${project.deployment.pr}のPreview環境を確認する`);
  if (project.deployment.pr && project.deployment.ci === "ready" && project.deployment.preview === "ready") pushUnique(inferred, `PR #${project.deployment.pr}をレビューしてマージ可否を判断する`);
  if (observations.supabase?.healthy === false) pushUnique(inferred, "Supabaseのプロジェクト状態を確認する");
  if (!project.deployment.pr && project.deployment.production === "failed") pushUnique(inferred, "Productionデプロイ失敗を確認する");
  else if (!project.deployment.pr && project.deployment.production !== "verified") pushUnique(inferred, "Productionの反映状態を確認する");
  return inferred.slice(0, 5);
}

function sameCommit(left, right) {
  return Boolean(left && right && String(left).toLowerCase() === String(right).toLowerCase());
}

export function selectCurrentOpenPr(list, branch, commitSha = null) {
  if (!branch || !Array.isArray(list)) return null;
  const matches = list.filter((pr) =>
    pr?.headRefName === branch && String(pr.state || "OPEN").toUpperCase() === "OPEN"
  );
  if (!matches.length) return null;
  return matches.find((pr) => sameCommit(pr.headRefOid, commitSha)) || matches[0];
}

export function summarizeBaselineCi(defaultBranch, runs) {
  if (!Array.isArray(runs) || runs.length === 0) {
    return { branch: defaultBranch, status: "unknown", conclusion: null, workflowName: null, url: null, headSha: null };
  }

  const latest = runs[0];
  const headSha = latest.headSha || null;
  const seenWorkflows = new Set();
  const currentRuns = runs.filter((run, index) => {
    if (!sameCommit(run.headSha, headSha)) return false;
    const workflow = run.workflowName || run.name || `run:${run.databaseId ?? index}`;
    if (seenWorkflows.has(workflow)) return false;
    seenWorkflows.add(workflow);
    return true;
  });
  const status = mapChecks(currentRuns);
  const representative = currentRuns.find((run) => mapChecks([run]) === status) || latest;

  return {
    branch: defaultBranch,
    status,
    conclusion: representative.conclusion || null,
    workflowName: representative.workflowName || representative.name || null,
    url: representative.url || null,
    headSha
  };
}

export function aggregateGithubCi(project, observations) {
  const deployment = project.deployment;
  if (deployment.pr !== null && deployment.pr !== undefined) return deployment.ci;

  const baseline = observations.github?.baselineCi;
  const matchesCurrentMain = baseline &&
    deployment.branch === baseline.branch &&
    sameCommit(deployment.commit, baseline.headSha);
  if (!matchesCurrentMain || baseline.status === "unknown") {
    deployment.ci = "unknown";
    return deployment.ci;
  }

  const priority = { unknown: 0, ready: 1, pending: 2, failed: 3 };
  const current = deployment.ci;
  deployment.ci = (priority[current] ?? 0) > (priority[baseline.status] ?? 0) ? current : baseline.status;
  return deployment.ci;
}

function syncBaselineCi(project, observations) {
  const repo = runCommand("gh", ["api", `repos/${project.repo}`, "--jq", ".default_branch"]);
  if (!repo.ok || !repo.stdout) {
    observations.warnings.push(`Default branch lookup skipped: ${repo.stderr || repo.error || "unknown error"}`);
    return;
  }
  const defaultBranch = repo.stdout.trim();
  const result = runCommand("gh", [
    "run", "list", "--repo", project.repo, "--branch", defaultBranch, "--limit", "20",
    "--json", "databaseId,name,workflowName,status,conclusion,url,event,headSha"
  ]);
  if (!result.ok) {
    observations.warnings.push(`Baseline CI sync skipped: ${result.stderr || result.error || "unknown error"}`);
    return;
  }
  try {
    const runs = JSON.parse(result.stdout || "[]");
    observations.github.baselineCi = summarizeBaselineCi(defaultBranch, runs);

    const failedWorkflow = observations.github.workflowRuns?.find((r) => String(r.conclusion || "").toLowerCase() === "failure");
    if (project.deployment.ci === "failed" && observations.github.baselineCi.status === "failed") {
      const currentName = failedWorkflow?.workflowName || failedWorkflow?.name || null;
      const baseName = observations.github.baselineCi.workflowName;
      observations.github.baselineFailureLikely = !currentName || !baseName || currentName === baseName;
    }
  } catch {
    observations.warnings.push("Baseline CI JSON could not be parsed");
  }
}

function syncRecentMergedPrs(project, observations) {
  const result = runCommand("gh", [
    "pr", "list", "--repo", project.repo,
    "--state", "merged", "--limit", "8",
    "--json", "number,title,mergedAt,url,headRefName"
  ]);
  if (!result.ok) {
    observations.warnings.push(`Recent merged PR sync skipped: ${result.stderr || result.error || "unknown error"}`);
    return;
  }
  try {
    observations.github.recentMergedPrs = JSON.parse(result.stdout || "[]").map((pr) => ({
      number: pr.number,
      title: pr.title,
      mergedAt: pr.mergedAt || null,
      url: pr.url || null,
      headRefName: pr.headRefName || null
    }));
  } catch {
    observations.warnings.push("Recent merged PR JSON could not be parsed");
  }
}

function syncGithubRunDetails(project, observations, commitSha) {
  if (!commitSha) return;
  const runsResult = runCommand("gh", [
    "run", "list", "--repo", project.repo,
    "--commit", commitSha, "--limit", "5",
    "--json", "databaseId,name,workflowName,status,conclusion,url,event,headSha"
  ]);
  if (!runsResult.ok) {
    observations.warnings.push(`GitHub Actions run detail sync skipped: ${runsResult.stderr || runsResult.error || "unknown error"}`);
    return;
  }

  try {
    const runs = JSON.parse(runsResult.stdout || "[]");
    observations.github.workflowRuns = runs;
    const failedRun = runs.find((r) => String(r.conclusion || "").toLowerCase() === "failure");
    if (!failedRun) return;

    const view = runCommand("gh", ["run", "view", String(failedRun.databaseId), "--repo", project.repo, "--json", "jobs,status,conclusion,url,name"]);
    if (view.ok) {
      const detail = JSON.parse(view.stdout || "{}");
      const jobs = Array.isArray(detail.jobs) ? detail.jobs : [];
      observations.github.failedJobs = jobs
        .filter((job) => String(job.conclusion || "").toLowerCase() === "failure")
        .map((job) => ({
          name: job.name || "job",
          conclusion: job.conclusion || null,
          url: job.url || null,
          failedSteps: (job.steps || []).filter((step) => String(step.conclusion || "").toLowerCase() === "failure").map((step) => step.name || "step")
        }));
    } else {
      observations.warnings.push(`GitHub Actions failed-job detail unavailable: ${view.stderr || view.error || "unknown error"}`);
    }

    const logs = runCommand("gh", ["run", "view", String(failedRun.databaseId), "--repo", project.repo, "--log-failed"]);
    if (logs.ok) observations.github.ciFailureSummary = summarizeFailureLog(logs.stdout);
    else observations.github.ciFailureLogAvailable = false;
  } catch {
    observations.warnings.push("GitHub Actions detail JSON could not be parsed");
  }
}


function commandDiagnostic(name, args = ["--version"], options = {}) {
  const resolved = resolveCommand(name);
  if (!resolved) return { name, available: false, resolved: null, ok: false, output: null, error: "not found", timedOut: false };
  const result = runCommand(name, args, { timeout: options.timeout ?? 15000, cwd: options.cwd });
  return {
    name,
    available: true,
    resolved,
    ok: result.ok,
    output: result.stdout || result.stderr || null,
    error: result.error,
    timedOut: result.timedOut
  };
}

export function diagnoseProject(project) {
  const cwd = project?.local && fs.existsSync(project.local) ? project.local : undefined;
  const tools = [];
  tools.push(commandDiagnostic("git", ["--version"], { cwd }));
  tools.push(commandDiagnostic("gh", ["auth", "status"], { cwd, timeout: 15000 }));
  tools.push(commandDiagnostic("vercel", ["whoami"], { cwd, timeout: 30000 }));
  tools.push(commandDiagnostic("agent-browser", ["--help"], { cwd, timeout: 15000 }));

  const supabaseCli = resolveSupabaseCli(project?.local);
  if (!supabaseCli) {
    tools.push({ name: "supabase", available: false, resolved: null, ok: false, output: null, error: "not found", timedOut: false });
  } else {
    const resolved = resolveCommand(supabaseCli.command);
    const result = runCommand(supabaseCli.command, [...supabaseCli.prefix, "projects", "list", "--output", "json"], { cwd, timeout: 45000 });
    tools.push({
      name: "supabase",
      available: true,
      resolved: resolved || supabaseCli.command,
      ok: result.ok,
      output: result.ok ? "authenticated project list available" : (result.stderr || null),
      error: result.error,
      timedOut: result.timedOut
    });
  }
  return tools;
}

export function parseGitPorcelain(text) {
  if (!text) return [];
  return String(text).split(/\r?\n/).filter(Boolean).map((line) => ({
    status: line.slice(0, 2),
    path: line.length > 3 ? line.slice(3) : line.slice(2).trim()
  }));
}

export function isTransientGeneratedChange(change) {
  const normalized = String(change?.path || "").replace(/\\/g, "/");
  return normalized === "supabase/.temp" || normalized === "supabase/.temp/" || normalized.startsWith("supabase/.temp/");
}

export function filterMeaningfulGitChanges(changes) {
  return (Array.isArray(changes) ? changes : []).filter((change) => !isTransientGeneratedChange(change));
}

export function syncProject(project, options = {}) {
  const observedAt = new Date().toISOString();
  const observations = {
    observedAt,
    local: { available: false, git: false, dirty: null, changedFiles: null, changes: [], lastCommitSubject: null },
    github: {
      source: "none", ghAvailable: false, openPrTitle: null, openPrBody: null, openPrUrl: null, openPrState: null,
      checks: [], workflowRuns: [], failedJobs: [], ciFailureSummary: [], ciFailureLogAvailable: true, recentMergedPrs: [],
      baselineCi: null, baselineFailureLikely: false, prListObserved: false
    },
    vercel: { linked: false, projectId: null, orgId: null, projectName: null, cliAvailable: false, preview: null, production: null },
    supabase: { configured: Boolean(project.supabase), cliAvailable: false, found: false, status: null, healthy: null, name: null, region: null },
    verification: { required: false, status: "unknown", label: null, evidence: null },
    readiness: { checks: [], ready: 0, total: 0, failed: 0, pending: 0, cancelled: 0 },
    inferredNext: [], warnings: []
  };

  if (!project.local) observations.warnings.push("local path is not configured");
  else if (!fs.existsSync(project.local)) observations.warnings.push(`local path not found: ${project.local}`);
  else {
    observations.local.available = true;
    const inside = runCommand("git", ["-C", project.local, "rev-parse", "--is-inside-work-tree"]);
    if (inside.ok && inside.stdout === "true") {
      observations.local.git = true;
      const branch = runCommand("git", ["-C", project.local, "branch", "--show-current"]);
      const commit = runCommand("git", ["-C", project.local, "rev-parse", "HEAD"]);
      const subject = runCommand("git", ["-C", project.local, "log", "-1", "--pretty=%s"]);
      const porcelain = runCommand("git", ["-C", project.local, "status", "--porcelain"]);
      if (branch.ok && branch.stdout) project.deployment.branch = branch.stdout;
      if (commit.ok && commit.stdout) project.deployment.commit = commit.stdout;
      if (subject.ok) observations.local.lastCommitSubject = subject.stdout || null;
      if (porcelain.ok) {
        const allChanges = parseGitPorcelain(porcelain.stdout);
        const changes = filterMeaningfulGitChanges(allChanges);
        const ignoredChanges = allChanges.filter((change) => isTransientGeneratedChange(change));
        observations.local.dirty = changes.length > 0;
        observations.local.changedFiles = changes.length;
        observations.local.changes = changes.slice(0, 20);
        observations.local.ignoredChanges = ignoredChanges.slice(0, 20);
      }
    } else observations.warnings.push("local path is not a Git worktree");

    const vercel = readVercelLink(project.local);
    if (vercel) {
      observations.vercel = { linked: true, ...vercel };
      if (!project.vercel && vercel.projectName) project.vercel = vercel.projectName;
    }
  }

  observations.github.ghAvailable = commandExists("gh");
  if (project.repo && observations.github.ghAvailable) {
    const prs = runCommand("gh", [
      "pr", "list", "--repo", project.repo, "--state", "open", "--limit", "20",
      "--json", "number,title,body,state,headRefName,headRefOid,url,statusCheckRollup"
    ]);
    if (prs.ok) {
      observations.github.source = "gh";
      try {
        const list = JSON.parse(prs.stdout || "[]");
        observations.github.prListObserved = true;
        const branch = project.deployment.branch;
        const current = selectCurrentOpenPr(list, branch, project.deployment.commit);
        if (current) {
          project.deployment.pr = Number(current.number);
          project.deployment.ci = mapChecks(current.statusCheckRollup);
          observations.github.openPrTitle = current.title || null;
          observations.github.openPrBody = current.body || null;
          observations.github.openPrUrl = current.url || null;
          observations.github.openPrState = current.state || "OPEN";
          observations.github.checks = summarizeChecks(current.statusCheckRollup);
          observations.verification = inferManualVerification(current.body || "");
          syncGithubRunDetails(project, observations, project.deployment.commit);
        } else {
          project.deployment.pr = null;
          project.deployment.ci = "unknown";
        }
      } catch {
        observations.warnings.push("GitHub CLI returned unreadable PR JSON");
      }
    } else observations.warnings.push(`GitHub CLI sync failed: ${prs.stderr || prs.error || "unknown error"}`);
    syncRecentMergedPrs(project, observations);
    syncBaselineCi(project, observations);
    if (observations.github.prListObserved) aggregateGithubCi(project, observations);
  } else if (project.repo && !observations.github.ghAvailable) {
    observations.warnings.push("GitHub CLI (gh) is not installed; PR/CI sync skipped");
  }

  aggregateStoredProductionVerification(project, observations);
  if (!options.skipVercel) syncVercel(project, observations);
  if (!options.skipSupabase) syncSupabase(project, observations);

  observations.readiness = computeReadiness(project, observations);
  observations.inferredNext = inferNext(project, observations);
  project.observations = observations;
  touch(project);
  return observations;
}
