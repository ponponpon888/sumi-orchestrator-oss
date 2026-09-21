import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createEmptyState, ensureProjectShape } from "./domain.js";

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_STALE_LOCK_MS = 10 * 60_000;
const LOCK_RETRY_MS = 50;
export const CURRENT_SCHEMA_VERSION = 3;

class UnsupportedSchemaError extends Error {
  constructor(message) {
    super(message);
    this.code = "SUMI_UNSUPPORTED_SCHEMA";
  }
}

export function defaultDataPath() {
  return process.env.SUMI_DATA || path.join(os.homedir(), ".sumi", "state.json");
}

function migrateV1ToV2(state) {
  return { ...state, schemaVersion: 2, revision: 0 };
}

function migrateV2ToV3(state) {
  // v3 adds the cross-project pattern ledger. Per-project findings are filled
  // in by ensureProjectShape, so the migration only has to open the top level.
  return { ...state, schemaVersion: 3, patterns: Array.isArray(state.patterns) ? state.patterns : [] };
}

const migrations = new Map([[1, migrateV1ToV2], [2, migrateV2ToV3]]);

function migrateState(state, filePath) {
  const sourceVersion = state?.schemaVersion;
  if (!Number.isInteger(sourceVersion) || sourceVersion < 1) {
    throw new Error(`Unsupported or invalid SUMI state: ${filePath}`);
  }
  if (sourceVersion > CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedSchemaError(`SUMI state schema ${sourceVersion} is newer than supported schema ${CURRENT_SCHEMA_VERSION}: ${filePath}`);
  }
  let migrated = state;
  while (migrated.schemaVersion < CURRENT_SCHEMA_VERSION) {
    const migrate = migrations.get(migrated.schemaVersion);
    if (!migrate) throw new Error(`No SUMI state migration from schema ${migrated.schemaVersion}: ${filePath}`);
    migrated = migrate(migrated);
  }
  if (sourceVersion !== migrated.schemaVersion) {
    Object.defineProperty(migrated, "migratedFrom", { value: sourceVersion, enumerable: false });
  }
  return migrated;
}

function parseState(raw, filePath) {
  const state = migrateState(JSON.parse(raw), filePath);
  if (!state.projects || typeof state.projects !== "object" || Array.isArray(state.projects) || !Number.isInteger(state.revision) || state.revision < 0) {
    throw new Error(`Unsupported or invalid SUMI state: ${filePath}`);
  }
  if (!Array.isArray(state.patterns)) state.patterns = [];
  for (const project of Object.values(state.projects)) ensureProjectShape(project);
  return state;
}

export function loadState(filePath = defaultDataPath()) {
  if (!fs.existsSync(filePath)) return createEmptyState();
  try {
    return parseState(fs.readFileSync(filePath, "utf8"), filePath);
  } catch (primaryError) {
    if (primaryError.code === "SUMI_UNSUPPORTED_SCHEMA") throw primaryError;
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
  if (state.schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedSchemaError(`Refusing to overwrite SUMI state schema ${state.schemaVersion}; supported schema is ${CURRENT_SCHEMA_VERSION}: ${filePath}`);
  }
  state.schemaVersion = CURRENT_SCHEMA_VERSION;
  state.revision = (Number.isInteger(state.revision) ? state.revision : 0) + 1;
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
