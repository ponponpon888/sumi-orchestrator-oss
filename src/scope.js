import { classifyAction } from "./next.js";
import { setScopeCriterionStatus } from "./domain.js";
import { getBlockerRecovery } from "./recovery.js";

function suggestion(key, text, status, reason, evidence = []) {
  return { key, text, status, reason, evidence };
}

export function observedScopeSuggestions(project) {
  const o = project.observations || {};
  const github = o.github || {};
  const verification = o.verification || {};
  const vercel = o.vercel || {};
  const out = [];
  const pr = project.deployment?.pr;

  if (pr && github.openPrTitle) {
    out.push(suggestion(
      "pr-review-merge",
      `PR #${pr}の変更内容を確認しマージ可能状態にする`,
      "doing",
      `GitHubでPR #${pr}がopen`,
      [github.openPrTitle]
    ));
  }

  if (github.baselineFailureLikely) {
    out.push(suggestion(
      "ci-baseline",
      "GitHub Actionsのbaseline CI障害を切り分ける",
      "doing",
      "PRとmainのCIが同系統で失敗している可能性が高い",
      github.baselineCi ? [`${github.baselineCi.branch}: ${github.baselineCi.status}`] : []
    ));
  } else if (project.deployment?.ci === "failed") {
    out.push(suggestion(
      "ci-failure",
      pr ? `PR #${pr}のCI失敗を解消する` : "CI失敗を解消する",
      "doing",
      "現在のCIがfailed",
      (github.failedJobs || []).map((job) => job.name)
    ));
  }

  if (verification.required && verification.status === "pending") {
    out.push(suggestion(
      "browser-verification",
      verification.label?.toLowerCase().includes("browser")
        ? "認証フローを実ブラウザで検証する"
        : "変更内容を実ブラウザで検証する",
      "todo",
      verification.reason || "ブラウザ/手動検証が未完了",
      verification.label ? [verification.label] : []
    ));
  }

  if (project.deployment?.preview === "cancelled") {
    out.push(suggestion(
      "preview-cancel-reason",
      "Vercel Previewキャンセル理由を確認する",
      "todo",
      "現在のPreview Deploymentがcancelled",
      vercel.preview?.url ? [vercel.preview.url] : []
    ));
  } else if (project.deployment?.preview === "failed") {
    out.push(suggestion(
      "preview-failure",
      "Vercel Previewの失敗を解消する",
      "doing",
      "現在のPreview Deploymentがfailed",
      vercel.preview?.url ? [vercel.preview.url] : []
    ));
  }

  if (pr && project.deployment?.production === "ready") {
    out.push(suggestion(
      "production-smoke",
      "マージ後にProduction smoke testを完了する",
      "todo",
      "ProductionはREADYだが現在のopen PRはまだ本番反映前",
      vercel.production?.url ? [vercel.production.url] : []
    ));
  }

  return out;
}

function criterionKey(item) {
  return classifyAction(item.text) || `text:${String(item.text || "").normalize("NFKC").toLowerCase().trim()}`;
}

export function getScopeSuggestions(project) {
  const suggestions = observedScopeSuggestions(project);
  const existing = project.scope?.criteria || [];
  const covered = [];
  const fresh = [];

  for (const item of suggestions) {
    const match = existing.find((criterion) => criterionKey(criterion) === item.key);
    if (match) covered.push({ suggestion: item, criterion: match });
    else fresh.push(item);
  }

  return { observed: suggestions, covered, fresh };
}

