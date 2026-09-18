import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireStateLock, loadState, saveState } from "../src/store.js";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "state.json");
}

function state(summary) {
  return { schemaVersion: 1, updatedAt: "old", projects: { demo: { summary } } };
}

test("saveState preserves the previous valid state as a backup", (t) => {
  const file = fixture(t);
  saveState(state("first"), file);
  saveState(state("second"), file);
  assert.equal(loadState(file).projects.demo.summary, "second");
  assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8")).projects.demo.summary, "first");
});

test("loadState recovers from a corrupt primary using its backup", (t) => {
  const file = fixture(t);
  saveState(state("recoverable"), file);
  saveState(state("current"), file);
  fs.writeFileSync(file, "{broken", "utf8");
  const recovered = loadState(file);
  assert.equal(recovered.projects.demo.summary, "recoverable");
  assert.equal(recovered.recoveredFrom, `${file}.bak`);
  assert.equal(JSON.stringify(recovered).includes("recoveredFrom"), false);
});

test("saveState does not overwrite a good backup when the primary is corrupt", (t) => {
  const file = fixture(t);
  saveState(state("good-backup"), file);
  saveState(state("soon-corrupt"), file);
  fs.writeFileSync(file, "{broken", "utf8");
  saveState(state("repaired"), file);
  assert.equal(loadState(file).projects.demo.summary, "repaired");
  assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8")).projects.demo.summary, "good-backup");
});

test("state lock is exclusive and can be reacquired after release", (t) => {
  const file = fixture(t);
  const release = acquireStateLock(file);
  assert.throws(
    () => acquireStateLock(file, { timeoutMs: 10, retryMs: 2 }),
    /Timed out waiting for SUMI state lock/
  );
  release();
  const releaseAgain = acquireStateLock(file, { timeoutMs: 10 });
  releaseAgain();
});

test("state lock removes an expired lock left by a terminated process", (t) => {
  const file = fixture(t);
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(lock, "stale", "utf8");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  const release = acquireStateLock(file, { timeoutMs: 10, staleMs: 1_000 });
  release();
  assert.equal(fs.existsSync(lock), false);
});

test("an old release callback cannot remove a replacement lock", (t) => {
  const file = fixture(t);
  const releaseOld = acquireStateLock(file);
  const lock = `${file}.lock`;
  fs.rmSync(lock);
  const releaseCurrent = acquireStateLock(file);
  releaseOld();
  assert.equal(fs.existsSync(lock), true);
  releaseCurrent();
  assert.equal(fs.existsSync(lock), false);
});
