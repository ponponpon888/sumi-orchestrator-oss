import test from "node:test";
import assert from "node:assert/strict";
import { createProject, addScopeCriterion } from "../src/domain.js";
import { dispatchProject } from "../src/dispatch.js";
import { checkBrowserDispatch, closeBrowserDispatch, parseExpectedUrls, startBrowserDispatch, urlMatchesAny } from "../src/browser.js";

function projectWithBrowserDispatch() {
  const p = createProject({ id: "demo", name: "Demo", local: "C:\\Dev\\demo" });
  addScopeCriterion(p, "認証フローを実ブラウザで検証する", "todo");
  p.deployment.preview = "cancelled";
  p.deployment.commit = "a".repeat(40);
  return p;
}

function runnerFactory(currentUrl = "http://localhost:3000/dashboard") {
  const calls = [];
  const runner = ({ args }) => {
    calls.push(args);
    const command = args.at(-2) === "get" ? args.at(-1) : args.find((x) => ["open", "wait", "snapshot", "close"].includes(x));
    if (args.includes("get") && args.at(-1) === "url") return { ok: true, status: 0, stdout: currentUrl, stderr: "", error: null };
    if (args.includes("get") && args.at(-1) === "title") return { ok: true, status: 0, stdout: "Dashboard", stderr: "", error: null };
    if (args.includes("snapshot")) return { ok: true, status: 0, stdout: '@e1 heading "Dashboard"', stderr: "", error: null };
    return { ok: true, status: 0, stdout: command || "ok", stderr: "", error: null };
  };
  return { runner, calls };
}

test("expected URL parsing and glob matching", () => {
  const patterns = parseExpectedUrls("**/dashboard, **/auth/reset-password");
  assert.deepEqual(patterns, ["**/dashboard", "**/auth/reset-password"]);
  assert.equal(urlMatchesAny("http://localhost:3000/dashboard", patterns), true);
  assert.equal(urlMatchesAny("http://localhost:3000/login", patterns), false);
});

test("browser dispatch can start an explicit headed session", async () => {
  const p = projectWithBrowserDispatch();
  const dispatched = await dispatchProject(p, "C001");
  assert.equal(dispatched.dispatch.status, "manual");
  const { runner, calls } = runnerFactory();
  const outcome = startBrowserDispatch(p, dispatched.dispatch.id, { url: "http://localhost:3000/login", headed: true, runner, resolved: "agent-browser" });
  assert.equal(outcome.dispatch.status, "active");
  assert.equal(outcome.dispatch.browser.headed, true);
  assert.equal(outcome.dispatch.browser.startedCommit, "a".repeat(40));
  assert.match(outcome.dispatch.browser.initialSnapshotSha256, /^[a-f0-9]{64}$/);
  assert.match(outcome.dispatch.browser.session, /^sumi-demo-d\d{3}$/);
  assert.ok(calls.some((args) => args.includes("open") && args.includes("http://localhost:3000/login")));
});

test("browser check completes and applies scope when expected URL matches", async () => {
  const p = projectWithBrowserDispatch();
  const dispatched = await dispatchProject(p, "C001");
  const { runner } = runnerFactory("http://localhost:3000/dashboard");
  startBrowserDispatch(p, dispatched.dispatch.id, { url: "http://localhost:3000/login", runner, resolved: "agent-browser" });
  const outcome = checkBrowserDispatch(p, dispatched.dispatch.id, { expectUrls: ["**/dashboard"], apply: true, runner, resolved: "agent-browser" });
  assert.equal(outcome.completed, true);
  assert.equal(outcome.dispatch.status, "completed");
  assert.ok(outcome.result.id.startsWith("R"));
  assert.equal(outcome.commit, "a".repeat(40));
  assert.equal(outcome.dispatch.browser.verification.url, "http://localhost:3000/dashboard");
  assert.equal(outcome.dispatch.browser.verification.commit, "a".repeat(40));
  assert.match(outcome.snapshotSha256, /^[a-f0-9]{64}$/);
  assert.match(outcome.result.rawText, /Verified commit: a{40}/);
  assert.match(outcome.result.rawText, /Snapshot SHA-256: [a-f0-9]{64}/);
  assert.equal(p.scope.criteria[0].status, "done");
});

