import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createEmptyState, createProject } from "../src/domain.js";
import { addPattern, listFindings } from "../src/findings.js";
import { MIRROR_MARKER, mirrorPathFor, parseRemoteHead, refreshMirror, setProjectSource } from "../src/mirror.js";
import { resolveSweepWorktree, runSweep } from "../src/sweep.js";
import { syncProject } from "../src/sync.js";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A "GitHub" remote: a bare repository fed from a scratch working copy. */
function remote({ branch = "main", files = { "README.md": "# app\n" } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-remote-"));
  const bare = path.join(root, "remote.git");
  const work = path.join(root, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", branch, bare]);
  execFileSync("git", ["init", "-q", "-b", branch, work]);
  git(work, "config", "user.name", "SUMI Test");
  git(work, "config", "user.email", "sumi-test@example.invalid");
  git(work, "config", "core.autocrlf", "false");
  const commit = (changes, message) => {
    for (const [name, content] of Object.entries(changes)) {
      fs.mkdirSync(path.dirname(path.join(work, name)), { recursive: true });
      fs.writeFileSync(path.join(work, name), content, "utf8");
    }
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", message);
    git(work, "push", "-q", bare, `HEAD:refs/heads/${branch}`);
    return git(work, "rev-parse", "HEAD");
  };
  const first = commit(files, "initial");
  return { root, bare, commit, first };
}

function githubProject(origin, { id = "app", local = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-data-"));
  const project = createProject({ id, name: id.toUpperCase(), repo: "owner/app", local });
  setProjectSource(project, "github", { dataPath: path.join(dataDir, "state.json") });
  project.mirror.url = origin.bare; // the test's stand-in for https://github.com/owner/app.git
  return { project, dataDir };
}

test("a GitHub source needs a repo and keeps its mirror next to the state file", () => {
  const p = createProject({ id: "app", name: "APP" });
  assert.throws(() => setProjectSource(p, "github", { dataPath: "/x/state.json" }), /needs --repo owner\/name/);
  p.repo = "owner/app";
  setProjectSource(p, "github", { dataPath: "/x/state.json" });
  assert.equal(p.source, "github");
  assert.equal(p.mirror.path, mirrorPathFor("/x/state.json", "app"));
  assert.equal(p.mirror.url, "https://github.com/owner/app.git");
  assert.throws(() => setProjectSource(p, "svn", { dataPath: "/x/state.json" }), /Invalid source/);
  setProjectSource(p, "local", { dataPath: "/x/state.json" });
  assert.equal(p.source, "local");
});

test("the mirror may not overlap the user's own clone in either direction", () => {
  const dataPath = path.join(os.tmpdir(), "sumi-overlap", "state.json");
  const inside = createProject({ id: "app", name: "APP", repo: "owner/app", local: path.dirname(dataPath) });
  assert.throws(() => setProjectSource(inside, "github", { dataPath }), /overlaps the local clone/);
  const outside = createProject({ id: "app", name: "APP", repo: "owner/app", local: path.join(path.dirname(dataPath), "mirrors", "app", "src") });
  assert.throws(() => setProjectSource(outside, "github", { dataPath }), /overlaps the local clone/);
});

test("parseRemoteHead reads the default branch from ls-remote --symref", () => {
  assert.equal(parseRemoteHead("ref: refs/heads/trunk\tHEAD\n0123abcd\tHEAD\n"), "trunk");
  assert.equal(parseRemoteHead("0123abcd\tHEAD\n"), null);
});

test("refresh clones the default branch, marks the mirror, then follows new commits", () => {
  const origin = remote({ branch: "trunk" });
  const { project } = githubProject(origin);
  const first = refreshMirror(project);
  assert.equal(first.ok, true, first.reason);
  assert.equal(first.branch, "trunk", "the remote's default branch, not an assumed main");
  assert.equal(first.commit, origin.first);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project.mirror.path, ".git", MIRROR_MARKER), "utf8")),
    { project: "app", repo: "owner/app", url: origin.bare });

  const second = origin.commit({ "src/a.ts": "export {};\n" }, "second");
  const next = refreshMirror(project);
  assert.equal(next.ok, true, next.reason);
  assert.equal(next.commit, second);
  assert.equal(next.subject, "second");
});

