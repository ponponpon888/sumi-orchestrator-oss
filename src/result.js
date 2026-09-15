import { addScopeCriterion, ensureProjectShape, setScopeCriterionStatus, touch } from "./domain.js";
import { classifyAction, effectiveScopeStatus, remediationDependencies, remediationParents } from "./next.js";

function has(text, regex) {
  return regex.test(String(text || ""));
}

function scopeKey(item) {
  return classifyAction(item?.text) || `text:${String(item?.text || "").normalize("NFKC").toLowerCase().trim()}`;
}

function statusChange(criterion, to, confidence, reason, evidence = []) {
  return {
    criterionId: criterion.id,
    from: criterion.status,
    to,
    confidence,
    reason,
    evidence
  };
}

function evidence(key, label, detail = "") {
  return { key, label, detail };
}

function findByKey(project, key) {
  return (project.scope?.criteria || []).find((item) => scopeKey(item) === key) || null;
}

function findById(project, id) {
  return (project.scope?.criteria || []).find((item) => item.id === id) || null;
}

function freshScopeSuggestion(project, item) {
  const existing = findByKey(project, item.key);
  if (existing) return { ...item, existingCriterionId: existing.id, fresh: false };
  return { ...item, existingCriterionId: null, fresh: true };
}

function maskNegatedBlockerPhrases(text) {
  const mask = (value) => " ".repeat(value.length);
  return String(text || "")
    .replace(/\b(?:not|isn't|wasn't|no\s+longer|must\s+not|should\s+not|need\s+not)\s+(?:be\s+|remain\s+|stay\s+)?blocked\b/gi, mask)
    .replace(/\b(?:no|without\s+(?:any\s+)?)\s+(?:active\s+)?blockers?\b/gi, mask)
    .replace(/\bblockers?\s*:\s*(?:none|no|n\/a)\b/gi, mask)
    .replace(/ブロック(?:中|状態)?ではない|ブロックされていない|ブロッカー(?:は|が)?(?:なし|ない|ありません)/g, mask);
}

function explicitBlockerDetail(text) {
  const source = String(text || "");
  const matches = source.matchAll(/\bBLOCKER\s*:\s*([^\r\n]+)/gi);
  for (const match of matches) {
    const prefix = source.slice(Math.max(0, match.index - 20), match.index);
    if (/\b(?:no|not\s+(?:a|an)|without\s+(?:a|any))\s*$/i.test(prefix)) continue;
    const detail = match[1].trim().replace(/\.\s+(?=(?:C\d{3}\b|Add\s+(?:a|an|the)\b))[\s\S]*$/i, "");
    if (!/^(?:none|no(?:ne)?|n\/a|resolved|cleared)\b/i.test(detail)) return detail;
  }
  return null;
}

