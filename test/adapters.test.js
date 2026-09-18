import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_IDS, CODE_AGENT_IDS, getAgentAdapter, isAutomaticAdapter } from "../src/adapters.js";

test("adapter registry exposes every routed agent", () => {
  assert.deepEqual(AGENT_IDS, ["codex", "claude-code", "browser", "human"]);
});

test("code-agent registry identifies Codex and Claude Code", () => {
  assert.deepEqual(CODE_AGENT_IDS, ["codex", "claude-code"]);
});

test("Codex automatic execution is limited to read-only review", () => {
  const adapter = getAgentAdapter("codex");
  assert.equal(adapter.capability, "read-only");
  assert.equal(isAutomaticAdapter(adapter, "review"), true);
  assert.equal(isAutomaticAdapter(adapter, "execute"), false);
});

test("Claude Code remains write-capable, isolated and manual", () => {
  const adapter = getAgentAdapter("claude-code");
  assert.equal(adapter.capability, "write");
  assert.equal(adapter.requiresIsolation, true);
  assert.equal(isAutomaticAdapter(adapter, "execute"), false);
});

test("unknown agents do not receive an adapter", () => {
  assert.equal(getAgentAdapter("unknown"), null);
});