test("refresh resets the mirror to the remote: edits and stray files do not survive", () => {
  const origin = remote();
  const { project } = githubProject(origin);
  assert.equal(refreshMirror(project).ok, true);
  fs.writeFileSync(path.join(project.mirror.path, "README.md"), "edited\n");
  fs.writeFileSync(path.join(project.mirror.path, "stray.txt"), "x\n");
  fs.writeFileSync(path.join(project.mirror.path, ".env.local"), "SECRET=1\n");
  const again = refreshMirror(project);
  assert.equal(again.ok, true, again.reason);
  assert.equal(fs.readFileSync(path.join(project.mirror.path, "README.md"), "utf8"), "# app\n");
  assert.equal(fs.existsSync(path.join(project.mirror.path, "stray.txt")), false);
  assert.equal(fs.existsSync(path.join(project.mirror.path, ".env.local")), false);
  assert.equal(git(project.mirror.path, "status", "--porcelain"), "");
});

test("refresh never resets a directory SUMI did not create", () => {
  const origin = remote();
  const { project } = githubProject(origin);
  fs.mkdirSync(project.mirror.path, { recursive: true });
  fs.writeFileSync(path.join(project.mirror.path, "mine.txt"), "the user's file\n");
  const result = refreshMirror(project);
  assert.equal(result.ok, false);
  assert.match(result.reason, /was not created by SUMI; refusing to reset it/);
  assert.equal(fs.readFileSync(path.join(project.mirror.path, "mine.txt"), "utf8"), "the user's file\n");

  // A real clone of the same repository, but not SUMI's, is refused too.
  fs.rmSync(project.mirror.path, { recursive: true, force: true });
  execFileSync("git", ["clone", "-q", origin.bare, project.mirror.path]);
  fs.writeFileSync(path.join(project.mirror.path, "wip.txt"), "uncommitted work\n");
  assert.match(refreshMirror(project).reason, /was not created by SUMI/);
  assert.equal(fs.existsSync(path.join(project.mirror.path, "wip.txt")), true);
});

test("refresh refuses a mirror that belongs to another project or repository", () => {
  const origin = remote();
  const { project } = githubProject(origin);
  assert.equal(refreshMirror(project).ok, true);
  project.repo = "owner/other";
  assert.match(refreshMirror(project).reason, /is SUMI's mirror of app \(owner\/app\), not app \(owner\/other\)/);
});

test("an unreachable remote is a failure and leaves no half-made mirror", () => {
  const origin = remote();
  const { project } = githubProject(origin);
  project.mirror.url = path.join(origin.root, "does-not-exist.git");
  const result = refreshMirror(project);
  assert.equal(result.ok, false);
  assert.match(result.reason, /cannot read the default branch/);
  assert.equal(fs.existsSync(project.mirror.path), false);
});

test("sync observes the mirror's commit, and a failed refresh keeps the last known commit", () => {
  const origin = remote();
  const { project } = githubProject(origin);
  syncProject(project, { skipVercel: true, skipSupabase: true, githubApi: () => ({ ok: false, error: "offline" }), githubTextApi: () => ({ ok: false }) });
  assert.equal(project.deployment.commit, origin.first);
  assert.equal(project.deployment.branch, "main");
  assert.equal(project.observations.source.kind, "github");
  assert.equal(project.observations.source.commit, origin.first);
  assert.equal(project.observations.local.dirty, false);

  origin.commit({ "b.ts": "1\n" }, "newer");
  project.mirror.url = path.join(origin.root, "gone.git");
  syncProject(project, { skipVercel: true, skipSupabase: true, githubApi: () => ({ ok: false, error: "offline" }), githubTextApi: () => ({ ok: false }) });
  assert.equal(project.deployment.commit, null, "an unknown current commit is cleared, not left stale for other gates to trust");
  assert.equal(project.observations.source.lastKnownCommit, origin.first);
  assert.match(project.observations.source.error, /cannot read the default branch/);
  assert.ok(project.observations.warnings.some((w) => /GitHub mirror refresh failed/.test(w)));
  assert.equal(project.observations.local.available, false);
});

test("sweep runs at the remote head of a GitHub source, and errors instead of sweeping a stale mirror", () => {
  const origin = remote({ files: { "src/ok.ts": "export {};\n" } });
  const { project } = githubProject(origin);
  const state = createEmptyState();
  state.projects.app = project;
  addPattern(state, {
    key: "has-leak", title: "t", question: "q?", origin: "record",
    check: { argv: [process.execPath, "-e", "process.exit(require('fs').existsSync('leak.ts') ? 1 : 0)"] }
  });

  assert.equal(runSweep(state, {}).rows[0].outcome, "clean");
  const leaked = origin.commit({ "leak.ts": "x\n" }, "leak");
  const [row] = runSweep(state, {}).rows;
  assert.equal(row.outcome, "reproduced", "the new remote commit is what gets swept");
  assert.equal(row.commit, leaked);
  assert.equal(listFindings(project)[0].confirmations[0].evidence.commit, leaked);

  project.mirror.url = path.join(origin.root, "gone.git");
  const stale = resolveSweepWorktree(project);
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /GitHub mirror refresh failed/);
});

