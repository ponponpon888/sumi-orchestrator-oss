import { runCommand } from "./sync.js";

/**
 * GitHub observation through the REST API (`gh api`), never GraphQL.
 *
 * `gh pr list` / `gh run list` / `gh run view` go through GraphQL, which some
 * environments (cloud sessions, restricted tokens) cannot reach. Everything
 * SUMI reads here has a REST equivalent, so SUMI can observe GitHub wherever
 * `gh api` works. Each reader returns { ok, data } or { ok: false, error }
 * and never throws; the shapes match what the GraphQL commands returned, so
 * the rest of sync is unchanged.
 */

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// Query parameters travel as `-f key=value` on a GET, never in the route:
// a route with "&" would be refused when `gh` resolves to a Windows .cmd shim.
function queryArgs(params = {}) {
  return Object.entries(params).flatMap(([key, value]) => ["-f", `${key}=${value}`]);
}

export function createGithubApi({ run = runCommand, timeout = 30000 } = {}) {
  return (route, params = {}) => {
    const result = run("gh", ["api", "-X", "GET", "-H", "Accept: application/vnd.github+json", route, ...queryArgs(params)], { timeout });
    if (!result.ok) return { ok: false, error: result.stderr || result.error || `gh api ${route} failed` };
    try {
      return { ok: true, data: JSON.parse(result.stdout || "null") };
    } catch {
      return { ok: false, error: `gh api ${route} returned unreadable JSON` };
    }
  };
}

/** The raw-text variant, for job logs. */
export function createGithubTextApi({ run = runCommand, timeout = 30000 } = {}) {
  return (route, params = {}) => {
    const result = run("gh", ["api", "-X", "GET", route, ...queryArgs(params)], { timeout });
    return result.ok ? { ok: true, data: result.stdout || "" } : { ok: false, error: result.stderr || result.error || `gh api ${route} failed` };
  };
}

function assertRepo(repo) {
  if (!REPO.test(String(repo || ""))) throw new Error(`Invalid GitHub repository: ${repo}`);
  return repo;
}

function enc(value) {
  return encodeURIComponent(String(value));
}

function mapResult(result, mapper) {
  if (!result.ok) return result;
  try {
    return { ok: true, data: mapper(result.data) };
  } catch (error) {
    return { ok: false, error: `unexpected GitHub response: ${error.message}` };
  }
}

export function getDefaultBranch(api, repo) {
  return mapResult(api(`repos/${assertRepo(repo)}`), (data) => {
    if (typeof data?.default_branch !== "string" || !data.default_branch) throw new Error("no default_branch");
    return data.default_branch;
  });
}

export function mapPull(pr) {
  return {
    number: pr.number,
    title: pr.title ?? null,
    body: pr.body ?? null,
    state: String(pr.state || "open").toUpperCase(),
    headRefName: pr.head?.ref ?? null,
    headRefOid: pr.head?.sha ?? null,
    // A fork's PR can share a branch name with this repository's branch.
    headRepo: pr.head?.repo?.full_name ?? null,
    url: pr.html_url ?? null
  };
}

export function listOpenPulls(api, repo) {
  return mapResult(api(`repos/${assertRepo(repo)}/pulls`, { state: "open", per_page: 20 }), (data) => {
    if (!Array.isArray(data)) throw new Error("pulls is not a list");
    return data.map(mapPull);
  });
}

/**
 * The same rollup `gh pr list --json statusCheckRollup` returned: check runs
 * plus commit status contexts. The combined status's own `state` is NOT used:
 * GitHub reports "pending" for a commit that has no statuses at all, which
 * would hold every repository without status contexts at "pending" forever.
 */
const MAX_PAGES = 10;

/**
 * Read every page of a list endpoint that reports `total_count`. If the
 * pages run out before the total is reached, the read is incomplete and is
 * reported as an error: a "ready" computed from part of the checks would be
 * an answer about checks SUMI never saw.
 */
function readAllPages(api, route, key) {
  const items = [];
  let total = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = api(route, { per_page: 100, page });
    if (!result.ok) return result;
    const list = result.data?.[key];
    if (!Array.isArray(list)) return { ok: false, error: `unexpected GitHub response: ${key} is not a list` };
    total = Number.isInteger(result.data.total_count) ? result.data.total_count : total;
    items.push(...list);
    if (list.length === 0 || total === null || items.length >= total) break;
  }
  if (total !== null && items.length < total) {
    return { ok: false, error: `read ${items.length} of ${total} ${key}; refusing to judge CI from part of them` };
  }
  return { ok: true, data: items };
}