function hasNegatedDone(text) {
  return has(text, /\b(?:not|isn't|wasn't)\s+(?:yet\s+)?done\b|\b(?:must|should|do|may)\s+not\s+(?:be\s+)?(?:move(?:d)?|mark(?:ed)?|set|treat(?:ed)?)?(?:\s+to|\s+as)?\s*done\b|\b(?:cannot|can't)\s+(?:be\s+)?(?:move(?:d)?|mark(?:ed)?|set|treat(?:ed)?)?(?:\s+to|\s+as)?\s*done\b|done(?:に|へ)(?:移さない|しない)|完了(?:ではない|していない|扱いにしない)/i);
}

function browserPassDetails(text) {
  const details = [];
  for (const match of String(text || "").matchAll(/\bPASS\s*:\s*([^\r\n]+)/gi)) {
    let block = match[1].split(/\b(?:BLOCKER|FAIL(?:ED|URE)?|WARNING)\s*:/i, 1)[0];
    block = block.replace(/\.\s+(?=(?:GitHub|C\d{3})\b)[\s\S]*$/i, ".");
    for (const part of block.split(/\s*;\s*/)) {
      const detail = part.trim().replace(/[.;]+$/, "");
      if (!detail || /^(?:none|n\/a|なし)$/i.test(detail)) continue;
      details.push(detail);
      if (details.length === 10) return details;
    }
  }
  return details;
}

function remediationScopeRequests(text) {
  const requests = [];
  const seen = new Set();
  const matches = String(text || "").matchAll(/\badd\s+(?:(?:a|an|the)\s+)?(?:(?:new|remediation)\s+)*scope(?:\s+(?:item|criterion|suggestion))?\s+(?:for|to)\s+([^\r\n.!?]+)/gi);
  for (const match of matches) {
    const request = match[1].trim();
    const key = request.normalize("NFKC").toLowerCase();
    if (!request || seen.has(key)) continue;
    seen.add(key);
    requests.push(request);
  }
  return requests;
}

export function analyzeAgentResult(project, scopeId, text, { agent = "unknown" } = {}) {
  ensureProjectShape(project);
  const criterion = findById(project, scopeId);
  if (!criterion) throw new Error(`Scope criterion not found: ${scopeId}`);
  if (!String(text || "").trim()) throw new Error("Agent result text is required.");

  const raw = String(text);
  const normalized = raw.normalize("NFKC");
  const ev = [];
  const browserVerificationPassed = agent === "browser" && has(normalized, /(?:browser|ブラウザ)[^\n]{0,100}(?:verified|verification\s+(?:completed|passed)|成功|正常|完了)|(?:redirect|リダイレクト)[^\n]{0,100}(?:session|セッション)[^\n]{0,100}(?:verified|正常|成功)/i);
  if (browserVerificationPassed) {
    ev.push(evidence("browser-verification", "Browser verification passed", "ブラウザ実行結果で対象フローの成功を確認"));
  }
  if (agent === "browser") {
    const key = scopeKey(criterion) === "production-smoke" ? "production-smoke" : "browser-verification";
    const label = key === "production-smoke" ? "Production smoke check passed" : "Browser check passed";
    for (const detail of browserPassDetails(normalized)) ev.push(evidence(key, label, detail));
  }
  const statusChanges = [];
  const scopeSuggestions = [];
  const blockers = [];
  let targetDisposition = null;

  const escapedId = scopeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockerScanText = maskNegatedBlockerPhrases(normalized);
  const blockerDetail = explicitBlockerDetail(normalized);
  const targetBlocked = new RegExp(`${escapedId}[\\s\\S]{0,120}\\bblocked\\b`, "i").test(blockerScanText);
  const positiveBlocked = has(blockerScanText, /\bblocked\b/i);
  const explicitBlocked = Boolean(blockerDetail || targetBlocked || positiveBlocked);

  if (blockerDetail) {
    blockers.push({
      key: "explicit-blocker",
      text: blockerDetail,
      reason: "Agent result contains an explicit BLOCKER declaration"
    });
  } else if (positiveBlocked) {
    blockers.push({
      key: "blocked-state",
      text: `${scopeId} result reports a blocked state`,
      reason: "Agent result explicitly reports blocked"
    });
  }

  for (const request of remediationScopeRequests(normalized)) {
    scopeSuggestions.push(freshScopeSuggestion(project, {
      key: scopeKey({ text: request }),
      text: request,
      status: "todo",
      reason: "Agent result explicitly requests a remediation scope"
    }));
  }

  const mergeable = has(normalized, /\bMERGEABLE\b|マージ阻害事項(?:は|が)?ありません|マージ可能/i);
  if (mergeable) ev.push(evidence("pr-mergeable", "PR is mergeable", "レビュー結果でマージ阻害事項なし/mergeableを確認"));

  if (has(normalized, /typecheck\s*[:：]\s*(?:成功|success|passed)|type\s*check\s*[:：]\s*(?:成功|success|passed)/i)) {
    ev.push(evidence("typecheck", "Typecheck passed"));
  }
  if (has(normalized, /(?:production\s*)?build\s*[:：]\s*(?:成功|success|passed)|本番ビルド\s*[:：]\s*成功/i)) {
    ev.push(evidence("build", "Production build passed"));
  }
  const focusedTests = normalized.match(/(?:auth|認証)[^\n]{0,30}?(\d+)\s*\/\s*(\d+)\s*(?:成功|passed)/i);
  if (focusedTests) ev.push(evidence("focused-tests", "Focused tests passed", `${focusedTests[1]}/${focusedTests[2]}`));
  if (has(normalized, /lint\s*[:：][^\n]{0,30}0\s*errors?/i)) ev.push(evidence("lint", "Lint has 0 errors"));
  if (has(normalized, /git\s+diff\s+--check\s*[:：]\s*(?:成功|success|passed)/i)) ev.push(evidence("diff-check", "git diff --check passed"));

  const fullTests = normalized.match(/全テスト\s*[:：]\s*(\d+)\s*\/\s*(\d+)\s*成功/i);
  if (fullTests) {
    const passed = Number(fullTests[1]);
    const total = Number(fullTests[2]);
    ev.push(evidence("full-tests", passed === total ? "Full test suite passed" : "Full test suite has residual failures", `${passed}/${total}`));
  }
  if (has(normalized, /CRLF[^\n]{0,80}(?:main|変更なし)|(?:main|変更なし)[^\n]{0,80}CRLF/i)) {
    ev.push(evidence("baseline-test-diff", "Residual test failures appear baseline/CRLF-related"));
  }

  const billingDetected = has(normalized, /billing|spending\s*limit|支払い失敗|支払(?:い)?(?:エラー|失敗)|請求(?:エラー|失敗)/i);
  const runnerBeforeStart = has(normalized, /runner[^\n]{0,50}(?:起動前|before)|(?:起動前|開始前)[^\n]{0,50}runner/i);
  if (billingDetected) {
    ev.push(evidence("github-billing", "GitHub Actions is blocked by billing/spending limit", runnerBeforeStart ? "runner起動前に停止" : "billing/spending limitを検出"));
    blockers.push({
      key: "ci-billing",
      text: "GitHub Billing / spending limitによりCI実行がブロックされている",
      reason: runnerBeforeStart ? "GitHub Actions runnerが起動する前に課金制限で停止" : "GitHub billing/spending limitがCIを阻害"
    });

    const pr = project.deployment?.pr;
    scopeSuggestions.push(freshScopeSuggestion(project, {
      key: "ci-billing",
      text: `GitHub Billing / spending limitを解消し${pr ? `、PR #${pr}` : ""}のCIを正常に完了させる`,
      status: "blocked",
      reason: runnerBeforeStart ? "CIがrunner起動前に課金制限で停止している" : "CIがGitHub billing/spending limitで停止している"
    }));

    const baseline = findByKey(project, "ci-baseline");
    if (baseline && baseline.status !== "done" && runnerBeforeStart) {
      statusChanges.push(statusChange(
        baseline,
        "done",
        "high",
        "baseline CI障害の原因がGitHub Billing / spending limitでrunner起動前に停止することまで切り分けられた",
        ["billing/spending limit", "runner before start"]
      ));
    }
  }

  const ignoredBuild = has(normalized, /ignored\s*build\s*step/i);
  const previewCancelled = has(normalized, /vercel\s*preview[^\n]{0,100}(?:cancel|キャンセル)|(?:cancel|キャンセル)[^\n]{0,100}vercel\s*preview/i);
  if (ignoredBuild || previewCancelled) {
    ev.push(evidence("preview-cancel", "Preview cancellation reason identified", ignoredBuild ? "Ignored Build Step" : "Preview cancelled"));
    const previewCriterion = findByKey(project, "preview-cancel-reason");
    if (ignoredBuild && previewCriterion && previewCriterion.status !== "done") {
      statusChanges.push(statusChange(
        previewCriterion,
        "done",
        "high",
        "Vercel Previewのキャンセル理由がIgnored Build Stepと特定された",
        ["Ignored Build Step"]
      ));
    }
  }

  const keepOpen = new RegExp(`${escapedId}[\\s\\S]{0,100}(?:開いたまま|継続|stay\\s+open|remain\\s+open|keep\\s+open)`, "i").test(normalized);
  const negativeDone = hasNegatedDone(normalized);
  const changesRequired = has(normalized, /\bCHANGES_REQUIRED\b|\bREQUEST_CHANGES\b/i);
  const explicitDone = new RegExp(`${escapedId}[\\s\\S]{0,100}(?:move\\s+to\\s+done|can\\s+move\\s+to\\s+done|done(?:に|へ)?|完了(?:扱い|に)?)`, "i").test(normalized);

  if (explicitBlocked) {
    targetDisposition = {
      action: "blocked",
      reason: targetBlocked
        ? `${scopeId}をblockedのままにする明示的なエージェント判定を検出`
        : "明示的なBLOCKER/blocked表現を検出したため、安全側でScopeをblockedと判定"
    };
    if (criterion.status !== "blocked" && criterion.status !== "cancelled") {
      statusChanges.push(statusChange(criterion, "blocked", "high", targetDisposition.reason, blockerDetail ? [blockerDetail] : ["blocked"]));
    }
  } else if (keepOpen) {
    targetDisposition = {
      action: "stay-open",
      reason: `${scopeId}を開いたまま/継続とする明示的なエージェント判定を検出`
    };
    if (criterion.status === "todo") {
      statusChanges.push(statusChange(criterion, "doing", "high", targetDisposition.reason));
    }
  } else if (negativeDone || changesRequired) {
    targetDisposition = {
      action: "stay-open",
      reason: negativeDone
        ? `${scopeId}をdoneにしない明示的なエージェント判定を検出`
        : "CHANGES_REQUIRED/REQUEST_CHANGESを検出したためScopeを完了させない"
    };
  } else if (explicitDone) {
    targetDisposition = {
      action: "done",
      reason: `${scopeId}をdone/完了へ移せるという明示的なエージェント判定を検出`
    };
    if (criterion.status !== "done") statusChanges.push(statusChange(criterion, "done", "high", targetDisposition.reason));
  } else if (mergeable) {
    targetDisposition = {
      action: "reviewed",
      reason: "PRはmergeableだが、Scopeを完了させる明示的な判定はないため自動doneにはしない"
    };
  }

  if (targetDisposition?.action === "done") {
    for (const parent of remediationParents(project, scopeId)) {
      const otherUnresolvedRemediation = remediationDependencies(project, parent.id)
        .some((item) => item.id !== criterion.id && !["done", "cancelled"].includes(effectiveScopeStatus(project, item)));
      if (parent.status !== "blocked" || otherUnresolvedRemediation) continue;
      statusChanges.push(statusChange(
        parent,
        "todo",
        "high",
        `${criterion.id} remediationが完了したため、依存元の${parent.id}を再検証可能な状態へ戻す`,
        [`${criterion.id} remediation completed`]
      ));
    }
  }

  return {
    scopeId,
    agent,
    targetCriterion: criterion,
    targetDisposition,
    evidence: ev,
    blockers,
    statusChanges,
    highConfidenceChanges: statusChanges.filter((item) => item.confidence === "high"),
    scopeSuggestions,
    freshScopeSuggestions: scopeSuggestions.filter((item) => item.fresh),
    rawText: raw
  };
}

export function recordAgentResult(project, analysis) {
  ensureProjectShape(project);
  if (!Array.isArray(project.agentResults)) project.agentResults = [];
  const seq = project.agentResults.reduce((max, item) => Math.max(max, Number(item.seq) || 0), 0) + 1;
  const item = {
    id: `R${String(seq).padStart(3, "0")}`,
    seq,
    scopeId: analysis.scopeId,
    agent: analysis.agent,
    rawText: analysis.rawText,
    evidence: analysis.evidence,
    blockers: analysis.blockers,
    statusChanges: analysis.statusChanges.map(({ criterionId, from, to, confidence, reason, evidence }) => ({ criterionId, from, to, confidence, reason, evidence })),
    scopeSuggestions: analysis.scopeSuggestions.map(({ key, text, status, reason, existingCriterionId, fresh }) => ({ key, text, status, reason, existingCriterionId, fresh })),
    targetDisposition: analysis.targetDisposition,
    createdAt: new Date().toISOString()
  };
  project.agentResults.push(item);
  touch(project);
  return item;
}

export function applyAgentResult(project, analysis) {
  const appliedChanges = [];
  for (const change of analysis.highConfidenceChanges) {
    const criterion = findById(project, change.criterionId);
    if (!criterion || criterion.status === change.to) continue;
    const from = criterion.status;
    setScopeCriterionStatus(project, criterion.id, change.to);
    appliedChanges.push({ criterionId: criterion.id, from, to: change.to, reason: change.reason });
  }

  const addedCriteria = [];
  for (const suggestion of analysis.freshScopeSuggestions) {
    const item = addScopeCriterion(project, suggestion.text, suggestion.status);
    addedCriteria.push({ criterionId: item.id, status: item.status, text: item.text, reason: suggestion.reason });
  }

  return { appliedChanges, addedCriteria };
}

export function formatAgentResultAnalysis(project, analysis, record = null) {
  const lines = [
    `RESULT INGESTION — ${project.name} / ${analysis.scopeId}`,
    record ? `Result: ${record.id}` : null,
    `Agent: ${analysis.agent}`,
    `Evidence: ${analysis.evidence.length}`,
    `Suggested status changes: ${analysis.statusChanges.length}`,
    `New scope suggestions: ${analysis.freshScopeSuggestions.length}`,
    ""
  ].filter(Boolean);

  if (analysis.evidence.length) {
    lines.push("EVIDENCE");
    for (const item of analysis.evidence) lines.push(`  ✓ ${item.label}${item.detail ? ` — ${item.detail}` : ""}`);
    lines.push("");
  }

  lines.push("TARGET GATE");
  lines.push(`  ${analysis.targetCriterion.id} [${analysis.targetCriterion.status}] ${analysis.targetCriterion.text}`);
  if (analysis.targetDisposition) {
    lines.push(`  Decision: ${analysis.targetDisposition.action}`);
    lines.push(`  Reason: ${analysis.targetDisposition.reason}`);
  } else {
    lines.push("  Decision: no explicit gate disposition detected");
  }
  lines.push("");

  if (analysis.statusChanges.length) {
    lines.push("SCOPE STATUS SUGGESTIONS");
    for (const item of analysis.statusChanges) {
      lines.push(`  ${item.criterionId} ${item.from} -> ${item.to} [${item.confidence.toUpperCase()}]`);
      lines.push(`    ${item.reason}`);
    }
    lines.push("");
  }

  if (analysis.blockers.length) {
    lines.push("BLOCKERS FOUND");
    for (const item of analysis.blockers) {
      lines.push(`  ! ${item.text}`);
      lines.push(`    ${item.reason}`);
    }
    lines.push("");
  }

  if (analysis.scopeSuggestions.length) {
    lines.push("SCOPE SUGGESTIONS");
    for (const item of analysis.scopeSuggestions) {
      if (item.fresh) lines.push(`  + [${item.status}] ${item.text}`);
      else lines.push(`  = covered by ${item.existingCriterionId}: ${item.text}`);
      lines.push(`    ${item.reason}`);
    }
    lines.push("");
  }

  lines.push("Use --apply to apply HIGH-confidence status changes and add fresh blocker/scope criteria.");
  return lines.join("\n");
}