function sweepState(project, patterns) {
  const state = createEmptyState();
  state.projects[project.id] = project;
  for (const [key, script] of patterns) {
    addPattern(state, { key, title: key, question: "q?", origin: "record", check: { argv: [process.execPath, "-e", script] } });
  }
  return state;
}

// Pattern keys are swept in alphabetical order.
const REWRITE_README = "require('fs').writeFileSync('README.md', 'rewritten by a check\\n')";
const README_MUST_BE_ORIGINAL = "process.exit(require('fs').readFileSync('README.md', 'utf8') === '# app\\n' ? 0 : 1)";

test("a GitHub-source sweep fetches once, but every pattern sees the fetched commit untouched", () => {
  const origin = remote();
  const { project } = githubProject(origin);
  const state = sweepState(project, [["a-rewrites", REWRITE_README], ["b-reads", README_MUST_BE_ORIGINAL]]);
  let fetches = 0;
  const { rows } = runSweep(state, { mirrorRefresher: (p) => { fetches++; return refreshMirror(p); } });
  assert.equal(fetches, 1);
  assert.equal(rows[0].outcome, "clean");
  assert.equal(rows[1].outcome, "clean", "the second pattern must not see the first pattern's rewrite");
  assert.equal(rows[1].commit, origin.first);
});

test("a local sweep still refuses a worktree that a previous pattern dirtied", () => {
  const origin = remote();
  const local = path.join(origin.root, "local");
  execFileSync("git", ["clone", "-q", origin.bare, local]);
  const project = createProject({ id: "app", name: "APP", local });
  const state = sweepState(project, [["a-rewrites", REWRITE_README], ["b-reads", README_MUST_BE_ORIGINAL]]);
  const { rows } = runSweep(state, {});
  assert.equal(rows[0].outcome, "clean");
  assert.equal(rows[1].outcome, "error");
  assert.match(rows[1].reason, /uncommitted change/);
  assert.equal(fs.readFileSync(path.join(local, "README.md"), "utf8"), "rewritten by a check\n", "a user's worktree is never reset");
});

