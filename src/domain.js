export const TASK_STATUSES = new Set(["todo", "doing", "blocked", "done", "cancelled"]);
export const DEPLOY_STATUSES = new Set(["unknown", "pending", "ready", "failed", "cancelled", "verified"]);
export const PROJECT_PRIORITY_MIN = 1;
export const PROJECT_PRIORITY_MAX = 5;

export function normalizeProjectPriority(value, fallback = 3) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < PROJECT_PRIORITY_MIN || parsed > PROJECT_PRIORITY_MAX) {
    throw new Error(`Project priority must be an integer between ${PROJECT_PRIORITY_MIN} and ${PROJECT_PRIORITY_MAX}.`);
  }
  return parsed;
}

export function createEmptyState() {
  return {
    schemaVersion: 2,
    revision: 0,
    updatedAt: new Date().toISOString(),
    projects: {}
  };
}

export function createProject({ id, name, repo = null, local = null, vercel = null, supabase = null, priority = 3 }) {
  if (!id || !/^[a-z0-9][a-z0-9-_]*$/.test(id)) {
    throw new Error("Project id must use lowercase letters, numbers, '-' or '_'.");
  }
  if (!name) throw new Error("Project name is required.");
  const now = new Date().toISOString();
  return {
    id,
    name,
    repo,
    local,
    vercel,
    supabase,
    lifecycle: "active",
    priority: normalizeProjectPriority(priority),
    summary: "",
    scope: {
      title: "Project completion",
      criteria: []
    },
    tasks: [],
    decisions: [],
    nextActions: [],
    agentResults: [],
    sessions: [],
    releases: [],
    deployment: {
      branch: null,
      commit: null,
      pr: null,
      ci: "unknown",
      preview: "unknown",
      production: "unknown",
      productionCheckedAt: null
    },
    createdAt: now,
    updatedAt: now
  };
}

export function ensureProjectShape(project) {
  if (!project.scope || typeof project.scope !== "object") {
    project.scope = { title: "Project completion", criteria: [] };
  }
  if (!Array.isArray(project.scope.criteria)) project.scope.criteria = [];
  if (!project.scope.title) project.scope.title = "Project completion";
  if (!Array.isArray(project.tasks)) project.tasks = [];
  if (!Array.isArray(project.decisions)) project.decisions = [];
  if (!Array.isArray(project.nextActions)) project.nextActions = [];
  if (!Array.isArray(project.agentResults)) project.agentResults = [];
  if (!Array.isArray(project.sessions)) project.sessions = [];
  if (!Array.isArray(project.releases)) project.releases = [];
  project.priority = normalizeProjectPriority(project.priority, 3);
  return project;
}

export function setProjectPriority(project, priority) {
  project.priority = normalizeProjectPriority(priority);
  touch(project);
  return project.priority;
}

