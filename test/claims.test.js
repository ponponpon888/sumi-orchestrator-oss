import test from "node:test";
import assert from "node:assert/strict";
import { addScopeCriterion, createProject, setScopeCriterionStatus } from "../src/domain.js";
import { claimScopeCriterion, formatClaims, getActiveClaim, listClaims, releaseScopeClaim } from "../src/claims.js";

function project(id = "app") {
  return createProject({ id, name: "App", repo: `owner/${id}`, local: `C:\\Dev\\${id}` });
}

const NOW = new Date("2026-09-11T08:00:00.000Z");

test("claim records an expiring owner lease on an open scope criterion", () => {
  const p = project();
  const item = addScopeCriterion(p, "Implement auth middleware", "todo");
  const outcome = claimScopeCriterion(p, item.id, { agent: "claude-code", owner: "claude-1", ttlMinutes: 30, now: NOW });
  assert.equal(outcome.claim.owner, "claude-1");
  assert.equal(outcome.claim.agent, "claude-code");
  assert.equal(outcome.claim.expiresAt, "2026-09-11T08:30:00.000Z");
  assert.equal(getActiveClaim(item, { now: NOW })?.owner, "claude-1");
});

test("active claim prevents duplicate assignment unless explicitly forced", () => {
  const p = project();
  const item = addScopeCriterion(p, "Implement auth middleware", "todo");
  claimScopeCriterion(p, item.id, { agent: "claude-code", owner: "claude-1", now: NOW });
  assert.throws(() => claimScopeCriterion(p, item.id, { agent: "codex", owner: "codex-1", now: NOW }), /already claimed/);
  const forced = claimScopeCriterion(p, item.id, { agent: "codex", owner: "codex-1", force: true, now: NOW });
  assert.equal(forced.claim.owner, "codex-1");
});

test("expired claims can be replaced without force", () => {
  const p = project();
  const item = addScopeCriterion(p, "Implement auth middleware", "todo");
  claimScopeCriterion(p, item.id, { agent: "claude-code", ttlMinutes: 1, now: NOW });
  const later = new Date("2026-09-11T08:02:00.000Z");
  assert.equal(getActiveClaim(item, { now: later }), null);
  const next = claimScopeCriterion(p, item.id, { agent: "codex", now: later });
  assert.equal(next.claim.agent, "codex");
});

test("done scope cannot be claimed and release removes a lease", () => {
  const p = project();
  const done = addScopeCriterion(p, "Already done", "done");
  assert.throws(() => claimScopeCriterion(p, done.id, { agent: "codex", now: NOW }), /Cannot claim/);

  const open = addScopeCriterion(p, "Open work", "todo");
  claimScopeCriterion(p, open.id, { agent: "browser", now: NOW });
  const released = releaseScopeClaim(p, open.id, { now: NOW });
  assert.equal(released.previous.agent, "browser");
  assert.equal(open.claim, undefined);
});

test("claim listing can include expired entries", () => {
  const p = project();
  const item = addScopeCriterion(p, "Open work", "todo");
  claimScopeCriterion(p, item.id, { agent: "browser", ttlMinutes: 1, now: NOW });
  const later = new Date("2026-09-11T08:02:00.000Z");
  assert.equal(listClaims({ app: p }, { now: later }).length, 0);
  const rows = listClaims({ app: p }, { now: later, includeExpired: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].active, false);
  assert.match(formatClaims(rows), /EXPIRED/);
});


test("completing scope clears an active claim", () => {
  const p = project();
  const item = addScopeCriterion(p, "Open work", "todo");
  claimScopeCriterion(p, item.id, { agent: "codex", now: NOW });
  setScopeCriterionStatus(p, item.id, "done");
  assert.equal(item.claim, undefined);
});
