import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { addScopeCriterion, createProject, SERVICE_UNUSED } from "../src/domain.js";
import { reviewSession } from "../src/review.js";
import { ingestReviewerResult } from "../src/reviewer.js";
import { startSession } from "../src/sessions.js";
import { getReleaseReadiness, recordReleaseGate } from "../src/release.js";
import { DELIVERY_STATUSES, getDeliveryQueue, getDeliveryReadiness, syncDeliveryEvidence, verifyDelivery } from "../src/delivery.js";

const NOW = new Date("2026-09-11T12:00:00.000Z");
function git(args, cwd = null) { return execFileSync("git", args, { cwd: cwd || undefined, encoding: "utf8" }).trim(); }
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-delivery-repo-"));
  git(["init"], root);
  git(["config", "core.autocrlf", "false"], root); git(["config", "user.name", "SUMI Test"], root); git(["config", "user.email", "sumi-test@example.invalid"], root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", private: true, scripts: { test: "node -e \"process.exit(0)\"", check: "node --check target.js" } }, null, 2) + "\n");
  fs.writeFileSync(path.join(root, "target.js"), "export const target = true;\n");
  git(["add", "."], root); git(["commit", "-m", "initial"], root); return root;
}
function setup({ certify = true } = {}) {
  const local = repo();
  const p = createProject({ id: "app", name: "APP", repo: "example-org/app", local, vercel: "app" });
  p.observations = { inferredNext: [], local: { dirty: false, changedFiles: 0 } };
  const item = addScopeCriterion(p, "Implement authentication middleware", "todo");
  const started = startSession(p, item.id, { worktreeRoot: fs.mkdtempSync(path.join(os.tmpdir(), "sumi-delivery-wt-")), now: NOW });
  const wt = started.session.workspace.path;
  fs.writeFileSync(path.join(wt, "auth.js"), "export const auth = true;\n");
  git(["-C", wt, "add", "auth.js"]); git(["-C", wt, "-c", "user.name=SUMI Test", "-c", "user.email=sumi-test@example.invalid", "commit", "-m", "implement auth"]);
  reviewSession(p, started.session.id, { runChecks: true, now: NOW });
  ingestReviewerResult(p, started.session.id, "VERDICT: MERGEABLE\nNo blocking findings. C001 stay open.", { now: NOW });
  const head = git(["-C", wt, "rev-parse", "HEAD"]);
  started.session.releaseEvidence = {
    observedAt: NOW.toISOString(), repo: p.repo, sessionId: started.session.id, branch: started.session.workspace.branch,
    expectedHead: head, source: "gh", ok: true, error: null,
    pr: { number: 17, title: "Auth", url: "https://example.test/pr/17", state: "OPEN", draft: false, headBranch: started.session.workspace.branch, baseBranch: "main", headSha: head, mergeable: "MERGEABLE", mergeState: "CLEAN", reviewDecision: "APPROVED", ci: "ready", checks: [], latestReviews: [], reviewRequests: [] }
  };
  if (certify) recordReleaseGate(p, started.session.id, getReleaseReadiness(p, started.session.id, { now: NOW }), { now: NOW });
  return { p, started, head };
}
function deliveryEvidence(session, head, patch = {}) {
  session.deliveryEvidence = {
    observedAt: NOW.toISOString(), sessionId: session.id, repo: "example-org/app",
    source: { github: true, production: true }, ok: true, error: null,
    pr: { number: 17, state: "MERGED", mergedAt: NOW.toISOString(), headSha: head, mergeCommit: "a".repeat(40), url: "https://example.test/pr/17" },
    production: { status: "ready", rawStatus: "READY", url: "https://app-prod.vercel.app", environment: "Production" },
    ...patch
  };
}

test("delivery gate requires a stored RELEASE_READY certification", () => {
  const { p, started } = setup({ certify: false });
  assert.equal(getDeliveryReadiness(p, started.session.id, { now: NOW }).status, DELIVERY_STATUSES.RELEASE_CERTIFICATION_REQUIRED);
});

test("delivery gate requires fresh post-merge evidence after certification", () => {
  const { p, started } = setup();
  assert.equal(getDeliveryReadiness(p, started.session.id, { now: NOW }).status, DELIVERY_STATUSES.SYNC_REQUIRED);
});

