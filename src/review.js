import fs from "node:fs";
import path from "node:path";
import { touch } from "./domain.js";
import { runCommand } from "./sync.js";
import { getSession, inspectSessionWorkspace } from "./sessions.js";

const READY = "REVIEW_READY";
const BLOCKED = "BLOCKED";
const WORKING = "WORKING";
const CHECKS_REQUIRED = "CHECKS_REQUIRED";
const UNSUPPORTED = "UNSUPPORTED";

function run(executable, args, cwd, timeout = 180000) {
  const started = Date.now();
  const outcome = runCommand(executable, args, { cwd, timeout });
  const output = [outcome.stdout, outcome.stderr].filter(Boolean).join("\n").trim();
  const lines = output.split(/\r?\n/).filter(Boolean);
  return {
    ok: outcome.ok,
    exitCode: outcome.status,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
    durationMs: Date.now() - started,
    output,
    summary: lines.slice(-12).join("\n") || outcome.error || ""
  };
}

function git(args, cwd) {
  const outcome = run("git", args, cwd, 30000);
  if (!outcome.ok) throw new Error(`Git command failed: git ${args.join(" ")}\n${outcome.summary}`);
  return outcome.output;
}

function parseNameStatus(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      return { status: parts[0], path: parts.slice(1).join(" -> ") };
    });
}

function parseCommits(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sha, ...subject] = line.split("\t");
      return { sha, subject: subject.join("\t") };
    });
}

function packageScripts(workspacePath) {
  const file = path.join(workspacePath, "package.json");
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")).scripts || {};
  } catch {
    return {};
  }
}

function checkSpecs(workspacePath, baseCommit) {
  const specs = [
    { id: "diff-check", label: "git diff --check", executable: "git", args: ["diff", "--check", `${baseCommit}..HEAD`] }
  ];
  const scripts = packageScripts(workspacePath);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  if (scripts.test) specs.push({ id: "test", label: "npm test", executable: npm, args: ["test"] });
  if (scripts.check) specs.push({ id: "check", label: "npm run check", executable: npm, args: ["run", "check"] });
  if (!scripts.test && !scripts.check && scripts.lint) specs.push({ id: "lint", label: "npm run lint", executable: npm, args: ["run", "lint"] });
  if (!scripts.test && !scripts.check && scripts.build) specs.push({ id: "build", label: "npm run build", executable: npm, args: ["run", "build"] });
  return specs;
}

function verificationCoverage(checks) {
  return checks.some((item) => ["test", "check", "lint", "build"].includes(item.id));
}

