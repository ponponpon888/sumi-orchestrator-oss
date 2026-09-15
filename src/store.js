import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmptyState, ensureProjectShape } from "./domain.js";

export function defaultDataPath() {
  return process.env.SUMI_DATA || path.join(os.homedir(), ".sumi", "state.json");
}

export function loadState(filePath = defaultDataPath()) {
  if (!fs.existsSync(filePath)) return createEmptyState();
  const raw = fs.readFileSync(filePath, "utf8");
  const state = JSON.parse(raw);
  if (state.schemaVersion !== 1 || typeof state.projects !== "object") {
    throw new Error(`Unsupported or invalid SUMI state: ${filePath}`);
  }
  for (const project of Object.values(state.projects)) ensureProjectShape(project);
  return state;
}

export function saveState(state, filePath = defaultDataPath()) {
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2) + "\n", "utf8");
  fs.renameSync(tempPath, filePath);
}

export function appendAudit(entry, filePath = defaultDataPath()) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const auditPath = path.join(dir, "audit.jsonl");
  fs.appendFileSync(auditPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf8");
}
