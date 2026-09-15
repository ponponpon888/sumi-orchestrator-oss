function normalizeText(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^c\d{3}\s+/i, "")
    .replace(/[#＃]\s*\d+/g, "#")
    .replace(/[（）()「」『』【】\[\]、。,:：/\\\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyAction(text) {
  const t = normalizeText(text);
  if (!t) return null;

  const billingTerms = /(billing|spending limit|支払い|課金|請求)/;
  const platformConfigTerms = /(dashboard|管理画面|console|hostname|domain|configuration|configure|settings?|設定|許可|allowlist|dns)/;
  if ((/github/.test(t) || /\bci\b/.test(t)) && billingTerms.test(t)) {
    return "ci-billing";
  }
  if (/(cloudflare|turnstile)/.test(t) && platformConfigTerms.test(t)) {
    return "cloudflare-config";
  }
  if (/vercel/.test(t) && platformConfigTerms.test(t)) {
    return "vercel-config";
  }
  if (/supabase/.test(t) && platformConfigTerms.test(t)) {
    return "supabase-config";
  }
  if ((/github actions|\bci\b/.test(t)) && /(baseline|main|基盤|切り分け|障害)/.test(t)) {
    return "ci-baseline";
  }
  if (/ブラウザ|browser/.test(t) && /(検証|確認|verify|verification|test)/.test(t)) {
    return "browser-verification";
  }
  if (/(vercel|preview)/.test(t) && /(キャンセル|cancel|ignored build|理由)/.test(t)) {
    return "preview-cancel-reason";
  }
  if (/(production|本番)/.test(t) && /(smoke|スモーク|検証|確認)/.test(t)) {
    return "production-smoke";
  }
  if (/未コミット|working tree|worktree|ローカルの.*変更/.test(t)) {
    return "local-changes";
  }
  if (/supabase/.test(t) && /(状態|health|healthy|確認)/.test(t)) {
    return "supabase-health";
  }
  if (/pr\s*#|pull request/.test(t) && /(マージ|merge|レビュー|review|変更内容|マージ可能)/.test(t)) {
    return "pr-review-merge";
  }
  if (/(vercel|preview)/.test(t) && /(失敗|failed|failure)/.test(t)) {
    return "preview-failure";
  }
  if (/github actions|\bci\b/.test(t) && /(失敗|failed|failure|修正)/.test(t)) {
    return "ci-failure";
  }
  return null;
}

function exactKey(text) {
  return `text:${normalizeText(text)}`;
}

function semanticKey(text) {
  return classifyAction(text) || exactKey(text);
}

function criterionDisplay(item) {
  return `${item.id} ${item.text}`;
}

function isRemediationReason(reason) {
  return /\bremediation\s+scope\b/i.test(String(reason || ""));
}

function remediationCriterionIds(result) {
  const ids = new Set();
  const suggestions = (result.scopeSuggestions || []).filter((item) => isRemediationReason(item.reason));
  for (const suggestion of suggestions) {
    if (suggestion.existingCriterionId) ids.add(suggestion.existingCriterionId);
  }
  for (const added of result.addedCriteria || []) {
    const matchingSuggestion = suggestions.some((item) => item.text === added.text);
    if (isRemediationReason(added.reason) || matchingSuggestion) ids.add(added.criterionId);
  }
  return ids;
}

export function remediationDependencies(project, scopeId) {
  const criteria = project.scope?.criteria || [];
  const ids = new Set();
  for (const result of project.agentResults || []) {
    if (result.scopeId !== scopeId) continue;
    for (const id of remediationCriterionIds(result)) ids.add(id);
  }
  return [...ids].map((id) => criteria.find((item) => item.id === id)).filter(Boolean);
}

export function remediationParents(project, scopeId) {
  const criteria = project.scope?.criteria || [];
  const ids = new Set();
  for (const result of project.agentResults || []) {
    if (remediationCriterionIds(result).has(scopeId)) ids.add(result.scopeId);
  }
  return [...ids].map((id) => criteria.find((item) => item.id === id)).filter(Boolean);
}

export function effectiveScopeStatus(project, criterion) {
  if (!criterion || criterion.status !== "blocked") return criterion?.status || null;
  const legacyBlockedRemediation = (project.agentResults || []).some((result) =>
    (result.addedCriteria || []).some((item) =>
      item.criterionId === criterion.id &&
      item.status === "blocked" &&
      isRemediationReason(item.reason) &&
      (result.appliedAt
        ? Date.parse(criterion.updatedAt) <= Date.parse(result.appliedAt)
        : criterion.updatedAt === criterion.createdAt)
    )
  );
  return legacyBlockedRemediation ? "todo" : criterion.status;
}

/**
 * Build a single prioritized NEXT queue from explicit actions, live observations,
 * and the project's completion scope.
 *
 * Rules:
 * - An inferred action matching a done/cancelled scope criterion is suppressed.
 * - An inferred action matching an open criterion is represented by the scope ID.
 * - Exact or semantic duplicates appear only once.
 * - Remaining open scope criteria stay visible after urgent observed actions.
 */
export function buildNextQueue(project, { limit = 8 } = {}) {
  const criteria = project.scope?.criteria || [];
  const explicit = (project.nextActions || []).filter((n) => !n.done).map((n) => n.text);
  const inferred = project.observations?.inferredNext || [];

  const criteriaByKey = new Map();
  for (const item of criteria) {
    const key = semanticKey(item.text);
    if (!criteriaByKey.has(key)) criteriaByKey.set(key, []);
    criteriaByKey.get(key).push(item);
  }

  const output = [];
  const usedScope = new Set();
  const seen = new Set();

  function addText(text, key = semanticKey(text)) {
    if (!text || seen.has(key)) return;
    seen.add(key);
    output.push(text);
  }

  function addObserved(text) {
    if (!text) return;
    const key = semanticKey(text);
    const matches = criteriaByKey.get(key) || [];
    if (matches.length) {
      const open = matches.find((item) => !["done", "cancelled"].includes(effectiveScopeStatus(project, item)));
      if (open) {
        usedScope.add(open.id);
        addText(criterionDisplay(open), key);
      }
      // If every matching completion criterion is already done/cancelled, the
      // observed reminder is stale and should disappear from NEXT.
      return;
    }
    addText(text, key);
  }

  // Explicit user-managed actions remain highest priority.
  for (const text of explicit) addObserved(text);

  // Explicit blockers are surfaced before normal observed work. A blocked gate is
  // often the reason the rest of the release cannot advance, and may route to a
  // human/platform action rather than another coding task.
  for (const item of criteria.filter((x) => effectiveScopeStatus(project, x) === "blocked")) {
    usedScope.add(item.id);
    addText(criterionDisplay(item));
  }

  // Live observations come next, but collapse into matching scope criteria.
  for (const text of inferred) addObserved(text);

  // Keep all remaining unfinished Definition-of-Done items visible even without a live signal.
  for (const item of criteria) {
    if (["done", "cancelled", "blocked"].includes(effectiveScopeStatus(project, item)) || usedScope.has(item.id)) continue;
    addText(criterionDisplay(item));
  }

  return output.slice(0, limit);
}
