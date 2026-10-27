import fs from "node:fs";
import path from "node:path";
import { GIT_LOCATION_VARS, runCommand } from "./sync.js";

/**
 * GitHub-source projects.
 *
 * When the code lives on GitHub and a local clone is stale or absent, SUMI
 * keeps its own read-only mirror of the default branch and observes and
 * sweeps that instead. The mirror belongs to SUMI: it is created by SUMI,
 * marked as such, and reset to the remote head on every refresh.
 *
 * Resetting is destructive, so every git command against the mirror is
 * pinned to it:
 * - `--git-dir` / `--work-tree` name the mirror explicitly, and inherited
 *   GIT_* variables (GIT_DIR, GIT_INDEX_FILE, ... set inside hooks and
 *   `rebase --exec`) are dropped, so nothing can redirect git elsewhere;
 * - GIT_CEILING_DIRECTORIES stops git from walking up into a repository that
 *   contains the state directory when the mirror's own .git is damaged;
 * - before any reset, git must confirm that the repository it is about to
 *   touch is exactly the mirror's .git.
 * SUMI never resets a directory it did not create, so a user's own clone can
 * never be overwritten by pointing the mirror at it.
 */

export const SOURCE_KINDS = new Set(["local", "github"]);
export const MIRROR_MARKER = "sumi-mirror.json";

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// A sweep's evidence is bound to a commit, so the mirror must hold that
// commit's bytes. A user's global core.autocrlf=true (the Windows default)
// would otherwise check files out with CRLF that the commit does not contain.
const BYTE_EXACT = Object.freeze(["core.autocrlf=false", "core.eol=lf"]);
const BRANCH = /^[A-Za-z0-9._\/-]+$/;

export function isGithubSource(project) {
  return project?.source === "github";
}

export function mirrorPathFor(dataPath, projectId) {
  return path.join(path.dirname(path.resolve(dataPath)), "mirrors", projectId);
}

export function mirrorUrlFor(repo) {
  return `https://github.com/${repo}.git`;
}

function real(p) {
  // Resolve symlinks for the part of the path that exists, so a symlinked
  // directory cannot make two overlapping paths look separate.
  let current = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    rest.unshift(path.basename(current));
    current = parent;
  }
  let base = current;
  try { base = fs.realpathSync.native(current); } catch { /* keep the resolved path */ }
  return path.join(base, ...rest);
}

function normalizeCase(p) {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

function isInside(parent, child) {
  const rel = path.relative(normalizeCase(real(parent)), normalizeCase(real(child)));
  return rel === "" || !(rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

function overlaps(a, b) {
  return isInside(a, b) || isInside(b, a);
}

/** Only a GitHub URL, or (for tests and self-hosted mirrors) an absolute path / file URL. */
function validUrl(url) {
  const text = String(url || "");
  if (!text || text.startsWith("-")) return false;
  return /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\.git)?$/.test(text)
    || /^file:\/\//.test(text)
    || path.isAbsolute(text);
}

/**
 * Point a project at GitHub. The mirror path is derived from the state
 * file's directory, never taken from the user, and may not overlap the
 * project's local clone in either direction.
 */
export function setProjectSource(project, source, { dataPath }) {
  if (!SOURCE_KINDS.has(source)) throw new Error(`Invalid source: ${source}. Use one of ${[...SOURCE_KINDS].join(", ")}.`);
  if (source === "local") {
    project.source = "local";
    return project;
  }
  if (!REPO.test(String(project.repo || ""))) {
    throw new Error("A GitHub-source project needs --repo owner/name.");
  }
  const mirrorPath = mirrorPathFor(dataPath, project.id);
  if (project.local && overlaps(project.local, mirrorPath)) {
    throw new Error(`The mirror path ${mirrorPath} overlaps the local clone ${project.local}; SUMI will not manage a mirror there.`);
  }
  project.source = "github";
  project.mirror = { path: mirrorPath, url: mirrorUrlFor(project.repo) };
  return project;
}

function isolatedEnv(mirrorPath) {
  return {
    // Only the variables that point git at a repository are dropped; the
    // user's credentials, CA bundle, askpass and ssh settings still apply.
    dropEnv: GIT_LOCATION_VARS,
    envDefaults: {
      // Unless the user chose their own ssh command, ssh may not prompt.
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes"
    },
    env: {
      // Never wait for a credential prompt: an unattended sweep must fail, not hang.
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      // Do not walk up from the mirror into an enclosing repository.
      GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(mirrorPath))
    }
  };
}

function gitPlain(run, mirrorPath, args, timeout = 120000) {
  return run("git", args, { timeout, ...isolatedEnv(mirrorPath) });
}

function gitIn(run, mirrorPath, args, timeout = 120000) {
  const gitDir = path.join(mirrorPath, ".git");
  return run("git", [`--git-dir=${gitDir}`, `--work-tree=${mirrorPath}`, ...args], { timeout, ...isolatedEnv(mirrorPath) });
}

export function parseRemoteHead(text) {
  const match = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(String(text || ""));
  return match && BRANCH.test(match[1]) && !match[1].startsWith("-") ? match[1] : null;
}

function readMarker(mirrorPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(mirrorPath, ".git", MIRROR_MARKER), "utf8"));
  } catch {
    return null;
  }
}