export function formatScopeSuggestions(project, result = getScopeSuggestions(project)) {
  const lines = [
    `SCOPE SUGGESTIONS — ${project.name}`,
    `Observed gates: ${result.observed.length}`,
    `Covered by current scope: ${result.covered.length}`,
    `New suggestions: ${result.fresh.length}`,
    ""
  ];

  if (result.covered.length) {
    lines.push("COVERED");
    for (const { suggestion: s, criterion: c } of result.covered) {
      lines.push(`  ✓ ${c.id} [${c.status}] ${c.text}`);
      lines.push(`    Evidence: ${s.reason}`);
    }
    lines.push("");
  }

  if (result.fresh.length) {
    lines.push("SUGGEST");
    for (const s of result.fresh) {
      lines.push(`  + [${s.status}] ${s.text}`);
      lines.push(`    Reason: ${s.reason}`);
      if (s.evidence.length) lines.push(`    Evidence: ${s.evidence.join(" | ")}`);
    }
  } else {
    lines.push("No new completion criteria suggested from current observations.");
  }

  return lines.join("\n");
}

function criterionPrNumber(text) {
  const match = String(text || "").match(/PR\s*#\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

function statusSuggestion(criterion, to, confidence, reason, evidence = []) {
  return {
    criterion,
    from: criterion.status,
    to,
    confidence,
    reason,
    evidence
  };
}

/**
 * Review existing scope criteria against current observations and recommend
 * status transitions. This never mutates the project.
 *
 * High-confidence transitions are intentionally conservative and require
 * direct evidence such as a merged PR, successful CI on both PR/base,
 * completed browser verification, or explicit production verification.
 */
export function getScopeStatusSuggestions(project) {
  const criteria = project.scope?.criteria || [];
  const o = project.observations || {};
  const github = o.github || {};
  const verification = o.verification || {};
  const changes = [];
  const unchanged = [];

  for (const criterion of criteria) {
    if (["done", "cancelled"].includes(criterion.status)) {
      unchanged.push({ criterion, reason: "criterion is already terminal" });
      continue;
    }

    const key = criterionKey(criterion);
    let suggestion = null;

    if (key === "pr-review-merge") {
      const prNumber = criterionPrNumber(criterion.text);
      const merged = (github.recentMergedPrs || []).find((pr) => Number(pr.number) === prNumber);
      if (merged) {
        suggestion = statusSuggestion(
          criterion,
          "done",
          "high",
          `PR #${prNumber} is merged`,
          [merged.title || "merged PR", merged.mergedAt || ""].filter(Boolean)
        );
      } else if (project.deployment?.pr && (!prNumber || Number(project.deployment.pr) === prNumber)) {
        suggestion = statusSuggestion(
          criterion,
          "doing",
          "medium",
          `PR #${project.deployment.pr} is still open`,
          github.openPrTitle ? [github.openPrTitle] : []
        );
      }
    } else if (key === "ci-baseline") {
      if (project.deployment?.ci === "ready" && github.baselineCi?.status === "ready") {
        suggestion = statusSuggestion(
          criterion,
          "done",
          "high",
          "PR CI and baseline CI are both ready",
          [github.baselineCi?.branch ? `${github.baselineCi.branch}: ready` : "baseline: ready"]
        );
      } else if (github.baselineFailureLikely) {
        suggestion = statusSuggestion(
          criterion,
          "doing",
          "medium",
          "PR and baseline CI still appear to share the same failure class",
          github.baselineCi ? [`${github.baselineCi.branch}: ${github.baselineCi.status}`] : []
        );
      }
    } else if (key === "ci-failure") {
      if (project.deployment?.ci === "ready") {
        suggestion = statusSuggestion(criterion, "done", "high", "Current CI is ready");
      } else if (project.deployment?.ci === "failed") {
        suggestion = statusSuggestion(criterion, "doing", "medium", "Current CI is still failed");
      }
    } else if (key === "ci-billing") {
      const recovery = getBlockerRecovery(project, criterion.id);
      if (recovery.suggestion) {
        suggestion = statusSuggestion(
          criterion,
          recovery.suggestion.to,
          recovery.suggestion.confidence,
          recovery.suggestion.reason,
          recovery.liveEvidence
        );
      }
    } else if (key === "browser-verification") {
      if (verification.required && verification.status === "ready") {
        suggestion = statusSuggestion(
          criterion,
          "done",
          "high",
          verification.evidence || "Browser/manual verification is complete"
        );
      } else if (verification.required && verification.status === "pending") {
        suggestion = statusSuggestion(
          criterion,
          "todo",
          "medium",
          verification.evidence || "Browser/manual verification is still pending"
        );
      }
    } else if (key === "preview-cancel-reason") {
      if (project.deployment?.preview === "cancelled") {
        // Deployment cancellation alone proves the condition exists, not that a
        // human investigated the reason. Never auto-complete this criterion.
        suggestion = statusSuggestion(
          criterion,
          "doing",
          "medium",
          "Preview remains cancelled; external state cannot prove the reason was reviewed",
          o.vercel?.preview?.url ? [o.vercel.preview.url] : []
        );
      }
    } else if (key === "preview-failure") {
      if (project.deployment?.preview === "ready") {
        suggestion = statusSuggestion(criterion, "done", "high", "Preview deployment is ready");
      } else if (project.deployment?.preview === "failed") {
        suggestion = statusSuggestion(criterion, "doing", "medium", "Preview deployment is still failed");
      }
    } else if (key === "production-smoke") {
      if (project.deployment?.production === "verified") {
        suggestion = statusSuggestion(
          criterion,
          "done",
          "high",
          "Production is explicitly verified",
          project.deployment.productionCheckedAt ? [project.deployment.productionCheckedAt] : []
        );
      } else if (project.deployment?.production === "ready") {
        suggestion = statusSuggestion(
          criterion,
          "todo",
          "medium",
          "Production is ready but not manually verified"
        );
      }
    }

    if (suggestion && suggestion.to !== criterion.status) changes.push(suggestion);
    else unchanged.push({ criterion, reason: suggestion?.reason || "no stronger evidence for a status change" });
  }

  return {
    changes,
    highConfidence: changes.filter((item) => item.confidence === "high"),
    mediumConfidence: changes.filter((item) => item.confidence === "medium"),
    unchanged
  };
}

export function formatScopeStatusSuggestions(project, result = getScopeStatusSuggestions(project)) {
  const lines = [
    `SCOPE REVIEW — ${project.name}`,
    `Criteria: ${(project.scope?.criteria || []).length}`,
    `Suggested changes: ${result.changes.length}`,
    `High confidence: ${result.highConfidence.length}`,
    `Needs judgment: ${result.mediumConfidence.length}`,
    ""
  ];

  if (!result.changes.length) {
    lines.push("No scope status changes suggested from current evidence.");
    return lines.join("\n");
  }

  if (result.highConfidence.length) {
    lines.push("HIGH CONFIDENCE");
    for (const item of result.highConfidence) {
      lines.push(`  ${item.criterion.id} ${item.from} -> ${item.to}`);
      lines.push(`    ${item.criterion.text}`);
      lines.push(`    Evidence: ${item.reason}`);
      if (item.evidence.length) lines.push(`    Detail: ${item.evidence.join(" | ")}`);
    }
    lines.push("");
  }

  if (result.mediumConfidence.length) {
    lines.push("REVIEW MANUALLY");
    for (const item of result.mediumConfidence) {
      lines.push(`  ${item.criterion.id} ${item.from} -> ${item.to} (suggested)`);
      lines.push(`    ${item.criterion.text}`);
      lines.push(`    Reason: ${item.reason}`);
      if (item.evidence.length) lines.push(`    Detail: ${item.evidence.join(" | ")}`);
    }
  }

  return lines.join("\n");
}

export function applyScopeStatusSuggestions(project, result = getScopeStatusSuggestions(project)) {
  const applied = [];
  for (const item of result.highConfidence) {
    const criterion = (project.scope?.criteria || []).find((c) => c.id === item.criterion.id);
    if (!criterion || criterion.status === item.to) continue;
    const from = criterion.status;
    setScopeCriterionStatus(project, criterion.id, item.to);
    applied.push({ criterion, from, to: item.to, reason: item.reason });
  }
  if (applied.length) project.updatedAt = new Date().toISOString();
  return applied;
}