export function addScopeCriterion(project, text, status = "todo") {
  ensureProjectShape(project);
  if (!text) throw new Error("Scope criterion text is required.");
  if (!TASK_STATUSES.has(status)) throw new Error(`Invalid scope status: ${status}`);
  const seq = project.scope.criteria.reduce((max, item) => Math.max(max, Number(item.seq) || 0), 0) + 1;
  const item = {
    id: `C${String(seq).padStart(3, "0")}`,
    seq,
    text,
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  project.scope.criteria.push(item);
  touch(project);
  return item;
}

export function setScopeCriterionStatus(project, criterionId, status) {
  ensureProjectShape(project);
  if (!TASK_STATUSES.has(status)) throw new Error(`Invalid scope status: ${status}`);
  const item = project.scope.criteria.find((c) => c.id === criterionId);
  if (!item) throw new Error(`Scope criterion not found: ${criterionId}`);
  item.status = status;
  const now = new Date().toISOString();
  if (["done", "cancelled"].includes(status)) {
    delete item.claim;
    for (const session of project.sessions || []) {
      if (session.scopeId === item.id && session.status === "active") {
        session.status = status === "done" ? "completed" : "abandoned";
        session.endedAt = now;
        session.claimReleased = true;
      }
    }
  }
  item.updatedAt = now;
  touch(project);
  return item;
}

export function setScopeTitle(project, title) {
  ensureProjectShape(project);
  if (!title) throw new Error("Scope title is required.");
  project.scope.title = title;
  touch(project);
}

export function getScopeProgress(project) {
  ensureProjectShape(project);
  const counted = project.scope.criteria.filter((item) => item.status !== "cancelled");
  if (counted.length === 0) return { done: 0, total: 0, percent: null };
  const done = counted.filter((item) => item.status === "done").length;
  return { done, total: counted.length, percent: Math.round((done / counted.length) * 100) };
}

export function addTask(project, title, status = "todo") {
  if (!title) throw new Error("Task title is required.");
  if (!TASK_STATUSES.has(status)) throw new Error(`Invalid task status: ${status}`);
  const seq = project.tasks.reduce((max, t) => Math.max(max, Number(t.seq) || 0), 0) + 1;
  const task = {
    id: `T${String(seq).padStart(3, "0")}`,
    seq,
    title,
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  project.tasks.push(task);
  touch(project);
  return task;
}

export function setTaskStatus(project, taskId, status) {
  if (!TASK_STATUSES.has(status)) throw new Error(`Invalid task status: ${status}`);
  const task = project.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  task.status = status;
  task.updatedAt = new Date().toISOString();
  touch(project);
  return task;
}

export function addDecision(project, text, reason = "") {
  if (!text) throw new Error("Decision text is required.");
  const decision = {
    id: `D${String(project.decisions.length + 1).padStart(3, "0")}`,
    text,
    reason,
    createdAt: new Date().toISOString()
  };
  project.decisions.push(decision);
  touch(project);
  return decision;
}

export function addNextAction(project, text) {
  if (!text) throw new Error("Next action text is required.");
  const item = {
    id: `N${String(project.nextActions.length + 1).padStart(3, "0")}`,
    text,
    done: false,
    createdAt: new Date().toISOString()
  };
  project.nextActions.push(item);
  touch(project);
  return item;
}

export function setDeployment(project, patch) {
  for (const key of ["ci", "preview", "production"]) {
    if (patch[key] !== undefined && !DEPLOY_STATUSES.has(patch[key])) {
      throw new Error(`Invalid deployment status for ${key}: ${patch[key]}`);
    }
  }
  Object.assign(project.deployment, patch);
  if (patch.production === "verified") {
    project.deployment.productionCheckedAt = new Date().toISOString();
  }
  touch(project);
}

export function getProjectProgress(project) {
  ensureProjectShape(project);
  const scope = getScopeProgress(project);
  if (scope.total > 0) return { ...scope, basis: "scope" };
  // Whole-project progress requires an explicit Definition of Done. Managed tasks
  // may represent only a slice of the product, so they must not become the
  // denominator for the project percentage.
  return { done: 0, total: 0, percent: null, basis: "none" };
}

export function getCompletion(project) {
  ensureProjectShape(project);
  const progress = getProjectProgress(project);
  const blockers = project.tasks.filter((t) => t.status === "blocked");
  const current = project.tasks.filter((t) => t.status === "doing");
  const todos = project.tasks.filter((t) => t.status === "todo");
  const implementationDone = progress.total > 0 && progress.done === progress.total;
  const productionVerified = project.deployment.production === "verified";
  return {
    ...progress,
    implementationDone,
    productionVerified,
    complete: implementationDone && productionVerified,
    blockers,
    current,
    todos
  };
}

export const SERVICE_UNUSED = "none";
export const PROJECT_STATES = {
  DONE: "DONE",
  IMPLEMENTED: "IMPLEMENTED / PROD UNVERIFIED",
  IN_DEVELOPMENT: "IN DEVELOPMENT",
  UNSCOPED: "UNSCOPED"
};

/**
 * Distinguish an unregistered external service from one that is deliberately
 * not used. `null`/empty means "never registered"; the explicit SERVICE_UNUSED
 * sentinel means the project does not use that service at all.
 */
export function getServiceState(project, service) {
  const raw = project?.[service];
  const value = typeof raw === "string" ? raw.trim() : raw;
  if (value === SERVICE_UNUSED) return { state: "unused", name: null };
  if (value) return { state: "registered", name: String(value) };
  return { state: "unregistered", name: null };
}

export function isServiceRegistered(project, service) {
  return getServiceState(project, service).state === "registered";
}

/**
 * True when SUMI has any way to observe Production: a registered Vercel
 * project, a locally linked one, or a deployment status already recorded by
 * sync or `deploy set`.
 */
export function isProductionObservable(project) {
  if (isServiceRegistered(project, "vercel")) return true;
  if (project?.observations?.vercel?.linked) return true;
  const production = project?.deployment?.production;
  return Boolean(production) && production !== "unknown";
}

export function getProjectStateLabel(project) {
  const completion = getCompletion(project);
  if (completion.complete) return PROJECT_STATES.DONE;
  if (completion.implementationDone) return PROJECT_STATES.IMPLEMENTED;
  // A project without any countable completion criterion cannot be called "in
  // development"; its Definition of Done has simply never been declared.
  if (completion.total === 0) return PROJECT_STATES.UNSCOPED;
  return PROJECT_STATES.IN_DEVELOPMENT;
}

/**
 * Configuration gaps that stop SUMI from judging or progressing a project.
 * Each gap carries the exact CLI command that closes it. A missing Supabase
 * registration is deliberately not a gap: it never gates queue work.
 */
export function getSetupGaps(project) {
  ensureProjectShape(project);
  const gaps = [];
  if (getScopeProgress(project).total === 0) {
    gaps.push({
      key: "scope",
      title: "完了条件(Scope)が未定義",
      commands: [
        `sumi scope suggest ${project.id}`,
        `sumi scope add ${project.id} "<完了条件>"`
      ]
    });
  }
  if (getServiceState(project, "vercel").state === "unregistered" && !project?.observations?.vercel?.linked) {
    gaps.push({
      key: "vercel",
      title: "Vercel連携が未登録",
      commands: [
        `sumi project set ${project.id} --vercel <vercel-project-name>`,
        `sumi project set ${project.id} --vercel ${SERVICE_UNUSED}   # Vercelを使わない場合`
      ]
    });
  }
  return gaps;
}

export function touch(project) {
  project.updatedAt = new Date().toISOString();
}
