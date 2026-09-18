import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { buildSpawnInvocation, chooseResolvedCommand } from "./sync.js";
import { buildAgentPrompt, getRoutePlan, selectRouteItem } from "./router.js";
import { analyzeAgentResult, applyAgentResult, recordAgentResult } from "./result.js";
import { touch } from "./domain.js";
import { getAgentAdapter, isAutomaticAdapter } from "./adapters.js";

const commandPathCache = new Map();

function resolveCommand(command) {
  if (commandPathCache.has(command)) return commandPathCache.get(command);
  const checker = process.platform === "win32" ? "where.exe" : "which";
  const probe = spawnSync(checker, [command], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  const resolved = probe.status === 0 ? chooseResolvedCommand(probe.stdout, process.platform) : null;
  commandPathCache.set(command, resolved);
  return resolved;
}

function nextDispatchId(project) {
  if (!Array.isArray(project.dispatches)) project.dispatches = [];
  const seq = project.dispatches.reduce((max, item) => Math.max(max, Number(item.seq) || 0), 0) + 1;
  return { id: `D${String(seq).padStart(3, "0")}`, seq };
}

export function parseCodexJsonl(text) {
  const messages = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === "item.completed" && event?.item?.type === "agent_message" && event.item.text) {
        messages.push(String(event.item.text));
      }
      if (event?.type === "response.output_text.done" && event.text) messages.push(String(event.text));
    } catch {
      // Ignore non-JSON status lines so newer/older CLI versions remain usable.
    }
  }
  return messages.filter(Boolean).at(-1) || null;
}

function normalizeCodexOutput(stdout) {
  return parseCodexJsonl(stdout) || String(stdout || "").trim() || null;
}

function probeCodex(execPath, cwd) {
  const invocation = buildSpawnInvocation(execPath, ["exec", "--help"]);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    shell: invocation.shell,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 1024 * 1024 * 2
  });
  return {
    ok: result.status === 0,
    text: `${result.stdout || ""}\n${result.stderr || ""}`,
    error: result.error?.message || null
  };
}

function codexArgsFromHelp(helpText) {
  const text = String(helpText || "");
  const args = ["exec"];
  if (/--json\b/.test(text)) args.push("--json");
  if (/--ephemeral\b/.test(text)) args.push("--ephemeral");
  if (/--sandbox\b/.test(text)) args.push("--sandbox", "read-only");
  return args;
}

function runProcessWithInput({ resolved, args, cwd, input, timeoutMs = 20 * 60 * 1000 }) {
  return new Promise((resolve) => {
    let invocation;
    try {
      invocation = buildSpawnInvocation(resolved, args);
    } catch (error) {
      resolve({ ok: false, status: null, stdout: "", stderr: "", error: error.message, timedOut: false });
      return;
    }

    const child = spawn(invocation.command, invocation.args, {
      cwd,
      shell: invocation.shell,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      windowsHide: true,
      env: { ...process.env, CI: process.env.CI || "1" },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      settled = true;
      resolve({ ok: false, status: null, stdout, stderr, error: `Agent timed out after ${timeoutMs}ms`, timedOut: true });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, status: null, stdout, stderr, error: error.message, timedOut: false });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, status: code, stdout, stderr, error: null, timedOut: false });
    });

    child.stdin?.write(input);
    child.stdin?.end();
  });
}

export function prepareDispatch(project, selector) {
  const plan = getRoutePlan(project);
  const item = selectRouteItem(plan, selector);
  const prompt = buildAgentPrompt(project, item);
  const adapter = getAgentAdapter(item.agent);
  if (item.state !== "ready") {
    return { executable: false, reason: item.reason || "Route item is waiting.", adapter, item, prompt };
  }
  if (!adapter) {
    return { executable: false, manual: true, reason: `No registered adapter for agent: ${item.agent}`, adapter: null, item, prompt };
  }
  if (!isAutomaticAdapter(adapter, item.mode)) {
    return { executable: false, manual: true, reason: adapter.manualReason, adapter, item, prompt };
  }
  return { executable: true, adapter, item, prompt };
}