/**
 * The same rollup `gh pr list --json statusCheckRollup` returned: check runs
 * plus commit status contexts. The combined status's own `state` is NOT used:
 * GitHub reports "pending" for a commit that has no statuses at all, which
 * would hold every repository without status contexts at "pending" forever.
 */
export function getCommitChecks(api, repo, sha) {
  const base = `repos/${assertRepo(repo)}/commits/${enc(sha)}`;
  const runs = readAllPages(api, `${base}/check-runs`, "check_runs");
  if (!runs.ok) return runs;
  const statuses = readAllPages(api, `${base}/status`, "statuses");
  if (!statuses.ok) return statuses;
  return mapResult({ ok: true, data: { runs: runs.data, statuses: statuses.data } }, ({ runs: r, statuses: st }) => [
    ...r.map((check) => ({
      name: check.name ?? "check",
      status: check.status ? String(check.status).toUpperCase() : null,
      conclusion: check.conclusion ? String(check.conclusion).toUpperCase() : null,
      detailsUrl: check.html_url ?? check.details_url ?? null
    })),
    ...st.map((status) => ({
      context: status.context ?? "status",
      state: status.state ? String(status.state).toUpperCase() : null,
      targetUrl: status.target_url ?? null
    }))
  ]);
}

export function mapRun(run) {
  return {
    databaseId: run.id,
    // gh's `name` is the run's display title and `workflowName` the
    // workflow; REST calls the workflow `name`.
    name: run.display_title ?? run.name ?? null,
    workflowName: run.name ?? null,
    status: run.status ?? null,
    conclusion: run.conclusion ?? null,
    url: run.html_url ?? null,
    event: run.event ?? null,
    headSha: run.head_sha ?? null,
    createdAt: run.created_at ?? null
  };
}

export function listRuns(api, repo, { branch = null, headSha = null, perPage = 20 } = {}) {
  const params = { per_page: Number(perPage) };
  if (branch) params.branch = branch;
  if (headSha) params.head_sha = headSha;
  return mapResult(api(`repos/${assertRepo(repo)}/actions/runs`, params), (data) => {
    if (!Array.isArray(data?.workflow_runs)) throw new Error("workflow_runs is not a list");
    return data.workflow_runs.map(mapRun);
  });
}

export function listRunJobs(api, repo, runId) {
  return mapResult(api(`repos/${assertRepo(repo)}/actions/runs/${enc(runId)}/jobs`), (data) => {
    if (!Array.isArray(data?.jobs)) throw new Error("jobs is not a list");
    return data.jobs.map((job) => ({
      id: job.id,
      name: job.name ?? "job",
      conclusion: job.conclusion ?? null,
      url: job.html_url ?? null,
      steps: Array.isArray(job.steps) ? job.steps.map((step) => ({ name: step.name ?? "step", conclusion: step.conclusion ?? null })) : []
    }));
  });
}

export function listWorkflows(api, repo) {
  const all = readAllPages(api, `repos/${assertRepo(repo)}/actions/workflows`, "workflows");
  if (!all.ok) return all;
  return { ok: true, data: all.data.map((workflow) => ({ name: workflow.name ?? workflow.path ?? "workflow", state: workflow.state ?? null, path: workflow.path ?? null })) };
}

export function getBranchHead(api, repo, branch) {
  return mapResult(api(`repos/${assertRepo(repo)}/commits/${enc(branch)}`), (data) => {
    if (!/^[0-9a-f]{40}$/i.test(String(data?.sha || ""))) throw new Error("no commit sha");
    return { sha: data.sha, committedAt: data.commit?.committer?.date ?? data.commit?.author?.date ?? null };
  });
}

/** The newest commits of a branch, newest first: [{ sha, committedAt }]. */
export function listBranchCommits(api, repo, branch, perPage = 30) {
  return mapResult(api(`repos/${assertRepo(repo)}/commits`, { sha: branch, per_page: Number(perPage) }), (data) => {
    if (!Array.isArray(data)) throw new Error("commits is not a list");
    return data.map((commit) => {
      if (!/^[0-9a-f]{40}$/i.test(String(commit?.sha || ""))) throw new Error("commit without a sha");
      return { sha: commit.sha, committedAt: commit.commit?.committer?.date ?? commit.commit?.author?.date ?? null };
    });
  });
}

/**
 * The latest status of each Vercel context on a commit (the combined status
 * keeps only the newest per context). Vercel's Git integration posts one per
 * connected project: "Vercel", or "Vercel – <project>" when several share a
 * repository.
 */
export function getVercelStatuses(api, repo, sha) {
  return mapResult(api(`repos/${assertRepo(repo)}/commits/${enc(sha)}/status`, { per_page: 100 }), (data) => {
    if (!Array.isArray(data?.statuses)) throw new Error("statuses is not a list");
    return data.statuses
      .filter((status) => /^vercel\b/i.test(String(status?.context || "")))
      .map((status) => ({
        context: status.context,
        state: status.state ?? null,
        description: status.description ?? null,
        url: status.target_url ?? null,
        updatedAt: status.updated_at ?? status.created_at ?? null
      }));
  });
}

