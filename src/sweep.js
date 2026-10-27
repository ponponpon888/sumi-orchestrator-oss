import fs from "node:fs";
import { touch } from "./domain.js";
import {
  addConfirmation,
  addFinding,
  ensureSweepsShape,
  getConfirmationBasis,
  getPattern,
  getPatternApplicability,
  getPatternFingerprint,
  listFindings,
  normalizeCheck,
  listPatterns,
  setFindingStatus
} from "./findings.js";
import { filterMeaningfulGitChanges, GIT_LOCATION_VARS, parseGitPorcelain, runCommand } from "./sync.js";
import { isBundledArgv, resolveBundledInvocation } from "./bundled-checks.js";
import { isGithubSource, refreshMirror, restoreMirror } from "./mirror.js";

export const SWEEP_OUTCOMES = new Set(["reproduced", "suppressed", "clean", "error", "skipped"]);

// A reproduction attaches itself to a finding that is still open.
const OPEN_STATUSES = new Set(["suspected", "confirmed"]);

// `dismissed` and `not_applicable` are judgments about the reproduction
// itself — usually that the check is wrong here. The code reproducing it again
// is exactly what the judgment anticipated, so the sweep records the run and
// leaves the ledger alone. `fixed` is the opposite: it is a judgment about the
// code, and a reproduction after it contradicts that, which is a regression
// worth its own finding.
const SUPPRESSING_STATUSES = new Set(["dismissed", "not_applicable"]);

/**
 * `expect` describes what the check prints and returns on a project that does
 * NOT have the pattern's problem. A run that misses its expectation is the run
 * that reproduced the finding, which is why `reproduced` is the negation of it.
 */
function runCheckCommand(check, cwd) {
  // A check runs in the swept worktree; an inherited GIT_DIR must not make
  // a `git grep`-style check answer for the caller's repository instead.
  if (!isBundledArgv(check.argv)) {
    return runCommand(check.argv[0], check.argv.slice(1), { cwd, timeout: check.timeoutMs, dropEnv: GIT_LOCATION_VARS });
  }
  let invocation;
  try {
    invocation = resolveBundledInvocation(check.argv);
  } catch (error) {
    // A malformed placeholder in a hand-edited state file is this pattern's
    // error, not a reason to stop every other pattern's sweep.
    invocation = { error: error.message };
  }
  if (invocation.error) {
    return { ok: false, status: null, signal: null, stdout: "", stderr: "", error: invocation.error, errorCode: "ENOENT", timedOut: false };
  }
  return runCommand(invocation.command, invocation.args, { cwd, timeout: check.timeoutMs, resolve: false, dropEnv: GIT_LOCATION_VARS });
}

export function evaluateCheckRun(check, result) {
  const exitCode = Number.isInteger(result?.status) ? result.status : null;
  if (result?.timedOut) return { ran: false, exitCode, reason: `check timed out after ${check.timeoutMs}ms` };
  if (result?.error) return { ran: false, exitCode, reason: result.error };
  if (exitCode === null) {
    return { ran: false, exitCode: null, reason: `check did not exit${result?.signal ? ` (signal ${result.signal})` : ""}` };
  }
  if (check.errorExitCodes?.includes(exitCode)) {
    return { ran: false, exitCode, reason: `check exited ${exitCode}; configured as an execution error` };
  }
  if (check.reproducedExitCodes?.length && exitCode !== 0 && !check.reproducedExitCodes.includes(exitCode)) {
    return {
      ran: false,
      exitCode,
      reason: `check exited ${exitCode}; only 0 (clean) and ${check.reproducedExitCodes.join(", ")} (reproduced) are verdicts`
    };
  }
  const output = [String(result.stdout ?? ""), String(result.stderr ?? "")]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n");
  if (check.expect === "no-output") {
    // A linter reports violations on stdout and commonly exits non-zero with
    // them, so output decides. Silence plus a non-zero exit is the one case
    // output cannot speak for: the check died without saying anything, which
    // is a check that did not run, not a project that came back clean.
    if (!output.length && exitCode !== 0) {
      return { ran: false, exitCode, reason: `check exited ${exitCode} without output; expected no output` };
    }
    return { ran: true, exitCode, reproduced: output.length > 0, output };
  }
  const reproduced = check.expect === "exit-nonzero" ? exitCode === 0 : exitCode !== 0;
  return { ran: true, exitCode, reproduced, output };
}