test("browser check keeps session active when expectation does not match", async () => {
  const p = projectWithBrowserDispatch();
  const dispatched = await dispatchProject(p, "C001");
  const { runner } = runnerFactory("http://localhost:3000/login");
  startBrowserDispatch(p, dispatched.dispatch.id, { url: "http://localhost:3000/login", runner, resolved: "agent-browser" });
  const outcome = checkBrowserDispatch(p, dispatched.dispatch.id, { expectUrls: ["**/dashboard"], apply: true, runner, resolved: "agent-browser" });
  assert.equal(outcome.completed, false);
  assert.equal(outcome.dispatch.status, "active");
  assert.equal(p.scope.criteria[0].status, "todo");
});

test("browser check refuses completion when the project commit is unavailable", async () => {
  const p = projectWithBrowserDispatch();
  p.deployment.commit = null;
  const dispatched = await dispatchProject(p, "C001");
  const { runner } = runnerFactory();
  startBrowserDispatch(p, dispatched.dispatch.id, { url: "http://localhost:3000/login", runner, resolved: "agent-browser" });
  assert.throws(
    () => checkBrowserDispatch(p, dispatched.dispatch.id, { expectUrls: ["**/dashboard"], apply: true, runner, resolved: "agent-browser" }),
    /Project commit is unavailable/
  );
  assert.equal(p.scope.criteria[0].status, "todo");
});

test("browser check refuses evidence when the project commit changed after start", async () => {
  const p = projectWithBrowserDispatch();
  const dispatched = await dispatchProject(p, "C001");
  const { runner } = runnerFactory();
  startBrowserDispatch(p, dispatched.dispatch.id, { url: "http://localhost:3000/login", runner, resolved: "agent-browser" });
  p.deployment.commit = "b".repeat(40);
  assert.throws(
    () => checkBrowserDispatch(p, dispatched.dispatch.id, { expectUrls: ["**/dashboard"], apply: true, runner, resolved: "agent-browser" }),
    /Project commit changed during browser verification/
  );
  assert.equal(p.scope.criteria[0].status, "todo");
});

test("browser check requires a successful snapshot before recording evidence", async () => {
  const p = projectWithBrowserDispatch();
  const dispatched = await dispatchProject(p, "C001");
  const base = runnerFactory();
  let snapshots = 0;
  const runner = (input) => {
    if (input.args.includes("snapshot") && ++snapshots > 1) {
      return { ok: false, status: 1, stdout: "", stderr: "snapshot failed", error: null };
    }
    return base.runner(input);
  };
  startBrowserDispatch(p, dispatched.dispatch.id, { url: "http://localhost:3000/login", runner, resolved: "agent-browser" });
  assert.throws(
    () => checkBrowserDispatch(p, dispatched.dispatch.id, { expectUrls: ["**/dashboard"], apply: true, runner, resolved: "agent-browser" }),
    /agent-browser snapshot failed/
  );
  assert.equal(p.scope.criteria[0].status, "todo");
});

test("browser close returns active manual dispatch to manual", async () => {
  const p = projectWithBrowserDispatch();
  const dispatched = await dispatchProject(p, "C001");
  const { runner } = runnerFactory();
  startBrowserDispatch(p, dispatched.dispatch.id, { url: "http://localhost:3000/login", runner, resolved: "agent-browser" });
  const outcome = closeBrowserDispatch(p, dispatched.dispatch.id, { runner, resolved: "agent-browser" });
  assert.equal(outcome.dispatch.status, "manual");
  assert.equal(outcome.dispatch.browser.closed, true);
});
