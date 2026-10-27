import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("CLI mixed-scope result and handoff preserve a resumable continuation", () => {
  const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-cli-continuation-"));
  const statePath = path.join(root, "custom state.json");
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cliPath, "--data", statePath, ...args], {
      encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const section = (text, name) => text.split(`## ${name}\n`)[1].split("\n## ")[0];
  try {
    run("project", "add", "guard", "--name", "Guard", "--vercel", "none", "--supabase", "none");
    run("scope", "add", "guard", "Verify local checkout", "--status", "doing");
    run("scope", "add", "guard", "Run Windows host verification", "--status", "blocked");
    run("scope", "add", "guard", "Prepare continuation evidence", "--status", "todo");
    run("result", "guard", "C001", "--agent", "codex", "--text",
      "C001 can move to done. C002 stays blocked. C003 stays open.", "--apply");
    const project = JSON.parse(fs.readFileSync(statePath, "utf8")).projects.guard;
    assert.deepEqual(project.scope.criteria.map(item => item.status), ["done", "blocked", "todo"]);
    assert.equal(project.agentResults[0].targetDisposition.action, "done");
    const continuation = run("continue", "guard", "--no-sync");
    assert.match(continuation, /RECOMMENDED NEXT\r?\n  C003 Prepare continuation evidence/);
    const handoff = run("handoff", "guard").replace(/\r\n/g, "\n");
    assert.ok(section(handoff, "Project").includes(`State file: ${path.resolve(statePath)}`));
    assert.match(section(handoff, "Blocked"), /C002 Run Windows host verification/);
    assert.match(section(handoff, "Next"), /^- C003 .*\[ready\]/);
    assert.match(section(handoff, "Next"), /C002 .*\[waiting\]/);
    assert.doesNotMatch(section(handoff, "Next"), /C001/);
    assert.match(section(handoff, "Recent agent results"), /R001 C001 via codex — done/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI help reports the package version", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
  );
  const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const result = spawnSync(process.execPath, [cliPath, "--help"], {
    encoding: "utf8",
    windowsHide: true
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^SUMI Orchestrator v${packageJson.version}\\r?$`, "m"));
});

// `sweep` is the one command that spawns an operator-supplied process, so it is
// exercised end to end against a real repository rather than only at unit level.
test("CLI sweep runs a real check in a real worktree and files what it reproduces", () => {
  const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-cli-sweep-"));
  const repo = path.join(root, "leaky");
  const statePath = path.join(root, "state.json");
  const sumi = (...args) => spawnSync(process.execPath, [cliPath, "--data", statePath, ...args], {
    encoding: "utf8", windowsHide: true
  });
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  try {
    fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(repo, "scripts", "check.mjs"), "process.exit(process.env.SUMI_TEST_UNUSED ? 0 : 3);\n");
    git("init", "-q", "-b", "main");
    git("config", "user.email", "sweep@example.test");
    git("config", "user.name", "Sweep Test");
    git("add", "-A");
    git("commit", "-qm", "seed");
    const head = git("rev-parse", "HEAD").trim();

    assert.equal(sumi("project", "add", "leaky", "--name", "Leaky", "--local", repo).status, 0);
    const added = sumi(
      "pattern", "add", "always-fails",
      "--title", "The check always fails here",
      "--question", "Does the check pass?",
      "--origin", "record",
      "--check", "node scripts/check.mjs"
    );
    assert.equal(added.status, 0, added.stderr);

    const dry = sumi("sweep", "--dry-run");
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /DRY RUN/);
    assert.match(dry.stdout, /reproduced 1 \| suppressed 0 \| clean 0/);
    assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).projects.leaky.findings.length, 0);

    // `--project` is read by scanning argv, so its value must not be mistaken
    // for the optional pattern-key positional.
    const run = sumi("sweep", "--project", "leaky");
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /always-fails\s+leaky\s+reproduced\s+F001\s+confirmed/);

    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const finding = state.projects.leaky.findings[0];
    assert.equal(finding.status, "confirmed");
    assert.equal(finding.source.kind, "sweep");
    assert.equal(finding.evidence.commit, head);
    assert.equal(finding.confirmations[0].check.exitCode, 3);
    assert.equal(state.projects.leaky.sweeps[0].outcome, "reproduced");

    // A dismissal must survive the next sweep: the check still reproduces, and
    // re-filing it would hand back a fresh confirmed finding on every run.
    const dismissed = sumi(
      "finding", "set-status", "leaky", "F001", "--status", "dismissed",
      "--reason", "false positive: the check matches its own fixture"
    );
    assert.equal(dismissed.status, 0, dismissed.stderr);
    const again = sumi("sweep", "--project", "leaky");
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /suppressed\s+F001\s+F001 dismissed/);
    assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).projects.leaky.findings.length, 1);

    // A dirty worktree cannot be bound to a commit, so it answers nothing.
    fs.writeFileSync(path.join(repo, "scripts", "check.mjs"), "process.exit(0);\n");
    const dirty = sumi("sweep", "--project", "leaky");
    assert.equal(dirty.status, 0, dirty.stderr);
    assert.match(dirty.stdout, /error/);
    assert.match(dirty.stdout, /uncommitted change/);
    assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).projects.leaky.findings.length, 1);

    const judgment = sumi("sweep", "always-fails", "--project", "nope");
    assert.equal(judgment.status, 1);
    assert.match(judgment.stderr, /Unknown project: nope/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI detector policy keeps execution errors out of findings and persists updates", () => {
  const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-cli-detector-"));
  const repo = path.join(root, "repo");
  const statePath = path.join(root, "state.json");
  const sumi = (...args) => spawnSync(process.execPath, [cliPath, "--data", statePath, ...args], {
    encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
  });
  const run = (...args) => {
    const result = sumi(...args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const read = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
  const check = (code) => JSON.stringify([process.execPath, "check.mjs", String(code)]);
  try {
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, "check.mjs"), "process.exit(Number(process.argv[2]));\n");
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q", "-b", "main");
    git("-c", "user.name=SUMI Test", "-c", "user.email=sumi@example.invalid", "add", "check.mjs");
    git("-c", "user.name=SUMI Test", "-c", "user.email=sumi@example.invalid", "commit", "-qm", "fixture");
    run("project", "add", "app", "--name", "APP", "--local", repo);
    run("pattern", "add", "detector", "--title", "Detector", "--question", "Does it match?", "--origin", "record",
      "--check", check(2), "--check-expect", "exit-nonzero", "--check-error-exit-codes", "2");
    assert.match(run("sweep", "detector"), /error 1/);
    assert.equal(read().projects.app.findings.length, 0);
    assert.equal(read().projects.app.sweeps[0].exitCode, 2);
    assert.match(run("pattern", "show", "detector"), /error exit codes: 2/);

    run("pattern", "set", "detector", "--check", check(1), "--check-expect", "exit-nonzero", "--check-error-exit-codes", "2");
    assert.match(run("sweep", "detector"), /clean 1/);
    run("pattern", "set", "detector", "--check-error-exit-codes", "2,3");
    assert.deepEqual(read().patterns[0].check.errorExitCodes, [2, 3]);
    assert.equal(read().patterns[0].check.expect, "exit-nonzero");
    const outdated = run("findings");
    assert.match(outdated, /detector\s+medium\s+unknown/);
    assert.match(outdated, /RECHECK REQUIRED/);
    assert.match(outdated, /sumi sweep detector --project app/);
    assert.match(run("sweep", "detector"), /clean 1/);
    assert.match(run("findings"), /detector\s+medium\s+clean/);
    run("pattern", "set", "detector", "--check", check(0), "--check-expect", "exit-nonzero", "--check-error-exit-codes", "2");
    assert.match(run("sweep", "detector"), /reproduced 1/);
    const finding = read().projects.app.findings[0];
    assert.equal(finding.status, "confirmed");
    assert.deepEqual(finding.confirmations[0].check.errorExitCodes, [2]);

    const beforeInvalid = fs.readFileSync(statePath, "utf8");
    const invalid = sumi("pattern", "set", "detector", "--check-error-exit-codes", "2,");
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /errorExitCodes/);
    assert.equal(fs.readFileSync(statePath, "utf8"), beforeInvalid);
    const missing = sumi("pattern", "set", "detector", "--check-error-exit-codes");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /requires a comma-separated list or none/);
    assert.equal(fs.readFileSync(statePath, "utf8"), beforeInvalid);
    run("pattern", "set", "detector", "--check-error-exit-codes", "none");
    assert.equal(read().patterns[0].check.errorExitCodes, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI pattern import is all-or-nothing and a dry run writes nothing", () => {
  const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-cli-import-"));
  const statePath = path.join(root, "state.json");
  const records = path.join(root, "app-pitfalls");
  fs.mkdirSync(records);
  const record = (id, overrides = {}) => fs.writeFileSync(path.join(records, `${id}.json`), JSON.stringify({
    id, title: `title ${id}`, summary: "summary", layer: "app", kind: "trap", severity: "high",
    confidence: "inferred", origin: "docs/x.md#anchor", status: "closed", fix: "fixed",
    detection: { checkable: false, kind: "manual" }, tags: ["supabase"], ...overrides
  }), "utf8");
  const sumi = (...args) => spawnSync(process.execPath, [cliPath, "--data", statePath, ...args], {
    encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
  });
  const patternKeys = () => fs.existsSync(statePath)
    ? (JSON.parse(fs.readFileSync(statePath, "utf8")).patterns || []).map((item) => item.key)
    : [];
  try {
    record("rls-001");
    record("rls-002", { origin: "issue:7" });
    const refused = sumi("pattern", "import", records);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /nothing was written[\s\S]*rls-002\.json/);
    assert.deepEqual(patternKeys(), []);

    record("rls-002");
    const dry = sumi("pattern", "import", records, "--dry-run");
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /would add 2/);
    assert.deepEqual(patternKeys(), []);

    const applied = sumi("pattern", "import", records);
    assert.equal(applied.status, 0, applied.stderr);
    assert.deepEqual(patternKeys(), ["rls-001", "rls-002"]);
    assert.equal(sumi("pattern", "import", "--builtin").status, 0);
    assert.deepEqual(patternKeys(), ["rls-001", "rls-002", "service-role-in-client"]);

    const added = sumi("pattern", "add", "allow-list", "--title", "t", "--question", "q?", "--origin", "record",
      "--check", "node x.mjs", "--check-reproduced-exit-codes", "3");
    assert.equal(added.status, 0, added.stderr);
    assert.match(sumi("pattern", "show", "allow-list").stdout, /reproduced exit codes: 3 \(0 is clean; any other exit is an execution error\)/);
    assert.equal(sumi("pattern", "set", "allow-list", "--check-reproduced-exit-codes", "none").status, 0);
    assert.doesNotMatch(sumi("pattern", "show", "allow-list").stdout, /reproduced exit codes/);

    const both = sumi("pattern", "import", records, "--builtin");
    assert.notEqual(both.status, 0);
    assert.match(both.stderr, /either a file\/directory or --builtin/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI registers a GitHub-source project with a mirror next to the state file", () => {
  const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-cli-source-"));
  const statePath = path.join(root, "state.json");
  const sumi = (...args) => spawnSync(process.execPath, [cliPath, "--data", statePath, ...args], {
    encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
  });
  const project = (id) => JSON.parse(fs.readFileSync(statePath, "utf8")).projects[id];
  try {
    const noRepo = sumi("project", "add", "app", "--name", "App", "--source", "github");
    assert.notEqual(noRepo.status, 0);
    assert.match(noRepo.stderr, /needs --repo owner\/name/);

    assert.equal(sumi("project", "add", "app", "--name", "App", "--repo", "owner/app", "--source", "github").status, 0);
    assert.equal(project("app").source, "github");
    assert.equal(project("app").mirror.path, path.join(root, "mirrors", "app"));
    assert.equal(project("app").mirror.url, "https://github.com/owner/app.git");

    assert.equal(sumi("project", "set", "app", "--repo", "owner/renamed").status, 0);
    assert.equal(project("app").mirror.url, "https://github.com/owner/renamed.git", "the mirror follows the repo it names");

    const overlap = sumi("project", "set", "app", "--local", root);
    assert.notEqual(overlap.status, 0);
    assert.match(overlap.stderr, /overlaps the local clone/);

    assert.equal(sumi("project", "set", "app", "--source", "local").status, 0);
    assert.equal(project("app").source, "local");
    assert.match(sumi("status", "app").stdout, /SOURCE\s+local clone/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