/**
 * Evidence is bound to a commit, so a sweep only runs where it can name the
 * commit it ran against. A dirty worktree would produce a result that the
 * recorded commit does not reproduce, so it is refused rather than recorded
 * under a commit that does not describe it.
 */
export function resolveSweepWorktree(project, { mirrorRefresher = refreshMirror } = {}) {
  // A GitHub-source project is swept at the remote head, through SUMI's
  // mirror. A refresh that fails is an error for this project: sweeping the
  // mirror's previous state would answer for code that is no longer current.
  if (isGithubSource(project)) {
    const mirror = mirrorRefresher(project);
    if (!mirror.ok) return { ok: false, reason: `GitHub mirror refresh failed: ${mirror.reason}` };
    return resolveGitWorktree(mirror.path);
  }
  if (!project.local) return { ok: false, reason: "no local path is configured" };
  return resolveGitWorktree(project.local);
}

function resolveGitWorktree(dir) {
  if (!fs.existsSync(dir)) return { ok: false, reason: `local path not found: ${dir}` };
  // An inherited GIT_DIR would make these answer for another repository.
  const isolated = { dropEnv: GIT_LOCATION_VARS };
  const inside = runCommand("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], isolated);
  if (!inside.ok || inside.stdout !== "true") return { ok: false, reason: `local path is not a Git worktree: ${dir}` };
  const head = runCommand("git", ["-C", dir, "rev-parse", "HEAD"], isolated);
  if (!head.ok || !head.stdout) return { ok: false, reason: "cannot read HEAD commit" };
  const porcelain = runCommand("git", ["-C", dir, "status", "--porcelain"], isolated);
  if (!porcelain.ok) return { ok: false, reason: "cannot read worktree status" };
  const changes = filterMeaningfulGitChanges(parseGitPorcelain(porcelain.stdout));
  if (changes.length) {
    return {
      ok: false,
      reason: `worktree has ${changes.length} uncommitted change(s); a result cannot be bound to ${head.stdout.slice(0, 12)}`
    };
  }
  return { ok: true, cwd: dir, commit: head.stdout };
}

function recordSweep(project, row, dryRun) {
  if (dryRun) return { ...row, recorded: false };
  const sweeps = ensureSweepsShape(project);
  const entry = {
    patternKey: row.patternKey,
    patternFingerprint: row.patternFingerprint,
    outcome: row.outcome,
    commit: row.commit ?? null,
    exitCode: row.exitCode ?? null,
    reproduced: Boolean(row.reproduced),
    reason: row.reason ?? null,
    findingId: row.findingId ?? null,
    ranAt: row.ranAt
  };
  // One record per pattern per project: the cell answers "what did the last
  // sweep see here". The finding's confirmations keep the history.
  const index = sweeps.findIndex((item) => item.patternKey === row.patternKey);
  if (index >= 0) sweeps[index] = entry;
  else sweeps.push(entry);
  touch(project);
  return { ...row, recorded: true };
}

function sweepProject(state, pattern, project, { runner, worktreeResolver, dryRun, ranAt }) {
  let patternFingerprint;
  let check;
  try {
    // The check is evaluated in its normalized form, the same form the
    // fingerprint is computed from: a pattern stored before a rule existed
    // (e.g. the fixed exit contract of a bundled check) gets that rule.
    check = normalizeCheck(pattern.check);
    patternFingerprint = getPatternFingerprint(pattern);
  } catch (error) {
    // A check definition that no longer validates (a hand-edited state file)
    // is this pattern's error. Nothing is recorded: a sweep record must name
    // the check it evaluated, and this one cannot be named.
    return {
      patternKey: pattern.key, patternFingerprint: null, projectId: project.id, ranAt, commit: null, exitCode: null,
      reproduced: false, findingId: null, status: null, recorded: false, outcome: "error",
      reason: `invalid check definition: ${error.message}`
    };
  }
  const base = {
    patternKey: pattern.key,
    patternFingerprint,
    projectId: project.id,
    ranAt,
    commit: null,
    exitCode: null,
    reproduced: false,
    findingId: null,
    status: null,
    recorded: false,
    reason: null
  };

  // R7 decides this before anything is executed. An unregistered service means
  // SUMI does not know whether the pattern applies, and running the check
  // anyway would turn "we do not know" into an answer.
  const applicability = getPatternApplicability(project, pattern);
  if (applicability.applicable !== "yes") {
    return { ...base, outcome: "skipped", reason: applicability.reason };
  }

  const worktree = (worktreeResolver || resolveSweepWorktree)(project);
  if (!worktree.ok) return recordSweep(project, { ...base, outcome: "error", reason: worktree.reason }, dryRun);

  const result = runner
    ? runner({ project, pattern, cwd: worktree.cwd, commit: worktree.commit })
    : runCheckCommand(check, worktree.cwd);

  const verdict = evaluateCheckRun(check, result);
  const row = { ...base, commit: worktree.commit, exitCode: verdict.exitCode ?? null };
  if (!verdict.ran) return recordSweep(project, { ...row, outcome: "error", reason: verdict.reason }, dryRun);

  // A clean run records no confirmation. Confirmations are counted by source
  // kind, so filing one here would let a check that found nothing supply the
  // second kind that R1 needs and confirm a finding it just contradicted.
  if (!verdict.reproduced) return recordSweep(project, { ...row, outcome: "clean" }, dryRun);

  const reproducedRow = { ...row, outcome: "reproduced", reproduced: true };
  if (dryRun) return { ...reproducedRow, recorded: false };

  const source = { kind: "sweep" };
  const evidence = {
    commit: worktree.commit,
    files: [],
    output: verdict.output || `check exited ${verdict.exitCode}; expected ${check.expect}`,
    checkedAt: ranAt
  };
  const checkRun = { satisfied: true, exitCode: verdict.exitCode, ranAt };

  const filed = listFindings(project, { patternKey: pattern.key });
  const open = filed.find((item) => OPEN_STATUSES.has(item.status));
  const suppressed = open ? null : filed.find((item) => SUPPRESSING_STATUSES.has(item.status));
  if (suppressed) {
    return recordSweep(project, {
      ...row,
      outcome: "suppressed",
      reproduced: true,
      findingId: suppressed.id,
      status: suppressed.status,
      reason: suppressed.reason
    }, false);
  }

  let finding;
  if (open) {
    addConfirmation(state, project, open.id, { source, evidence, check: checkRun });
    finding = open;
  } else {
    finding = addFinding(state, project, {
      title: pattern.title,
      patternKey: pattern.key,
      detail: pattern.question,
      severity: pattern.severity,
      source,
      evidence,
      check: checkRun
    });
  }

  // R1(a). A check the sweep itself reproduced is the mechanical route to
  // confirmed, and this is the only place that can supply one.
  if (finding.status === "suspected" && getConfirmationBasis(finding, pattern).ok) {
    setFindingStatus(state, project, finding.id, "confirmed");
  }

  return recordSweep(project, { ...reproducedRow, findingId: finding.id, status: finding.status }, false);
}

function selectSweepProjects(state, projectIds) {
  const all = Object.values(state.projects || {}).sort((a, b) => a.id.localeCompare(b.id));
  if (!projectIds || !projectIds.length) return all;
  return projectIds.map((id) => {
    const project = state.projects?.[id];
    if (!project) throw new Error(`Unknown project: ${id}`);
    return project;
  });
}

export function runSweep(state, {
  patternKey = null,
  projectIds = null,
  runner = null,
  worktreeResolver = null,
  mirrorRefresher = refreshMirror,
  mirrorRestorer = null,
  dryRun = false,
  now = new Date()
} = {}) {
  const at = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(at.getTime())) throw new Error(`Invalid sweep timestamp: ${now}`);
  const ranAt = at.toISOString();

  let patterns;
  if (patternKey) {
    const pattern = getPattern(state, patternKey);
    if (pattern.kind !== "mechanical") {
      throw new Error(
        `Pattern ${pattern.key} is a judgment question with no check to run. `
        + "Answer it by reading the code, or give it a --check first."
      );
    }
    patterns = [pattern];
  } else {
    patterns = listPatterns(state).filter((item) => item.kind === "mechanical");
  }

  const projects = selectSweepProjects(state, projectIds);
  // A GitHub-source project is fetched once per run, and every pattern in
  // the run is evaluated against that one commit. Fetching once is the only
  // thing cached: before each pattern the worktree is checked again (a check
  // may rewrite tracked files), and a mirror is first put back at the fetched
  // commit, offline. A local worktree is never reset, so a check that
  // dirtied it makes the next pattern an error, exactly as without a cache.
  const fetched = new Map();
  const resolveForPattern = (project) => {
    if (worktreeResolver) return worktreeResolver(project);
    if (!isGithubSource(project)) return resolveSweepWorktree(project);
    if (!fetched.has(project.id)) {
      const first = resolveSweepWorktree(project, { mirrorRefresher });
      fetched.set(project.id, first);
      return first;
    }
    const first = fetched.get(project.id);
    if (!first.ok) return first;
    const restored = (mirrorRestorer || restoreMirror)(project, first.commit);
    if (!restored.ok) return { ok: false, reason: `cannot restore the mirror to ${first.commit.slice(0, 12)}: ${restored.reason}` };
    const again = resolveGitWorktree(first.cwd);
    if (again.ok && again.commit !== first.commit) {
      return { ok: false, reason: `mirror moved from ${first.commit.slice(0, 12)} to ${again.commit.slice(0, 12)} during the sweep` };
    }
    return again;
  };
  const rows = [];
  for (const pattern of patterns) {
    for (const project of projects) {
      rows.push(sweepProject(state, pattern, project, { runner, worktreeResolver: resolveForPattern, dryRun, ranAt }));
    }
  }
  return { patterns, projects, rows, dryRun, ranAt };
}

