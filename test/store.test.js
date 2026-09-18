import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireStateLock, CURRENT_SCHEMA_VERSION, loadState, saveState } from "../src/store.js";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "state.json");
}

function state(summary) {
  return { schemaVersion: 1, updatedAt: "old", projects: { demo: { summary } } };
}

test("loadState migrates schema v1 to the current schema in memory", (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, JSON.stringify(state("legacy")), "utf8");
  const migrated = loadState(file);
  assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(migrated.revision, 0);
  assert.equal(migrated.migratedFrom, 1);
  assert.equal(JSON.stringify(migrated).includes("migratedFrom"), false);
});

test("saving a migrated state preserves schema v1 as the backup", (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, JSON.stringify(state("legacy")), "utf8");
  const migrated = loadState(file);
  saveState(migrated, file);
  assert.equal(loadState(file).schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(loadState(file).revision, 1);
  assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8")).schemaVersion, 1);
});

test("loadState refuses a future schema instead of rolling back to a backup", (t) => {
  const file = fixture(t);
  saveState(state("backup"), file);
  saveState(state("current"), file);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION + 1, revision: 1, projects: {} }), "utf8");
  assert.throws(() => loadState(file), /newer than supported schema/);
});

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
