import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { getAgentAdapter, isAutomaticSessionAdapter } from "./adapters.js";
import { touch } from "./domain.js";
import { buildSpawnInvocation, chooseResolvedCommand } from "./sync.js";
import { buildSessionPrompt, createSessionTestContext, ingestSessionResult, inspectSessionWorkspace, validateSessionLease } from "./sessions.js";

const commandPathCache = new Map();
const PRODUCTION_TIME_SOURCE = Object.freeze({ testOnly: false, read: () => new Date() });

function canonicalPath(value) {
  try { return fs.realpathSync.native(path.resolve(value)); }
  catch { return path.resolve(value); }
}

function samePath(left, right) {
  const a = canonicalPath(left);
  const b = canonicalPath(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(parent, candidate) {
  const relative = path.relative(canonicalPath(parent), canonicalPath(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function gitRoot(cwd) {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true
    }).trim();
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || "").trim();
    throw new Error(`Cannot verify session Git worktree: ${detail || cwd}`);
  }
}

function resolveCommand(command) {
  if (commandPathCache.has(command)) return commandPathCache.get(command);
  const checker = process.platform === "win32" ? "where.exe" : "which";
  const probe = spawnSync(checker, [command], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  const resolved = probe.status === 0 ? chooseResolvedCommand(probe.stdout, process.platform) : null;
  commandPathCache.set(command, resolved);
  return resolved;
}

export function parseClaudeJson(text) {
  try {
    const payload = JSON.parse(String(text || "").trim());
    return typeof payload?.result === "string" && payload.result.trim() ? payload.result.trim() : null;
  } catch {
    return null;
  }
}

export function claudeArgsFromHelp(helpText, prompt) {
  const help = String(helpText || "");
  for (const flag of ["--output-format", "--permission-mode", "--permission-prompts", "--setting-sources"]) {
    if (!help.includes(flag)) throw new Error(`Claude Code does not advertise ${flag}; update Claude Code before isolated automatic execution.`);
  }
  return ["-p", prompt, "--output-format", "json", "--permission-mode", "acceptEdits",
    "--permission-prompts", "none", "--setting-sources", "user"];
}

function runProcess({ resolved, args, cwd, timeoutMs = 30 * 60 * 1000 }) {
  return new Promise((resolve) => {
    let invocation;
    try { invocation = buildSpawnInvocation(resolved, args); }
    catch (error) {
      resolve({ ok: false, status: null, stdout: "", stderr: "", error: error.message, timedOut: false });
      return;
    }
    const child = spawn(invocation.command, invocation.args, {
      cwd, shell: invocation.shell, windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      windowsHide: true, env: { ...process.env, CI: process.env.CI || "1" }, stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "", stderr = "", settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, status: null, stdout, stderr, error: `Agent timed out after ${timeoutMs}ms`, timedOut: true });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => finish({ ok: false, status: null, stdout, stderr, error: error.message, timedOut: false }));
    child.on("close", (code) => finish({ ok: code === 0, status: code, stdout, stderr, error: null, timedOut: false }));
  });
}

function validateSession(project, sessionId, now, sessionApi = { validateSessionLease }) {
  const { session: record } = sessionApi.validateSessionLease(project, sessionId, { now });
  const adapter = getAgentAdapter(record.agent);
  if (!adapter || !isAutomaticSessionAdapter(adapter, "execute")) {
    throw new Error(`Session agent ${record.agent} has no automatic isolated execution adapter.`);
  }
  if (!adapter.requiresIsolation) throw new Error(`Adapter ${adapter.id} is not marked isolation-required.`);

  const workspace = record.workspace || {};
  if (workspace.mode !== "worktree" || !workspace.created || workspace.removedAt) {
    throw new Error(`Session ${record.id} must own a live SUMI-created worktree for automatic execution.`);
  }
  if (!workspace.path || !fs.existsSync(workspace.path)) throw new Error(`Session worktree is missing: ${workspace.path || "—"}`);
  if (!project.local || !fs.existsSync(project.local)) throw new Error(`Primary repository is missing: ${project.local || "—"}`);

  const primaryRoot = canonicalPath(gitRoot(project.local));
  const recordedRoot = canonicalPath(workspace.repoRoot || "");
  const cwd = canonicalPath(workspace.path);
  const worktreeRoot = canonicalPath(gitRoot(cwd));
  if (!samePath(primaryRoot, recordedRoot)) throw new Error("Session worktree metadata does not match the registered primary repository.");
  if (!samePath(cwd, worktreeRoot)) throw new Error("Session workspace path is not the root of its Git worktree.");
  if (isInside(primaryRoot, cwd)) throw new Error("Refusing automatic execution inside the primary worktree.");

  const inspection = inspectSessionWorkspace(project, record.id);
  if (!inspection.git || inspection.warnings?.length) {
    throw new Error(`Session worktree validation failed: ${inspection.warnings?.join(" ") || "not a Git worktree"}`);
  }
  return { record, adapter, cwd };
}

function recordExecution(project, record, entry) {
  if (!Array.isArray(record.executions)) record.executions = [];
  record.executions.push(entry);
  touch(project);
  return entry;
}

async function runSessionAgentWithClock(project, sessionId, {
  apply = false,
  finish = false,
  runner = null,
  now = undefined,
  clock = null
} = {}, timeSource = PRODUCTION_TIME_SOURCE, sessionApi = { buildSessionPrompt, ingestSessionResult, validateSessionLease }) {
  const injectedRunner = typeof runner === "function";
  const trustedClock = timeSource.testOnly && typeof clock === "function"
    ? clock
    : timeSource.read;
  const currentValue = timeSource.testOnly && now !== undefined
    ? now
    : timeSource.read();
  const current = currentValue instanceof Date ? currentValue : new Date(currentValue);
  if (Number.isNaN(current.getTime())) throw new Error(`Invalid execution timestamp: ${currentValue}`);
  const { record, adapter, cwd } = validateSession(project, sessionId, current, sessionApi);
  const executionIdentity = Object.freeze({
    sessionId: record.id,
    owner: record.owner,
    agent: record.agent
  });
  const prompt = sessionApi.buildSessionPrompt(project, executionIdentity.sessionId, { now: current });
  const attempt = (record.executions?.length || 0) + 1;
  const startedAt = current.toISOString();

  let execution;
  try {
    if (injectedRunner) execution = await runner({ project, session: record, adapter, cwd, prompt });
    else {
      const resolved = resolveCommand(adapter.command);
      if (!resolved) throw new Error("Claude Code CLI not found. Install/login to Claude Code before running this session.");
      const helpInvocation = buildSpawnInvocation(resolved, ["--help"]);
      const probe = spawnSync(helpInvocation.command, helpInvocation.args, {
        cwd, encoding: "utf8", shell: helpInvocation.shell,
        windowsVerbatimArguments: helpInvocation.windowsVerbatimArguments,
        windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 * 2
      });
      if (probe.status !== 0) throw new Error(`Claude Code CLI probe failed: ${String(probe.stderr || probe.error?.message || "unknown error").trim()}`);
      execution = await runProcess({
        resolved,
        args: claudeArgsFromHelp(`${probe.stdout || ""}\n${probe.stderr || ""}`, prompt),
        cwd
      });
    }
  } catch (error) {
    execution = { ok: false, status: null, stdout: "", stderr: "", error: error.message, timedOut: false };
  }

  const completedAtValue = trustedClock();
  const completedAtDate = completedAtValue instanceof Date ? completedAtValue : new Date(completedAtValue);
  const completedAt = Number.isNaN(completedAtDate.getTime())
    ? null
    : completedAtDate.toISOString();
  const baseEntry = { attempt, adapter: adapter.id, capability: adapter.capability, cwd, startedAt, completedAt };
  // A clock failure must not hide an agent failure: keep the agent's own exit
  // status (null when it never produced one) and append its failure reason.
  const agentFailed = !execution?.ok;
  const agentFailureReason = execution?.error || String(execution?.stderr || "").trim() || "Agent execution failed.";
  const clockFailureEntry = (reason) => ({
    ...baseEntry, status: "failed",
    exitStatus: agentFailed ? (execution?.status ?? null) : (execution.status ?? 0),
    reason: agentFailed ? `${reason} Agent execution also failed: ${agentFailureReason}` : reason,
    resultId: null
  });
  if (!completedAt) {
    const entry = recordExecution(project, record, clockFailureEntry(
      `Trusted execution clock returned an invalid completion timestamp: ${completedAtValue}.`
    ));
    return { session: record, adapter, prompt, execution: entry, result: null, analysis: null, applied: null };
  }
  if (completedAtDate.getTime() < current.getTime()) {
    const entry = recordExecution(project, record, clockFailureEntry(
      "Execution completed before it started; refusing a system clock rollback."
    ));
    return { session: record, adapter, prompt, execution: entry, result: null, analysis: null, applied: null };
  }
  if (agentFailed) {
    const entry = recordExecution(project, record, {
      ...baseEntry, status: "failed", exitStatus: execution?.status ?? null,
      reason: agentFailureReason, resultId: null
    });
    return { session: record, adapter, prompt, execution: entry, result: null, analysis: null, applied: null };
  }

  const resultText = execution.resultText || parseClaudeJson(execution.stdout);
  if (!resultText) {
    const entry = recordExecution(project, record, {
      ...baseEntry, status: "failed", exitStatus: execution.status ?? 0,
      reason: "Claude Code exited successfully but returned no JSON result text.", resultId: null
    });
    return { session: record, adapter, prompt, execution: entry, result: null, analysis: null, applied: null };
  }

  let outcome;
  try {
    outcome = sessionApi.ingestSessionResult(project, executionIdentity.sessionId, resultText, {
      apply,
      finish,
      now: completedAtDate,
      minimumNow: completedAtDate,
      expectedSessionId: executionIdentity.sessionId,
      expectedOwner: executionIdentity.owner,
      expectedAgent: executionIdentity.agent
    });
  } catch (error) {
    if (error?.code !== "SESSION_LEASE_INVALID") throw error;
    const entry = recordExecution(project, record, {
      ...baseEntry, status: "failed", exitStatus: execution.status ?? 0,
      reason: error.message, resultId: null
    });
    return { session: record, adapter, prompt, execution: entry, result: null, analysis: null, applied: null };
  }
  const entry = recordExecution(project, record, {
    ...baseEntry, status: "completed", exitStatus: execution.status ?? 0, reason: null, resultId: outcome.result.id
  });
  outcome.result.sessionExecutionAttempt = attempt;
  return { ...outcome, adapter, prompt, execution: entry };
}

export async function runSessionAgent(project, sessionId, options = {}) {
  return runSessionAgentWithClock(project, sessionId, options, PRODUCTION_TIME_SOURCE, {
    buildSessionPrompt,
    ingestSessionResult,
    validateSessionLease
  });
}

// Test-only adapter. Production callers always use the real process clock;
// deterministic clocks are available only through this explicit test context.
export function createSessionExecutorTestContext(clock = () => new Date(), sessionContext = null) {
  const timeSource = { testOnly: true, read: clock };
  const sessions = sessionContext || createSessionTestContext(clock);
  return Object.freeze({
    runSessionAgent: (project, sessionId, options = {}) => runSessionAgentWithClock(
      project,
      sessionId,
      options,
      timeSource,
      {
        buildSessionPrompt: sessions.buildSessionPrompt,
        ingestSessionResult: sessions.ingestSessionResult,
        validateSessionLease: sessions.validateSessionLease
      }
    )
  });
}

export function formatSessionAgentRun(project, outcome, { applied = false } = {}) {
  const lines = [
    `SESSION AGENT RUN — ${project.name} / ${outcome.session.id}`,
    `Scope: ${outcome.session.scopeId}`,
    `Agent: ${outcome.session.agent}`,
    `Adapter: ${outcome.adapter.id} / ${outcome.adapter.capability}`,
    `Workspace: ${outcome.execution.cwd}`,
    `Attempt: ${outcome.execution.attempt}`,
    `Status: ${outcome.execution.status}`
  ];
  if (outcome.execution.status === "failed") {
    lines.push(`Error: ${outcome.execution.reason}`);
    return lines.join("\n");
  }
  lines.push(`Result: ${outcome.result.id}`);
  lines.push(`Session status: ${outcome.session.status}`);
  lines.push(`Applied: ${applied ? "yes" : "no"}`);
  lines.push(`Disposition: ${outcome.analysis.targetDisposition?.action || "none"}`);
  return lines.join("\n");
}