export function reviewSession(project, sessionId, { runChecks = false, now = new Date() } = {}) {
  const record = getSession(project, sessionId);
  const inspection = inspectSessionWorkspace(project, sessionId);
  const review = {
    sessionId: record.id,
    scopeId: record.scopeId,
    agent: record.agent,
    reviewedAt: new Date(now).toISOString(),
    status: null,
    reasons: [],
    workspace: inspection,
    commits: [],
    committedFiles: [],
    checksRun: runChecks,
    checks: []
  };

  if (!inspection.exists || !inspection.git || inspection.mode !== "worktree") {
    review.status = inspection.missing || inspection.removed ? BLOCKED : UNSUPPORTED;
    review.reasons.push(inspection.missing ? "Session worktree is missing." : inspection.removed ? "Session worktree has already been removed." : "Review Gate requires an isolated Git worktree.");
    record.lastReview = review;
    touch(project);
    return review;
  }

  const base = inspection.baseCommit;
  if (!base) {
    review.status = BLOCKED;
    review.reasons.push("Session has no captured base commit.");
  } else {
    review.commits = parseCommits(git(["log", "--reverse", "--format=%H%x09%s", `${base}..HEAD`], inspection.path));
    review.committedFiles = parseNameStatus(git(["diff", "--name-status", `${base}..HEAD`], inspection.path));
  }

  if (inspection.warnings?.length) review.reasons.push(...inspection.warnings);
  if ((inspection.commitsBehind ?? 0) > 0) review.reasons.push(`Workspace is ${inspection.commitsBehind} commit(s) behind its captured base.`);
  if (inspection.dirty) review.reasons.push(`Worktree has ${inspection.changedFiles.length} uncommitted change(s).`);

  if (!review.status && review.reasons.length) review.status = BLOCKED;
  if (!review.status && (inspection.commitsAhead ?? 0) < 1) {
    review.status = WORKING;
    review.reasons.push("No committed progress exists beyond the session base yet.");
  }

  if (!review.status && !runChecks) {
    review.status = CHECKS_REQUIRED;
    review.reasons.push("Run verification with --run-checks before review handoff.");
  }

  if (!review.status && runChecks) {
    const specs = checkSpecs(inspection.path, base);
    review.checks = specs.map((spec) => ({ id: spec.id, label: spec.label, ...run(spec.executable, spec.args, inspection.path) }));
    const failed = review.checks.filter((item) => !item.ok);
    if (failed.length) {
      review.status = BLOCKED;
      for (const item of failed) review.reasons.push(`${item.label} failed${item.timedOut ? " (timeout)" : item.exitCode !== null ? ` (exit ${item.exitCode})` : ""}.`);
    } else if (!verificationCoverage(review.checks)) {
      review.status = CHECKS_REQUIRED;
      review.reasons.push("No project verification script was found (test/check/lint/build).");
    } else {
      review.status = READY;
      review.reasons.push("Committed diff is clean and all discovered verification checks passed.");
    }
  }

  record.lastReview = review;
  touch(project);
  return review;
}

export function formatSessionReview(project, record, review) {
  const lines = [
    `SESSION REVIEW GATE — ${project.name} / ${record.id}`,
    `${record.scopeId} ${record.task}`,
    `Decision: ${review.status}`,
    `Branch: ${review.workspace.branch || "—"}`,
    `HEAD: ${review.workspace.head || "—"}`,
    `Commits ahead: ${review.workspace.commitsAhead ?? "—"} | behind base: ${review.workspace.commitsBehind ?? "—"}`,
    `Committed files: ${review.committedFiles.length}`,
    `Uncommitted files: ${review.workspace.changedFiles?.length ?? 0}`
  ];

  if (review.commits.length) {
    lines.push("", "COMMITS");
    for (const item of review.commits.slice(0, 20)) lines.push(`  ${item.sha.slice(0, 8)} ${item.subject}`);
    if (review.commits.length > 20) lines.push(`  ... ${review.commits.length - 20} more`);
  }

  if (review.committedFiles.length) {
    lines.push("", "COMMITTED FILES");
    for (const item of review.committedFiles.slice(0, 30)) lines.push(`  ${item.status} ${item.path}`);
    if (review.committedFiles.length > 30) lines.push(`  ... ${review.committedFiles.length - 30} more`);
  }

  if (review.checksRun) {
    lines.push("", "VERIFICATION");
    if (!review.checks.length) lines.push("  No checks discovered.");
    for (const item of review.checks) {
      lines.push(`  ${item.ok ? "✓" : "✗"} ${item.label} (${item.durationMs}ms)`);
      if (!item.ok && item.summary) {
        for (const line of item.summary.split(/\r?\n/).slice(-6)) lines.push(`      ${line}`);
      }
    }
  }

  lines.push("", "REASONS");
  for (const reason of review.reasons) lines.push(`  ${review.status === READY ? "✓" : "!"} ${reason}`);
  if (review.status === CHECKS_REQUIRED) lines.push("", `Next: sumi session review ${project.id} ${record.id} --run-checks`);
  if (review.status === READY) lines.push("", "Next: hand the committed branch to independent review/merge flow; the scope gate is not auto-closed.");
  return lines.join("\n");
}

export const SESSION_REVIEW_STATUSES = { READY, BLOCKED, WORKING, CHECKS_REQUIRED, UNSUPPORTED };
