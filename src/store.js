import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createEmptyState, ensureProjectShape } from "./domain.js";

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_STALE_LOCK_MS = 10 * 60_000;
const LOCK_RETRY_MS = 50;

export function defaultDataPath() {
  return process.env.SUMI_DATA || path.join(os.homedir(), ".sumi", "state.json");
}

function parseState(raw, filePath) {
  const state = JSON.parse(raw);
  if (state.schemaVersion !== 1 || !state.projects || typeof state.projects !== "object" || Array.isArray(state.projects)) {
    throw new Error(`Unsupported or invalid SUMI state: ${filePath}`);
  }
  for (const project of Object.values(state.projects)) ensureProjectShape(project);
  return state;
}

export function loadState(filePath = defaultDataPath()) {
  if (!fs.existsSync(filePath)) return createEmptyState();
  try {
    return parseState(fs.readFileSync(filePath, "utf8"), filePath);
  } catch (primaryError) {
    const backupPath = `${filePath}.bak`;
    if (!fs.existsSync(backupPath)) throw primaryError;
    try {
      const state = parseState(fs.readFileSync(backupPath, "utf8"), backupPath);
      Object.defineProperty(state, "recoveredFrom", { value: backupPath, enumerable: false });
      return state;
    } catch (backupError) {
      throw new Error(`Unable to load SUMI state or backup: ${filePath} (${primaryError.message}); ${backupPath} (${backupError.message})`);
    }
  }
}

function writeDurably(filePath, content) {
  const handle = fs.openSync(filePath, "wx");
  try {
    fs.writeFileSync(handle, content, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

export function saveState(state, filePath = defaultDataPath()) {
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeDurably(tempPath, JSON.stringify(state, null, 2) + "\n");
    if (fs.existsSync(filePath)) {
      try {
        parseState(fs.readFileSync(filePath, "utf8"), filePath);
        fs.copyFileSync(filePath, `${filePath}.bak`);
      } catch {
        // Never replace a known-good backup with a corrupt primary state.
      }
    }
    fs.renameSync(tempPath, filePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function lockAgeMs(lockPath) {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch {
    return 0;
  }
}

function wait(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function acquireStateLock(filePath = defaultDataPath(), {
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  staleMs = DEFAULT_STALE_LOCK_MS,
  retryMs = LOCK_RETRY_MS
} = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();

  while (true) {
    try {
      const handle = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(handle, JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }) + "\n", "utf8");
        fs.fsyncSync(handle);
      } catch (error) {
        fs.rmSync(lockPath, { force: true });
        throw error;
      } finally {
        fs.closeSync(handle);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          const owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
          if (owner.token === token) fs.rmSync(lockPath, { force: true });
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (lockAgeMs(lockPath) > staleMs) {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for SUMI state lock: ${lockPath}`);
      }
      wait(Math.min(retryMs, Math.max(1, deadline - Date.now())));
    }
  }
}

export function appendAudit(entry, filePath = defaultDataPath()) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const auditPath = path.join(dir, "audit.jsonl");
  fs.appendFileSync(auditPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf8");
}