test("a damaged mirror inside an enclosing repository never touches that repository", () => {
  const origin = remote();
  const ops = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-ops-"));
  execFileSync("git", ["init", "-q", "-b", "main", ops]);
  git(ops, "config", "user.name", "Ops");
  git(ops, "config", "user.email", "ops@example.invalid");
  fs.writeFileSync(path.join(ops, "notes.md"), "v1\n");
  git(ops, "add", "-A");
  git(ops, "commit", "-q", "-m", "ops");
  const opsHead = git(ops, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(ops, "notes.md"), "uncommitted edit\n");

  // The state file lives inside the ops repository (e.g. a dotfiles repo).
  const project = createProject({ id: "app", name: "APP", repo: "owner/app" });
  setProjectSource(project, "github", { dataPath: path.join(ops, ".sumi", "state.json") });
  project.mirror.url = origin.bare;
  assert.equal(refreshMirror(project).ok, true);

  fs.writeFileSync(path.join(project.mirror.path, ".git", "HEAD"), ""); // power loss mid-write
  const result = refreshMirror(project);
  assert.equal(result.ok, false);
  assert.match(result.reason, /damaged/);
  assert.equal(git(ops, "rev-parse", "HEAD"), opsHead);
  assert.equal(git(ops, "symbolic-ref", "HEAD"), "refs/heads/main", "the enclosing repo is not detached");
  assert.equal(fs.readFileSync(path.join(ops, "notes.md"), "utf8"), "uncommitted edit\n");
  assert.equal(execFileSync("git", ["-C", ops, "for-each-ref", "refs/remotes"], { encoding: "utf8" }), "");
  assert.equal(fs.existsSync(path.join(project.mirror.path, ".git", MIRROR_MARKER)), true, "the damaged mirror is left for the user to delete");
});

test("inherited GIT_DIR / GIT_INDEX_FILE cannot redirect a refresh at the user's repository", () => {
  const origin = remote();
  const { project } = githubProject(origin);
  assert.equal(refreshMirror(project).ok, true);
  const newer = origin.commit({ "n.ts": "1\n" }, "newer");

  const user = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-user-"));
  execFileSync("git", ["init", "-q", "-b", "main", user]);
  git(user, "config", "user.name", "U");
  git(user, "config", "user.email", "u@example.invalid");
  fs.writeFileSync(path.join(user, "a.txt"), "a\n");
  git(user, "add", "-A");
  git(user, "commit", "-q", "-m", "user");
  fs.writeFileSync(path.join(user, "staged.txt"), "staged\n");
  git(user, "add", "staged.txt");
  const userHead = git(user, "rev-parse", "HEAD");

  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = path.join(user, ".git");
  process.env.GIT_INDEX_FILE = path.join(user, ".git", "index");
  process.env.GIT_WORK_TREE = user;
  let result;
  try {
    result = refreshMirror(project);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.commit, newer);
  assert.equal(git(user, "rev-parse", "HEAD"), userHead);
  assert.equal(git(user, "symbolic-ref", "HEAD"), "refs/heads/main");
  assert.equal(git(user, "diff", "--cached", "--name-only"), "staged.txt", "the user's staged change survives");
});

test("a mirror URL that could be read as an option is refused", () => {
  const origin = remote();
  const { project } = githubProject(origin);
  project.mirror.url = "--upload-pack=touch /tmp/pwned";
  assert.match(refreshMirror(project).reason, /refusing mirror URL/);
  project.mirror.url = "ssh://example.com/repo.git";
  assert.match(refreshMirror(project).reason, /refusing mirror URL/);
});

test("overlap is judged on real paths, and a directory named ..x is not mistaken for outside", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-overlap-"));
  const dataPath = path.join(root, "..state", "state.json");
  // The mirror would be root/..state/mirrors/app: inside the clone at root.
  const p = createProject({ id: "app", name: "APP", repo: "owner/app", local: root });
  assert.throws(() => setProjectSource(p, "github", { dataPath }), /overlaps the local clone/);

  const target = path.join(root, "clone");
  fs.mkdirSync(target);
  const link = path.join(root, "link");
  try {
    fs.symlinkSync(target, link, "dir");
  } catch {
    return; // creating symlinks needs a privilege on some Windows hosts
  }
  const q = createProject({ id: "app", name: "APP", repo: "owner/app", local: target });
  assert.throws(() => setProjectSource(q, "github", { dataPath: path.join(link, "state.json") }), /overlaps the local clone/);
});