function failure(reason) {
  return { ok: false, reason };
}

/**
 * Before anything destructive: the directory must be a real directory (not
 * a symlink), its .git a real directory, and git must agree that the
 * repository it would operate on is exactly that .git.
 */
function verifyMirrorRepository(run, mirrorPath) {
  const gitDir = path.join(mirrorPath, ".git");
  try {
    if (fs.lstatSync(mirrorPath).isSymbolicLink()) return failure(`${mirrorPath} is a symlink; refusing to reset it`);
    const stat = fs.lstatSync(gitDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return failure(`${gitDir} is not a directory; refusing to reset it`);
  } catch {
    return failure(`${gitDir} is missing; the mirror is damaged. Delete ${mirrorPath} and sync again`);
  }
  const probe = gitIn(run, mirrorPath, ["rev-parse", "--absolute-git-dir"]);
  if (!probe.ok || !probe.stdout) {
    return failure(`the mirror's repository is damaged (${probe.stderr || probe.error || "rev-parse failed"}). Delete ${mirrorPath} and sync again`);
  }
  if (normalizeCase(real(probe.stdout)) !== normalizeCase(real(gitDir))) {
    return failure(`git resolved ${probe.stdout} instead of the mirror's ${gitDir}; refusing to reset it`);
  }
  return { ok: true };
}

function readHead(run, mirrorPath) {
  const commit = gitIn(run, mirrorPath, ["rev-parse", "HEAD"]);
  if (!commit.ok || !/^[0-9a-f]{40}$/i.test(commit.stdout || "")) return null;
  return commit.stdout;
}

/**
 * Bring the mirror to the remote default branch head. Returns the branch and
 * the exact commit it now holds, or a reason it could not. A failed refresh
 * is a failure, never a fallback to whatever the mirror held before: an
 * answer about yesterday's code is not an answer about the latest.
 */
export function refreshMirror(project, { run = runCommand } = {}) {
  if (!isGithubSource(project)) return failure("project is not GitHub-source");
  const mirror = project.mirror || {};
  if (!mirror.path) return failure("no mirror path is recorded; run `sumi project set <id> --source github` again");
  if (!REPO.test(String(project.repo || ""))) return failure(`invalid repository: ${project.repo}`);
  const url = mirror.url || mirrorUrlFor(project.repo);
  if (!validUrl(url)) return failure(`refusing mirror URL ${url}`);
  if (project.local && overlaps(project.local, mirror.path)) {
    return failure(`mirror path ${mirror.path} overlaps the local clone ${project.local}`);
  }

  const head = gitPlain(run, mirror.path, ["ls-remote", "--symref", "--", url, "HEAD"], 60000);
  const branch = head.ok ? parseRemoteHead(head.stdout) : null;
  if (!branch) return failure(`cannot read the default branch of ${project.repo}: ${head.stderr || head.error || "no HEAD ref"}`);

  const exists = fs.existsSync(mirror.path);
  const empty = exists && fs.lstatSync(mirror.path).isDirectory() && fs.readdirSync(mirror.path).length === 0;
  if (!exists || empty) {
    fs.mkdirSync(path.dirname(mirror.path), { recursive: true });
    const clone = gitPlain(run, mirror.path, ["clone", "--quiet", "--depth", "1", "--no-tags", "--single-branch", ...BYTE_EXACT.flatMap((setting) => ["--config", setting]), "--branch", branch, "--", url, mirror.path], 600000);
    if (!clone.ok) {
      // Leave nothing half-made behind for the next refresh to trip over.
      if (!exists) fs.rmSync(mirror.path, { recursive: true, force: true });
      return failure(`clone of ${project.repo} failed: ${clone.stderr || clone.error || "unknown error"}`);
    }
    const verified = verifyMirrorRepository(run, mirror.path);
    if (!verified.ok) return verified;
    fs.writeFileSync(path.join(mirror.path, ".git", MIRROR_MARKER), `${JSON.stringify({ project: project.id, repo: project.repo, url }, null, 2)}\n`, "utf8");
  } else {
    const marker = readMarker(mirror.path);
    if (!marker) return failure(`${mirror.path} exists but was not created by SUMI; refusing to reset it`);
    if (marker.project !== project.id || marker.repo !== project.repo) {
      return failure(`${mirror.path} is SUMI's mirror of ${marker.project} (${marker.repo}), not ${project.id} (${project.repo}); refusing to reset it. If the repository was renamed or replaced, delete that folder and sync again`);
    }
    const verified = verifyMirrorRepository(run, mirror.path);
    if (!verified.ok) return verified;
    const fetch = gitIn(run, mirror.path, ["fetch", "--quiet", "--depth", "1", "--no-tags", "--", url, `+refs/heads/${branch}:refs/remotes/origin/${branch}`], 300000);
    if (!fetch.ok) return failure(`fetch of ${project.repo} failed: ${fetch.stderr || fetch.error || "unknown error"}`);
    const target = gitIn(run, mirror.path, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}^{commit}`]);
    if (!target.ok || !/^[0-9a-f]{40}$/i.test(target.stdout || "")) return failure(`fetched ${branch} but cannot resolve it in the mirror`);
    const reset = resetMirrorTo(run, mirror.path, target.stdout);
    if (!reset.ok) return reset;
  }

  const commit = readHead(run, mirror.path);
  if (!commit) return failure("cannot read the mirror's HEAD commit");
  const subject = gitIn(run, mirror.path, ["log", "-1", "--pretty=%s"]);
  return { ok: true, path: mirror.path, branch, commit, subject: subject.ok ? subject.stdout || null : null };
}

function resetMirrorTo(run, mirrorPath, commit) {
  // Re-assert on every reset: a mirror made before this rule, or one whose
  // config was edited, must still check out exact bytes.
  for (const setting of BYTE_EXACT) {
    const [key, value] = setting.split("=");
    const configured = gitIn(run, mirrorPath, ["config", key, value]);
    if (!configured.ok) return failure(`cannot configure the mirror (${key}): ${configured.stderr || configured.error}`);
  }
  const checkout = gitIn(run, mirrorPath, ["checkout", "--quiet", "--force", "--detach", commit]);
  if (!checkout.ok) return failure(`cannot check out ${commit.slice(0, 12)} in the mirror: ${checkout.stderr || checkout.error}`);
  // The mirror is SUMI's and must equal the remote: nothing else may be in it.
  const clean = gitIn(run, mirrorPath, ["clean", "-ffdxq"]);
  if (!clean.ok) return failure(`cannot clean the mirror: ${clean.stderr || clean.error}`);
  return { ok: true };
}

/**
 * Put the mirror back at a commit it already holds, without the network:
 * used between patterns of one sweep, so a check that rewrites a tracked
 * file cannot change what the next check sees.
 */
export function restoreMirror(project, commit, { run = runCommand } = {}) {
  const mirrorPath = project?.mirror?.path;
  if (!mirrorPath) return failure("no mirror path is recorded");
  const marker = readMarker(mirrorPath);
  if (!marker || marker.project !== project.id || marker.repo !== project.repo) {
    return failure(`${mirrorPath} is not SUMI's mirror of ${project.id}; refusing to reset it`);
  }
  const verified = verifyMirrorRepository(run, mirrorPath);
  if (!verified.ok) return verified;
  const reset = resetMirrorTo(run, mirrorPath, commit);
  if (!reset.ok) return reset;
  const head = readHead(run, mirrorPath);
  return head === commit ? { ok: true, path: mirrorPath, commit } : failure("the mirror did not return to the swept commit");
}
