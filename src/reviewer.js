import { touch } from "./domain.js";
import { analyzeAgentResult, applyAgentResult, formatAgentResultAnalysis, recordAgentResult } from "./result.js";
import { getSession, inspectSessionWorkspace } from "./sessions.js";
import { SESSION_REVIEW_STATUSES } from "./review.js";

const REVIEW_AGENTS = new Set(["codex", "claude-code"]);

export function selectReviewerAgent(workerAgent) {
  if (workerAgent === "claude-code") return "codex";
  if (workerAgent === "codex") return "claude-code";
  return "codex";
}

function reviewerAgent(record, requested = null) {
  const selected = requested || selectReviewerAgent(record.agent);
  if (!REVIEW_AGENTS.has(selected)) throw new Error("Reviewer agent must be codex or claude-code.");
  if (selected === record.agent) throw new Error(`Reviewer must be independent; ${selected} is already the worker agent for ${record.id}.`);
  return selected;
}

function assertFreshReadyGate(project, record) {
  const gate = record.lastReview;
  if (!gate || gate.status !== SESSION_REVIEW_STATUSES.READY) {
    throw new Error(`Session ${record.id} is not REVIEW_READY; run: sumi session review ${project.id} ${record.id} --run-checks`);
  }
  const inspection = inspectSessionWorkspace(project, record.id);
  if (!inspection.exists || !inspection.git || inspection.dirty) {
    throw new Error(`Session ${record.id} changed after its Review Gate; rerun session review --run-checks.`);
  }
  if (inspection.head !== gate.workspace?.head || inspection.branch !== gate.workspace?.branch) {
    throw new Error(`Session ${record.id} HEAD/branch changed after its Review Gate; rerun session review --run-checks.`);
  }
  return { gate, inspection };
}

function verdictFromText(text) {
  const normalized = String(text || "").normalize("NFKC");
  const positive = /\bMERGEABLE\b|マージ可能|マージ阻害事項(?:は|が)?ありません/i.test(normalized);
  const negative = /\bCHANGES_REQUIRED\b|\bREQUEST_CHANGES\b|not\s+mergeable|マージ不可|修正(?:が|を)?必要|要修正/i.test(normalized);
  if (positive && !negative) return "MERGEABLE";
  if (negative && !positive) return "CHANGES_REQUIRED";
  return "INCONCLUSIVE";
}

export function buildReviewerPrompt(project, sessionId, { agent = null } = {}) {
  const record = getSession(project, sessionId);
  const selected = reviewerAgent(record, agent);
  const { gate } = assertFreshReadyGate(project, record);
  const commitLines = (gate.commits || []).map((item) => `- ${item.sha.slice(0, 12)} ${item.subject}`).join("\n") || "- none";
  const fileLines = (gate.committedFiles || []).map((item) => `- ${item.status} ${item.path}`).join("\n") || "- none";
  const checkLines = (gate.checks || []).map((item) => `- ${item.ok ? "PASS" : "FAIL"}: ${item.label}`).join("\n") || "- none";

  return `# SUMI INDEPENDENT REVIEW — ${project.name} / ${record.id}\n\nReviewer: ${selected}\nWorker: ${record.agent}\nScope: ${record.scopeId} — ${record.task}\nWorkspace: ${record.workspace.path}\nBranch: ${gate.workspace.branch}\nBase: ${gate.workspace.baseCommit}\nHEAD: ${gate.workspace.head}\n\n## Safety\n- Review only. Do not edit files, commit, switch branches, merge, rebase, push, deploy, or mutate external services.\n- Treat the captured Base..HEAD range as the review target.\n- Re-run read-only inspection commands if useful, but do not change the worktree.\n\n## Commits\n${commitLines}\n\n## Changed files\n${fileLines}\n\n## Verification already passed\n${checkLines}\n\n## Review task\n1. Inspect the committed diff from Base to HEAD.\n2. Look for correctness, regressions, security/privacy issues, missing edge cases, and test gaps.\n3. Distinguish blocking findings from optional suggestions.\n4. Do not approve based only on tests; inspect the actual diff.\n\n## Required response\nStart with exactly one verdict line:\nVERDICT: MERGEABLE\n-or-\nVERDICT: CHANGES_REQUIRED\n\nThen return:\n- Blocking findings (if any) with file/line evidence\n- Non-blocking observations\n- Verification evidence\n- Explicit Scope disposition: \`${record.scopeId} stay open\` or \`${record.scopeId} can move to done\`\n`;
}

export function ingestReviewerResult(project, sessionId, text, { agent = null, apply = false, now = new Date() } = {}) {
  const record = getSession(project, sessionId);
  const selected = reviewerAgent(record, agent);
  const { gate } = assertFreshReadyGate(project, record);
  if (!String(text || "").trim()) throw new Error("Reviewer result text is required.");
  const verdict = verdictFromText(text);
  const analysis = analyzeAgentResult(project, record.scopeId, text, { agent: selected });
  const result = recordAgentResult(project, analysis);
  result.reviewOfSessionId = record.id;
  result.reviewedHead = gate.workspace.head;
  result.reviewVerdict = verdict;

  let applied = { appliedChanges: [], addedCriteria: [] };
  if (apply) {
    applied = applyAgentResult(project, analysis);
    result.appliedChanges = applied.appliedChanges.map((item) => ({ ...item }));
    result.addedCriteria = applied.addedCriteria.map((item) => ({ ...item }));
    result.appliedAt = new Date(now).toISOString();
  }

  if (!Array.isArray(record.reviewerResults)) record.reviewerResults = [];
  record.reviewerResults.push(result.id);
  record.lastReviewerResult = {
    resultId: result.id,
    agent: selected,
    verdict,
    reviewedHead: gate.workspace.head,
    createdAt: result.createdAt
  };
  touch(project);
  return { session: record, gate, analysis, result, applied, reviewer: selected, verdict };
}

export function formatReviewerResult(project, outcome, { applied = false } = {}) {
  return [
    `INDEPENDENT REVIEW — ${project.name} / ${outcome.session.id}`,
    `Reviewer: ${outcome.reviewer}`,
    `Reviewed HEAD: ${outcome.gate.workspace.head}`,
    `Verdict: ${outcome.verdict}`,
    `Result: ${outcome.result.id}`,
    `Applied: ${applied ? "yes" : "no"}`,
    "",
    formatAgentResultAnalysis(project, outcome.analysis, outcome.result)
  ].join("\n");
}