test("after a failed refresh, every verdict about the unknown commit is cleared, and the last seen commit survives repeats", () => {
  const origin = remote();
  const { project } = githubProject(origin);
  const offline = { skipVercel: true, skipSupabase: true, githubApi: () => ({ ok: false, error: "offline" }), githubTextApi: () => ({ ok: false }) };
  syncProject(project, offline);
  project.deployment.ci = "ready";
  project.deployment.preview = "ready";
  project.deployment.pr = 4;

  project.mirror.url = path.join(origin.root, "gone.git");
  for (let attempt = 1; attempt <= 3; attempt++) {
    syncProject(project, offline);
    assert.equal(project.deployment.commit, null);
    assert.equal(project.deployment.ci, "unknown", `attempt ${attempt}: no CI verdict for an unknown commit`);
    assert.equal(project.deployment.preview, "unknown");
    assert.equal(project.deployment.pr, null);
    assert.equal(project.observations.source.lastKnownCommit, origin.first, `attempt ${attempt}: the last seen commit is kept`);
    assert.equal(project.observations.readiness.ready, 0);
  }
});

test("only the variables that point git at a repository are dropped", async () => {
  const { GIT_LOCATION_VARS, runCommand } = await import("../src/sync.js");
  const saved = { ...process.env };
  Object.assign(process.env, { GIT_DIR: "/elsewhere/.git", GIT_INDEX_FILE: "/elsewhere/index", GIT_SSL_CAINFO: "/corp/ca.pem", GIT_ASKPASS: "/askpass", GIT_SSH_COMMAND: "ssh -i ~/.ssh/work" });
  try {
    const script = "console.log(JSON.stringify(['GIT_DIR','GIT_INDEX_FILE','GIT_SSL_CAINFO','GIT_ASKPASS','GIT_SSH_COMMAND'].map((k) => process.env[k] ?? null)))";
    const result = runCommand(process.execPath, ["-e", script], { resolve: false, dropEnv: GIT_LOCATION_VARS, envDefaults: { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" } });
    assert.deepEqual(JSON.parse(result.stdout), [null, null, "/corp/ca.pem", "/askpass", "ssh -i ~/.ssh/work"]);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("a check never inherits GIT_DIR, so git inside it answers for the swept worktree", () => {
  const origin = remote({ files: { "secret.ts": "TOKEN\n" } });
  const { project } = githubProject(origin);
  const decoy = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-decoy-"));
  execFileSync("git", ["init", "-q", "-b", "main", decoy]);
  // git grep exits 0 on a match: reproduced means the mirror's file was found.
  const state = sweepState(project, [["git-grep", "process.exit(require('child_process').spawnSync('git', ['grep', '-q', 'TOKEN']).status === 0 ? 3 : 0)"]]);
  state.patterns[0].check.reproducedExitCodes = [3];
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(decoy, ".git");
  try {
    const [row] = runSweep(state, {}).rows;
    assert.equal(row.outcome, "reproduced", "git ran against the mirror, not the decoy named by GIT_DIR");
    assert.equal(row.commit, origin.first);
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
  }
});

test("the mirror holds the commit's exact bytes even when the user's git converts line endings", () => {
  const origin = remote({ files: { "a.ts": "line1\nline2\n" } });
  const { project, dataDir } = githubProject(origin);
  const globalConfig = path.join(dataDir, "user.gitconfig");
  fs.writeFileSync(globalConfig, "[core]\n\tautocrlf = true\n");
  const saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalConfig; // the Windows default
  try {
    assert.equal(refreshMirror(project).ok, true);
    assert.equal(fs.readFileSync(path.join(project.mirror.path, "a.ts"), "utf8"), "line1\nline2\n");

    // A mirror configured otherwise (made before this rule, or edited) is
    // corrected on the next refresh.
    git(project.mirror.path, "config", "core.autocrlf", "true");
    origin.commit({ "b.ts": "x\ny\n" }, "more");
    assert.equal(refreshMirror(project).ok, true);
    assert.equal(fs.readFileSync(path.join(project.mirror.path, "b.ts"), "utf8"), "x\ny\n");
    assert.equal(fs.readFileSync(path.join(project.mirror.path, "a.ts"), "utf8"), "line1\nline2\n");
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
  }
});