export async function dispatchProject(project, selector, { apply = false, runner = null } = {}) {
  const prepared = prepareDispatch(project, selector);
  const meta = nextDispatchId(project);
  const startedAt = new Date().toISOString();

  if (!prepared.executable) {
    const record = {
      ...meta,
      scopeId: prepared.item.scopeId,
      agent: prepared.item.agent,
      adapter: prepared.adapter?.id || null,
      capability: prepared.adapter?.capability || null,
      mode: prepared.item.mode,
      state: prepared.item.state,
      status: prepared.manual ? "manual" : "waiting",
      reason: prepared.reason,
      startedAt,
      completedAt: new Date().toISOString(),
      resultId: null
    };
    project.dispatches.push(record);
    touch(project);
    return { ...prepared, dispatch: record, result: null, analysis: null, applied: null };
  }

  let execution;
  if (runner) {
    execution = await runner({ project, item: prepared.item, prompt: prepared.prompt });
  } else {
    const resolved = resolveCommand(prepared.adapter.command);
    if (!resolved) throw new Error("Codex CLI not found. Install/login to Codex CLI or use `sumi route ... --prompt ...` manually.");
    if (!project.local || !fs.existsSync(project.local)) throw new Error(`Registered local repository does not exist: ${project.local || "—"}`);

    const probe = probeCodex(resolved, project.local);
    if (!probe.ok) throw new Error(`Codex CLI probe failed: ${probe.error || probe.text.trim() || "unknown error"}`);
    if (!/--sandbox\b/.test(probe.text)) {
      throw new Error("Codex CLI does not advertise --sandbox; refusing automatic review because read-only enforcement cannot be confirmed.");
    }
    const args = codexArgsFromHelp(probe.text);
    execution = await runProcessWithInput({ resolved, args, cwd: project.local, input: prepared.prompt });
  }

  if (!execution.ok) {
    const record = {
      ...meta,
      scopeId: prepared.item.scopeId,
      agent: prepared.item.agent,
      adapter: prepared.adapter?.id || null,
      capability: prepared.adapter?.capability || null,
      mode: prepared.item.mode,
      state: prepared.item.state,
      status: "failed",
      reason: execution.error || execution.stderr?.trim() || `exit ${execution.status}`,
      startedAt,
      completedAt: new Date().toISOString(),
      resultId: null
    };
    project.dispatches.push(record);
    touch(project);
    return { ...prepared, dispatch: record, execution, result: null, analysis: null, applied: null };
  }

  const resultText = execution.resultText || normalizeCodexOutput(execution.stdout);
  if (!resultText) {
    const record = {
      ...meta,
      scopeId: prepared.item.scopeId,
      agent: prepared.item.agent,
      adapter: prepared.adapter?.id || null,
      capability: prepared.adapter?.capability || null,
      mode: prepared.item.mode,
      state: prepared.item.state,
      status: "failed",
      reason: "Agent exited successfully but no final response could be extracted.",
      startedAt,
      completedAt: new Date().toISOString(),
      resultId: null
    };
    project.dispatches.push(record);
    touch(project);
    return { ...prepared, dispatch: record, execution, result: null, analysis: null, applied: null };
  }

  const analysis = analyzeAgentResult(project, prepared.item.scopeId, resultText, { agent: prepared.item.agent });
  const result = recordAgentResult(project, analysis);
  let applied = { appliedChanges: [], addedCriteria: [] };
  if (apply) {
    applied = applyAgentResult(project, analysis);
    result.appliedChanges = applied.appliedChanges.map((item) => ({ ...item }));
    result.addedCriteria = applied.addedCriteria.map((item) => ({ ...item }));
    result.appliedAt = new Date().toISOString();
  }

  const record = {
    ...meta,
    scopeId: prepared.item.scopeId,
    agent: prepared.item.agent,
    adapter: prepared.adapter?.id || null,
    capability: prepared.adapter?.capability || null,
    mode: prepared.item.mode,
    state: prepared.item.state,
    status: "completed",
    reason: null,
    startedAt,
    completedAt: new Date().toISOString(),
    resultId: result.id
  };
  project.dispatches.push(record);
  touch(project);
  return { ...prepared, dispatch: record, execution, result, analysis, applied };
}

function preparedAdapterLabel(outcome) {
  const adapter = outcome.adapter;
  if (!adapter) return "unregistered";
  return `${adapter.id} / ${adapter.capability} / ${isAutomaticAdapter(adapter, outcome.item?.mode) ? "automatic" : "manual"}`;
}

export function formatDispatchOutcome(project, outcome, { applied = false } = {}) {
  const { dispatch, item, prompt } = outcome;
  const lines = [
    `DISPATCH — ${project.name} / ${item.scopeId || item.order}`,
    `Dispatch: ${dispatch.id}`,
    `Agent: ${item.agent} / ${item.mode}`,
    `Adapter: ${preparedAdapterLabel(outcome)}`,
    `Route: ${item.state}`,
    `Status: ${dispatch.status}`
  ];

  if (dispatch.status === "waiting" || dispatch.status === "manual") {
    lines.push(`Reason: ${dispatch.reason}`, "", "ASSIGNMENT PROMPT", prompt);
    return lines.join("\n");
  }
  if (dispatch.status === "failed") {
    lines.push(`Error: ${dispatch.reason}`);
    return lines.join("\n");
  }

  lines.push(`Result: ${outcome.result.id}`);
  lines.push(`Disposition: ${outcome.analysis.targetDisposition?.action || "none"}`);
  lines.push(`Evidence: ${outcome.analysis.evidence.length}`);
  lines.push(`Suggested status changes: ${outcome.analysis.statusChanges.length}`);
  lines.push(`New scope suggestions: ${outcome.analysis.freshScopeSuggestions.length}`);
  if (applied) {
    lines.push("", "APPLIED");
    if (!outcome.applied.appliedChanges.length && !outcome.applied.addedCriteria.length) lines.push("  No high-confidence state changes or fresh criteria to apply.");
    for (const change of outcome.applied.appliedChanges) lines.push(`  ${change.criterionId}: ${change.from} -> ${change.to}`);
    for (const criterion of outcome.applied.addedCriteria) lines.push(`  ${criterion.criterionId} [${criterion.status}] ${criterion.text}`);
  }
  lines.push("", `Inspect: sumi result show ${project.id} ${outcome.result.id}`);
  return lines.join("\n");
}