/** Read a list endpoint that returns a bare array, page by page. */
function readArrayPages(api, route, params = {}) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = api(route, { ...params, per_page: 100, page });
    if (!result.ok) return result;
    if (!Array.isArray(result.data)) return { ok: false, error: `unexpected GitHub response: ${route} is not a list` };
    items.push(...result.data);
    if (result.data.length < 100) return { ok: true, data: items };
  }
  return { ok: false, error: `${route} has more than ${MAX_PAGES * 100} items; refusing to judge from part of them` };
}

/** REST state + merged_at, in the OPEN / MERGED / CLOSED vocabulary of `gh pr`. */
export function pullState(pr) {
  const state = String(pr?.state || "").toLowerCase();
  if (state === "open") return "OPEN";
  if (state === "closed") return pr?.merged_at ? "MERGED" : "CLOSED";
  return state ? state.toUpperCase() : null;
}

/**
 * Pull requests whose head is `branch` in this repository (never a fork's
 * branch of the same name), in every state, newest first.
 */
export function listPullsForBranch(api, repo, branch) {
  const owner = assertRepo(repo).split("/")[0];
  return mapResult(api(`repos/${repo}/pulls`, { state: "all", head: `${owner}:${branch}`, sort: "created", direction: "desc", per_page: 10 }), (data) => {
    if (!Array.isArray(data)) throw new Error("pulls is not a list");
    return data.filter((pr) => !pr.head?.repo?.full_name || pr.head.repo.full_name.toLowerCase() === repo.toLowerCase());
  });
}

export function getPull(api, repo, number) {
  if (!/^\d+$/.test(String(number))) return { ok: false, error: `Invalid pull request number: ${number}` };
  return mapResult(api(`repos/${assertRepo(repo)}/pulls/${number}`), (data) => {
    if (!Number.isInteger(data?.number)) throw new Error("pull request without a number");
    return data;
  });
}

export function listPullReviews(api, repo, number) {
  return readArrayPages(api, `repos/${assertRepo(repo)}/pulls/${enc(number)}/reviews`);
}

/**
 * GitHub's own review decision is GraphQL-only. Over REST it is derived from
 * each reviewer's latest decisive review: any CHANGES_REQUESTED wins, then
 * APPROVED. "Review required by branch protection" cannot be read without
 * admin rights; GitHub then reports the PR's mergeable_state as "blocked",
 * which the release gate already treats as not ready.
 */
export function deriveReviewDecision(reviews) {
  const latest = new Map();
  for (const review of Array.isArray(reviews) ? reviews : []) {
    const state = String(review?.state || "").toUpperCase();
    if (!["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(state)) continue;
    const who = review.user?.login || review.author?.login || `#${review.id}`;
    const at = Date.parse(review.submitted_at || review.submittedAt || "") || 0;
    const previous = latest.get(who);
    if (!previous || at >= previous.at) latest.set(who, { state, at });
  }
  const states = [...latest.values()].map((entry) => entry.state);
  if (states.includes("CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
  if (states.includes("APPROVED")) return "APPROVED";
  return null;
}

/** REST mergeable (true/false/null) in the MERGEABLE / CONFLICTING / UNKNOWN vocabulary. */
export function mergeableLabel(value) {
  if (value === true) return "MERGEABLE";
  if (value === false) return "CONFLICTING";
  return "UNKNOWN";
}

/** Commits on `head` that `base` does not have. */
export function countCommitsSince(api, repo, base, head) {
  return mapResult(api(`repos/${assertRepo(repo)}/compare/${enc(base)}...${enc(head)}`), (data) => {
    if (!Number.isInteger(data?.ahead_by)) throw new Error("no ahead_by");
    return data.ahead_by;
  });
}

export function listRecentMergedPulls(api, repo, limit = 8) {
  return mapResult(api(`repos/${assertRepo(repo)}/pulls`, { state: "closed", sort: "updated", direction: "desc", per_page: 30 }), (data) => {
    if (!Array.isArray(data)) throw new Error("pulls is not a list");
    return data
      .filter((pr) => pr.merged_at)
      .sort((a, b) => Date.parse(b.merged_at) - Date.parse(a.merged_at))
      .slice(0, limit)
      .map((pr) => ({
        number: pr.number,
        title: pr.title ?? null,
        mergedAt: pr.merged_at,
        url: pr.html_url ?? null,
        headRefName: pr.head?.ref ?? null
      }));
  });
}