test("delivery gate refuses a merged PR whose head differs from certified HEAD", () => {
  const { p, started, head } = setup();
  deliveryEvidence(started.session, head, { pr: { number: 17, state: "MERGED", mergedAt: NOW.toISOString(), headSha: "f".repeat(40), mergeCommit: "a".repeat(40), url: "https://example.test/pr/17" } });
  assert.equal(getDeliveryReadiness(p, started.session.id, { now: NOW }).status, DELIVERY_STATUSES.MERGED_HEAD_MISMATCH);
});

test("delivery gate tracks production pending for the exact merge commit", () => {
  const { p, started, head } = setup();
  deliveryEvidence(started.session, head, { production: { status: "pending", url: "https://app-prod.vercel.app", environment: "Production" } });
  assert.equal(getDeliveryReadiness(p, started.session.id, { now: NOW }).status, DELIVERY_STATUSES.PRODUCTION_PENDING);
});

test("READY production still requires explicit verification", () => {
  const { p, started, head } = setup();
  deliveryEvidence(started.session, head);
  assert.equal(getDeliveryReadiness(p, started.session.id, { now: NOW }).status, DELIVERY_STATUSES.VERIFICATION_REQUIRED);
});

test("explicit verification binds to merge commit and promotes delivery to DELIVERED", () => {
  const { p, started, head } = setup();
  deliveryEvidence(started.session, head);
  const row = verifyDelivery(p, started.session.id, { now: NOW, note: "production smoke test passed" });
  assert.equal(row.status, DELIVERY_STATUSES.DELIVERED);
  assert.equal(started.session.deliveryVerification.mergeCommit, "a".repeat(40));
});

test("delivery evidence expires instead of preserving an old production decision", () => {
  const { p, started, head } = setup();
  deliveryEvidence(started.session, head);
  const later = new Date(NOW.getTime() + 16 * 60 * 1000);
  assert.equal(getDeliveryReadiness(p, started.session.id, { now: later, maxAgeMinutes: 15 }).status, DELIVERY_STATUSES.EVIDENCE_STALE);
});

test("delivery queue prioritizes production failures before delivered sessions", () => {
  const delivered = setup(); delivered.p.id = "delivered"; delivered.p.name = "DELIVERED"; deliveryEvidence(delivered.started.session, delivered.head); verifyDelivery(delivered.p, delivered.started.session.id, { now: NOW });
  const failed = setup(); failed.p.id = "failed"; failed.p.name = "FAILED"; deliveryEvidence(failed.started.session, failed.head, { production: { status: "failed", url: "https://app-prod.vercel.app", environment: "Production" } });
  const rows = getDeliveryQueue({ delivered: delivered.p, failed: failed.p }, { now: NOW });
  assert.equal(rows[0].status, DELIVERY_STATUSES.PRODUCTION_FAILED);
  assert.equal(rows[1].status, DELIVERY_STATUSES.DELIVERED);
});

test("delivery gate names vercel=none as the reason production evidence must come from elsewhere", () => {
  const { p, started, head } = setup();
  deliveryEvidence(started.session, head);
  p.vercel = SERVICE_UNUSED;

  const row = getDeliveryReadiness(p, started.session.id, { now: NOW });
  assert.equal(row.status, DELIVERY_STATUSES.PRODUCTION_EVIDENCE_REQUIRED);
  assert.match(row.reason, /vercel=none/);
});

// --- syncDeliveryEvidence over REST --------------------------------------

function deliveryApi(head, { pull = {}, statuses = null, statusFails = false } = {}) {
  const merge = "c".repeat(40);
  const calls = [];
  const api = (route) => {
    calls.push(route);
    if (route === "repos/example-org/app/pulls/17") {
      return { ok: true, data: { number: 17, state: "closed", merged_at: NOW.toISOString(), merge_commit_sha: merge, head: { sha: head }, html_url: "https://example.test/pr/17", ...pull } };
    }
    if (route === `repos/example-org/app/commits/${merge}/status`) {
      return statusFails ? { ok: false, error: "HTTP 502" } : { ok: true, data: { statuses: statuses ?? [] } };
    }
    return { ok: false, error: `unrouted: ${route}` };
  };
  api.calls = calls;
  return { api, merge };
}
const vercelStatus = (description, state = "success", context = "Vercel") => ({ context, state, description, target_url: "https://vercel.com/team/app/dpl" });