export function listDispatches(project, { limit = 20 } = {}) {
  if (!Array.isArray(project.dispatches)) return [];
  const n = Math.max(1, Number(limit) || 20);
  return [...project.dispatches]
    .sort((a, b) => (Number(b.seq) || 0) - (Number(a.seq) || 0))
    .slice(0, n);
}

export function getDispatch(project, dispatchId) {
  const id = String(dispatchId || "").toUpperCase();
  return (project.dispatches || []).find((item) => item.id === id) || null;
}

export async function completeManualDispatch(project, dispatchId, text, { apply = false } = {}) {
  const dispatch = getDispatch(project, dispatchId);
  if (!dispatch) throw new Error(`Dispatch not found: ${dispatchId}`);
  if (dispatch.status !== "manual") {
    throw new Error(`Dispatch ${dispatch.id} is ${dispatch.status}; only manual dispatches can be completed with external results.`);
  }
  if (!String(text || "").trim()) throw new Error("External/manual dispatch result text is required.");

  const analysis = analyzeAgentResult(project, dispatch.scopeId, text, { agent: dispatch.agent });
  const result = recordAgentResult(project, analysis);
  let applied = { appliedChanges: [], addedCriteria: [] };
  if (apply) {
    applied = applyAgentResult(project, analysis);
    result.appliedChanges = applied.appliedChanges.map((item) => ({ ...item }));
    result.addedCriteria = applied.addedCriteria.map((item) => ({ ...item }));
    result.appliedAt = new Date().toISOString();
  }

  dispatch.status = "completed";
  dispatch.completedAt = new Date().toISOString();
  dispatch.resultId = result.id;
  dispatch.reason = null;
  touch(project);
  return { dispatch, result, analysis, applied };
}

export function formatDispatchList(project, rows) {
  const lines = [`DISPATCH HISTORY — ${project.name}`, `Entries: ${rows.length}`, ""];
  if (!rows.length) return lines.concat("No dispatches recorded.").join("\n");
  for (const item of rows) {
    lines.push(`${item.id}  ${String(item.status || "unknown").padEnd(9)} ${String(item.agent || "—").padEnd(12)} ${item.scopeId || "—"} ${item.resultId ? `-> ${item.resultId}` : ""}`.trimEnd());
  }
  return lines.join("\n");
}

export function formatDispatchDetail(project, item) {
  const lines = [
    `DISPATCH — ${project.name} / ${item.id}`,
    `Scope: ${item.scopeId || "—"}`,
    `Agent: ${item.agent || "—"}`,
    `Mode: ${item.mode || "—"}`,
    `Route state: ${item.state || "—"}`,
    `Status: ${item.status || "—"}`,
    `Started: ${item.startedAt || "—"}`,
    `Completed: ${item.completedAt || "—"}`,
    `Result: ${item.resultId || "—"}`
  ];
  if (item.reason) lines.push(`Reason: ${item.reason}`);
  return lines.join("\n");
}

export function formatManualDispatchCompletion(project, outcome, { applied = false } = {}) {
  const lines = [
    `DISPATCH COMPLETE — ${project.name} / ${outcome.dispatch.id}`,
    `Scope: ${outcome.dispatch.scopeId}`,
    `Agent: ${outcome.dispatch.agent}`,
    `Result: ${outcome.result.id}`,
    `Disposition: ${outcome.analysis.targetDisposition?.action || "none"}`,
    `Evidence: ${outcome.analysis.evidence.length}`,
    `Suggested status changes: ${outcome.analysis.statusChanges.length}`,
    `New scope suggestions: ${outcome.analysis.freshScopeSuggestions.length}`
  ];
  if (applied) {
    lines.push("", "APPLIED");
    if (!outcome.applied.appliedChanges.length && !outcome.applied.addedCriteria.length) lines.push("  No high-confidence state changes or fresh criteria to apply.");
    for (const change of outcome.applied.appliedChanges) lines.push(`  ${change.criterionId}: ${change.from} -> ${change.to}`);
    for (const criterion of outcome.applied.addedCriteria) lines.push(`  ${criterion.criterionId} [${criterion.status}] ${criterion.text}`);
  }
  lines.push("", `Inspect result: sumi result show ${project.id} ${outcome.result.id}`);
  return lines.join("\n");
}