export function summarizeSweep(outcome) {
  const totals = { reproduced: 0, suppressed: 0, clean: 0, error: 0, skipped: 0 };
  for (const row of outcome.rows) totals[row.outcome] = (totals[row.outcome] || 0) + 1;
  return totals;
}

function pad(value, width) {
  const raw = String(value ?? "");
  return raw.length >= width ? `${raw.slice(0, width - 1)}…` : raw.padEnd(width);
}

export function formatSweepRun(outcome) {
  const totals = summarizeSweep(outcome);
  const lines = [
    `SUMI SWEEP — ${outcome.patterns.length} pattern(s) x ${outcome.projects.length} project(s)${outcome.dryRun ? " — DRY RUN" : ""}`,
    "=".repeat(72)
  ];
  if (!outcome.patterns.length) {
    return lines.concat("No mechanical pattern to sweep. A pattern needs a --check before it can be run.").join("\n");
  }
  if (!outcome.projects.length) return lines.concat("No projects registered yet.").join("\n");

  lines.push(`${pad("PATTERN", 24)} ${pad("PROJECT", 14)} ${pad("OUTCOME", 12)} ${pad("FINDING", 9)} DETAIL`, "-".repeat(72));
  for (const row of outcome.rows) {
    let detail;
    if (row.outcome === "reproduced") {
      detail = `${row.status || (row.recorded ? "recorded" : "not recorded")} @ ${String(row.commit).slice(0, 12)}`;
    } else if (row.outcome === "suppressed") {
      detail = `${row.findingId} ${row.status}${row.reason ? `: ${row.reason}` : ""}`;
    } else {
      detail = row.reason || (row.commit ? `@ ${String(row.commit).slice(0, 12)}` : "");
    }
    lines.push(`${pad(row.patternKey, 24)} ${pad(row.projectId, 14)} ${pad(row.outcome, 12)} ${pad(row.findingId || "—", 9)} ${detail}`);
  }
  lines.push(
    "",
    `reproduced ${totals.reproduced} | suppressed ${totals.suppressed} | clean ${totals.clean} `
    + `| error ${totals.error} | skipped ${totals.skipped}`,
    "suppressed = the check reproduced, but a dismissed or not_applicable finding already answers this cell.",
    "skipped = the pattern does not apply here, or a required service is unregistered (no check was run).",
    "error = the check could not be run against a named commit; nothing was recorded as an answer."
  );
  if (outcome.dryRun) lines.push("Dry run: no finding, confirmation or sweep record was written.");
  return lines.join("\n");
}
