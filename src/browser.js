import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { buildSpawnInvocation, chooseResolvedCommand } from "./sync.js";
import { analyzeAgentResult, applyAgentResult, recordAgentResult } from "./result.js";
import { getDispatch } from "./dispatch.js";
import { touch } from "./domain.js";

const commandPathCache = new Map();

function snapshotSha256(value) {
  if (!value) return null;
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function resolveCommand(command) {
  if (commandPathCache.has(command)) return commandPathCache.get(command);
  const checker = process.platform === "win32" ? "where.exe" : "which";
  const probe = spawnSync(checker, [command], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  const resolved = probe.status === 0 ? chooseResolvedCommand(probe.stdout, process.platform) : null;
  commandPathCache.set(command, resolved);
  return resolved;
}

function defaultRunner({ resolved, args, cwd, timeout = 30000 }) {
  const invocation = buildSpawnInvocation(resolved, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    shell: invocation.shell,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    windowsHide: true,
    timeout,
    env: { ...process.env, CI: process.env.CI || "1" },
    maxBuffer: 1024 * 1024 * 4
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
    error: result.error?.message || null,
    timedOut: result.error?.code === "ETIMEDOUT"
  };
}

function browserExecutable() {
  return resolveCommand("agent-browser");
}

function browserArgs(session, commandArgs, { headed = false } = {}) {
  const args = ["--session", session];
  if (headed) args.push("--headed");
  return [...args, ...commandArgs];
}

function runBrowser(runner, resolved, cwd, session, commandArgs, options = {}) {
  return runner({
    resolved,
    args: browserArgs(session, commandArgs, options),
    cwd,
    timeout: options.timeout ?? 30000
  });
}

function sanitizeSessionPart(value) {
  return String(value || "sumi").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "sumi";
}

function globToRegExp(pattern) {
  const sentinel = "__SUMI_DOUBLE_STAR__";
  const escaped = String(pattern || "")
    .replace(/\*\*/g, sentinel)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replaceAll(sentinel, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function parseExpectedUrls(value) {
  if (!value) return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

export function urlMatchesAny(url, patterns) {
  if (!patterns?.length) return false;
  return patterns.some((pattern) => globToRegExp(pattern).test(String(url || "")));
}

export function getBrowserPreflight(project, dispatchId) {
  const dispatch = getDispatch(project, dispatchId);
  if (!dispatch) throw new Error(`Dispatch not found: ${dispatchId}`);
  if (dispatch.agent !== "browser") throw new Error(`Dispatch ${dispatch.id} is for ${dispatch.agent}, not browser.`);
  if (dispatch.status !== "manual" && dispatch.status !== "active") {
    throw new Error(`Dispatch ${dispatch.id} is ${dispatch.status}; browser session requires manual/active status.`);
  }
  return { dispatch, executable: browserExecutable() };
}

export function startBrowserDispatch(project, dispatchId, { url, headed = false, runner = defaultRunner, resolved = browserExecutable() } = {}) {
  if (!url) throw new Error("Browser URL is required. Use --url <http://localhost:...> or another explicit current-branch URL.");
  const { dispatch } = getBrowserPreflight(project, dispatchId);
  const executable = resolved;
  if (!executable) throw new Error("agent-browser CLI not found. Keep this dispatch manual or install/configure agent-browser before starting a SUMI browser session.");

  const session = dispatch.browser?.session || `sumi-${sanitizeSessionPart(project.id)}-${dispatch.id.toLowerCase()}`;
  const cwd = project.local || process.cwd();
  const opened = runBrowser(runner, executable, cwd, session, ["open", url], { headed, timeout: 45000 });
  if (!opened.ok) {
    throw new Error(`agent-browser open failed: ${opened.error || opened.stderr || opened.stdout || `exit ${opened.status}`}`);
  }
  const waited = runBrowser(runner, executable, cwd, session, ["wait", "--load", "networkidle"], { headed, timeout: 45000 });
  const snapshot = runBrowser(runner, executable, cwd, session, ["snapshot", "-i"], { headed, timeout: 30000 });

  dispatch.status = "active";
  dispatch.completedAt = null;
  dispatch.reason = null;
  dispatch.browser = {
    session,
    url,
    headed: Boolean(headed),
    startedAt: new Date().toISOString(),
    startedCommit: project.deployment?.commit || null,
    lastSnapshot: snapshot.ok ? snapshot.stdout : null,
    initialSnapshotSha256: snapshot.ok ? snapshotSha256(snapshot.stdout) : null,
    waitWarning: waited.ok ? null : (waited.error || waited.stderr || waited.stdout || "networkidle wait failed")
  };
  touch(project);
  return { dispatch, opened, waited, snapshot };
}

export function checkBrowserDispatch(project, dispatchId, { expectUrls = [], apply = false, runner = defaultRunner, closeOnSuccess = true, resolved = browserExecutable() } = {}) {
  const dispatch = getDispatch(project, dispatchId);
  if (!dispatch) throw new Error(`Dispatch not found: ${dispatchId}`);
  if (dispatch.agent !== "browser") throw new Error(`Dispatch ${dispatch.id} is for ${dispatch.agent}, not browser.`);
  if (dispatch.status !== "active") throw new Error(`Dispatch ${dispatch.id} is ${dispatch.status}; browser check requires an active browser session.`);
  const executable = resolved;
  if (!executable) throw new Error("agent-browser CLI not found.");
  const session = dispatch.browser?.session;
  if (!session) throw new Error(`Dispatch ${dispatch.id} has no browser session metadata.`);
  const cwd = project.local || process.cwd();
  const verifiedCommit = project.deployment?.commit || null;
  const startedCommit = dispatch.browser?.startedCommit || null;
  if (!verifiedCommit) throw new Error("Project commit is unavailable. Run sumi sync before completing browser verification.");
  if (startedCommit && String(startedCommit).toLowerCase() !== String(verifiedCommit).toLowerCase()) {
    throw new Error(`Project commit changed during browser verification: ${startedCommit} -> ${verifiedCommit}. Start a new browser dispatch for the current commit.`);
  }

  const urlResult = runBrowser(runner, executable, cwd, session, ["get", "url"], { timeout: 15000 });
  const titleResult = runBrowser(runner, executable, cwd, session, ["get", "title"], { timeout: 15000 });
  const snapshot = runBrowser(runner, executable, cwd, session, ["snapshot", "-i"], { timeout: 30000 });
  if (!urlResult.ok) throw new Error(`agent-browser get url failed: ${urlResult.error || urlResult.stderr || urlResult.stdout}`);
  if (!snapshot.ok || !snapshot.stdout) throw new Error(`agent-browser snapshot failed: ${snapshot.error || snapshot.stderr || snapshot.stdout || `exit ${snapshot.status}`}`);

  const currentUrl = urlResult.stdout.trim();
  const title = titleResult.ok ? titleResult.stdout.trim() : "";
  const matched = expectUrls.length ? urlMatchesAny(currentUrl, expectUrls) : false;
  const checkedAt = new Date().toISOString();
  const snapshotHash = snapshotSha256(snapshot.stdout);
  dispatch.browser.lastUrl = currentUrl;
  dispatch.browser.lastTitle = title || null;
  dispatch.browser.lastSnapshot = snapshot.stdout;
  dispatch.browser.lastSnapshotSha256 = snapshotHash;
  dispatch.browser.checkedAt = checkedAt;

  if (!expectUrls.length || !matched) {
    touch(project);
    return { dispatch, currentUrl, title, commit: verifiedCommit, checkedAt, snapshot: snapshot.stdout, snapshotSha256: snapshotHash, matched, completed: false, result: null, analysis: null, applied: null };
  }

  const text = [
    `Browser verification passed for SUMI ${dispatch.scopeId}.`,
    `Verified commit: ${verifiedCommit}`,
    `Final URL: ${currentUrl}`,
    title ? `Page title: ${title}` : null,
    `Checked at: ${checkedAt}`,
    `Snapshot SHA-256: ${snapshotHash}`,
    `Expected URL matched: ${expectUrls.join(" OR ")}`,
    `SUMI ${dispatch.scopeId} can move to done.`
  ].filter(Boolean).join("\n");
  const analysis = analyzeAgentResult(project, dispatch.scopeId, text, { agent: "browser" });
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
  dispatch.browser.completedAt = dispatch.completedAt;
  dispatch.browser.expectedUrls = [...expectUrls];
  dispatch.browser.verification = {
    commit: verifiedCommit,
    url: currentUrl,
    title: title || null,
    checkedAt,
    snapshotSha256: snapshotHash
  };
  if (closeOnSuccess) {
    const closed = runBrowser(runner, executable, cwd, session, ["close"], { timeout: 15000 });
    dispatch.browser.closed = closed.ok;
  }
  touch(project);
  return { dispatch, currentUrl, title, commit: verifiedCommit, checkedAt, snapshot: snapshot.stdout, snapshotSha256: snapshotHash, matched: true, completed: true, result, analysis, applied };
}

export function closeBrowserDispatch(project, dispatchId, { runner = defaultRunner, resolved = browserExecutable() } = {}) {
  const dispatch = getDispatch(project, dispatchId);
  if (!dispatch) throw new Error(`Dispatch not found: ${dispatchId}`);
  if (dispatch.agent !== "browser") throw new Error(`Dispatch ${dispatch.id} is for ${dispatch.agent}, not browser.`);
  const executable = resolved;
  if (!executable) throw new Error("agent-browser CLI not found.");
  const session = dispatch.browser?.session;
  if (!session) throw new Error(`Dispatch ${dispatch.id} has no browser session metadata.`);
  const result = runBrowser(runner, executable, project.local || process.cwd(), session, ["close"], { timeout: 15000 });
  if (!result.ok) throw new Error(`agent-browser close failed: ${result.error || result.stderr || result.stdout}`);
  dispatch.browser.closed = true;
  dispatch.browser.closedAt = new Date().toISOString();
  if (dispatch.status === "active") dispatch.status = "manual";
  touch(project);
  return { dispatch, result };
}

export function formatBrowserStart(project, outcome) {
  const b = outcome.dispatch.browser;
  const lines = [
    `BROWSER SESSION — ${project.name} / ${outcome.dispatch.id}`,
    `Scope: ${outcome.dispatch.scopeId}`,
    `Session: ${b.session}`,
    `URL: ${b.url}`,
    `Target commit: ${b.startedCommit || "—"}`,
    `Mode: ${b.headed ? "headed" : "headless"}`,
    `Status: ${outcome.dispatch.status}`
  ];
  if (b.waitWarning) lines.push(`Warning: ${b.waitWarning}`);
  lines.push("", "For authentication flows, perform only the secure/manual login or email-link step in the opened browser, then run:", `  sumi browser check ${project.id} ${outcome.dispatch.id} --expect-url \"**/dashboard,**/auth/reset-password\" --apply`);
  return lines.join("\n");
}

export function formatBrowserCheck(project, outcome, { applied = false } = {}) {
  const lines = [
    `BROWSER CHECK — ${project.name} / ${outcome.dispatch.id}`,
    `Current URL: ${outcome.currentUrl || "—"}`,
    `Title: ${outcome.title || "—"}`,
    `Verified commit: ${outcome.commit || "—"}`,
    `Checked at: ${outcome.checkedAt || "—"}`,
    `Snapshot SHA-256: ${outcome.snapshotSha256 || "—"}`,
    `Matched expectation: ${outcome.matched ? "yes" : "no"}`,
    `Dispatch status: ${outcome.dispatch.status}`
  ];
  if (!outcome.completed) {
    lines.push("", "No completion recorded. Keep the browser session active and complete the expected flow before checking again.");
    return lines.join("\n");
  }
  lines.push(`Result: ${outcome.result.id}`, `Evidence: ${outcome.analysis.evidence.length}`);
  if (applied) {
    lines.push("", "APPLIED");
    if (!outcome.applied.appliedChanges.length) lines.push("  No high-confidence scope change applied.");
    for (const change of outcome.applied.appliedChanges) lines.push(`  ${change.criterionId}: ${change.from} -> ${change.to}`);
  }
  lines.push("", `Inspect: sumi result show ${project.id} ${outcome.result.id}`);
  return lines.join("\n");
}