test("delivery evidence is read over REST; without the Vercel CLI the merge commit's Vercel status is the production evidence", () => {
  const { p, started, head } = setup();
  const { api, merge } = deliveryApi(head, { statuses: [vercelStatus("Deployment has completed")] });
  const evidence = syncDeliveryEvidence(p, started.session.id, { now: NOW, githubApi: api, vercelCliAvailable: false });
  assert.equal(evidence.ok, true, evidence.error);
  assert.equal(evidence.pr.state, "MERGED");
  assert.equal(evidence.pr.mergeCommit, merge);
  assert.deepEqual([evidence.production.status, evidence.production.source], ["ready", "github-status"]);
  assert.equal(getDeliveryReadiness(p, started.session.id, { now: NOW }).status, DELIVERY_STATUSES.VERIFICATION_REQUIRED);
  assert.ok(!api.calls.some((route) => /graphql/i.test(route)));
});

test("a merge commit skipped, failed, pending or without a Vercel status is never READY", () => {
  const status = (statuses, opts = {}) => {
    const { p, started, head } = setup();
    syncDeliveryEvidence(p, started.session.id, { now: NOW, githubApi: deliveryApi(head, { statuses, ...opts }).api, vercelCliAvailable: false });
    return getDeliveryReadiness(p, started.session.id, { now: NOW });
  };
  const skipped = status([vercelStatus("Canceled by Ignored Build Step")]);
  assert.equal(skipped.status, DELIVERY_STATUSES.PRODUCTION_UNKNOWN);
  assert.match(skipped.reason, /Ignored Build Step/);
  assert.equal(status([vercelStatus("Deployment has failed", "failure")]).status, DELIVERY_STATUSES.PRODUCTION_FAILED);
  assert.equal(status([vercelStatus("Vercel is deploying your app", "pending")]).status, DELIVERY_STATUSES.PRODUCTION_PENDING);
  assert.equal(status([vercelStatus("Canceled from the Vercel Dashboard", "failure")]).status, DELIVERY_STATUSES.PRODUCTION_CANCELLED);
  assert.equal(status([]).status, DELIVERY_STATUSES.PRODUCTION_EVIDENCE_REQUIRED);
  assert.equal(status(null, { statusFails: true }).status, DELIVERY_STATUSES.PRODUCTION_EVIDENCE_REQUIRED);
});

test("with several Vercel projects on the repository, only the registered project's status counts", () => {
  const { p, started, head } = setup();
  const statuses = [vercelStatus("Deployment has failed", "failure", "Vercel – admin"), vercelStatus("Deployment has completed", "success", "Vercel – app")];
  const evidence = syncDeliveryEvidence(p, started.session.id, { now: NOW, githubApi: deliveryApi(head, { statuses }).api, vercelCliAvailable: false });
  assert.equal(evidence.production.status, "ready");
  assert.equal(evidence.production.context, "Vercel – app");

  const { p: q, started: s2, head: h2 } = setup();
  const ambiguous = syncDeliveryEvidence(q, s2.session.id, { now: NOW, githubApi: deliveryApi(h2, { statuses: [vercelStatus("Deployment has completed", "success", "Vercel – x"), vercelStatus("Deployment has completed", "success", "Vercel – y")] }).api, vercelCliAvailable: false });
  assert.equal(ambiguous.production.status, "unknown");
  assert.match(ambiguous.production.error, /none names app/);
});

test("an open or closed-unmerged PR has no merge commit (REST's test merge is ignored)", () => {
  const { p, started, head } = setup();
  const evidence = syncDeliveryEvidence(p, started.session.id, { now: NOW, githubApi: deliveryApi(head, { pull: { state: "open", merged_at: null } }).api, vercelCliAvailable: false });
  assert.equal(evidence.pr.state, "OPEN");
  assert.equal(evidence.pr.mergeCommit, null);
  assert.equal(getDeliveryReadiness(p, started.session.id, { now: NOW }).status, DELIVERY_STATUSES.PR_NOT_MERGED);
  const closed = syncDeliveryEvidence(p, started.session.id, { now: NOW, githubApi: deliveryApi(head, { pull: { merged_at: null } }).api, vercelCliAvailable: false });
  assert.equal(closed.pr.state, "CLOSED");
});
