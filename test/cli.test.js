import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
