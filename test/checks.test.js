import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { bundledArgv, bundledScriptDigest, resolveBundledInvocation } from "../src/bundled-checks.js";
import { createEmptyState, createProject } from "../src/domain.js";
import { addPattern, buildFindingsMatrix, getPatternFingerprint, listFindings, normalizeCheck } from "../src/findings.js";
import { applyPatternImport, builtinPatternCandidates, CHECKS_DIR, planPatternImport } from "../src/pattern-import.js";
import { evaluateCheckRun, runSweep } from "../src/sweep.js";

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-check-"));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, ...name.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return root;
}

function gitRepo(files, { commit = true } = {}) {
  const root = tree(files);
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "core.autocrlf", "false");
  git("config", "user.name", "SUMI Test");
  git("config", "user.email", "sumi-test@example.invalid");
  if (commit) {
    git("add", "-A");
    git("commit", "-q", "-m", "initial");
  }
  return root;
}

function run(script, args, cwd) {
  const result = spawnSync(process.execPath, [path.join(CHECKS_DIR, script), ...args], { cwd, encoding: "utf8", timeout: 20000 });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const SECRET = "eyJhbGciOiJIUzI1NiJ9.do-not-print-me";
const GITIGNORE = ".env*.local\n.env.big\nnode_modules/\n";

test("a check with reproduced exit codes reads every other exit as an execution error", () => {
  const check = normalizeCheck({ argv: bundledArgv("x.mjs"), expect: "exit-zero", reproducedExitCodes: [3] });
  const exit = (status) => evaluateCheckRun(check, { status, stdout: "out", stderr: "" });
  assert.equal(exit(0).reproduced, false);
  assert.equal(exit(3).reproduced, true);
  for (const status of [1, 2, 9, 13, 126, 127, 134, 3221225477]) {
    const verdict = exit(status);
    assert.equal(verdict.ran, false, `exit ${status} must not be a verdict`);
    assert.match(verdict.reason, /only 0 \(clean\) and 3 \(reproduced\) are verdicts/);
  }
  assert.throws(() => normalizeCheck({ argv: ["x"], expect: "exit-nonzero", reproducedExitCodes: [3] }), /requires expect exit-zero/);
  assert.throws(() => normalizeCheck({ argv: ["x"], reproducedExitCodes: [3], errorExitCodes: [3] }), /both reproduced and execution errors/);
});

test("bundled checks are stored without a machine path and resolved to SUMI's own Node", () => {
  const argv = bundledArgv("service-role-in-client.mjs");
  assert.deepEqual(argv, ["{sumi-node}", "{sumi-checks}/service-role-in-client.mjs"]);
  const invocation = resolveBundledInvocation(argv);
  assert.equal(invocation.command, process.execPath, "never a PATH lookup of node inside the project");
  assert.equal(invocation.args[0], path.join(CHECKS_DIR, "service-role-in-client.mjs"));
  assert.match(resolveBundledInvocation(bundledArgv("no-such-check.mjs")).error, /bundled check not found/);

  assert.throws(() => normalizeCheck({ argv: ["node", "{sumi-checks}/x.mjs"] }), /placeholders are only valid/);
  assert.throws(() => normalizeCheck({ argv: ["{sumi-node}", "../x.mjs"] }), /placeholders are only valid/);
  assert.throws(() => normalizeCheck({ argv: ["{sumi-node}", "{sumi-checks}/x.mjs", "{sumi-node}"] }), /argument position/);
});

test("a missing bundled script is a sweep error, never a reproduction", () => {
  const state = createEmptyState();
  addPattern(state, {
    key: "gone", title: "gone", question: "gone?", origin: "record",
    check: { argv: bundledArgv("no-such-check.mjs"), expect: "exit-zero", reproducedExitCodes: [3] }
  });
  const project = createProject({ id: "app", name: "APP", local: gitRepo({ "a.ts": "" }) });
  state.projects.app = project;
  const [row] = runSweep(state, {}).rows;
  assert.equal(row.outcome, "error");
  assert.match(row.reason, /bundled check not found/);
  assert.deepEqual(listFindings(project), []);
});

test("file-content: present and absent decide clean (0) or reproduced (3)", () => {
  const root = tree({ "src/db.ts": "const key = process.env.SUPABASE_SERVICE_ROLE_KEY;\n" });
  assert.equal(run("file-content.mjs", ["src/db.ts", "SERVICE_ROLE", "present"], root).status, 0);
  const miss = run("file-content.mjs", ["src/db.ts", "SERVICE_ROLE", "absent"], root);
  assert.equal(miss.status, 3);
  assert.match(miss.out, /reproduced: "SERVICE_ROLE" is present in src\/db\.ts \(expected absent\)/);
  assert.doesNotMatch(miss.out, /process\.env/, "the file content is never printed");
});

test("file-content: anything it cannot read is unknown (2), never clean", () => {
  const outside = tree({ "secret.txt": "x" });
  const root = tree({ "bin.dat": "a\u0000b" });
  fs.writeFileSync(path.join(root, "latin1.txt"), Buffer.from([0xff, 0xfe, 0x41]));
  const cases = [
    ["missing.ts", /target not found/],
    ["../secret.txt", /invalid target/],
    ["src\\db.ts", /invalid target/],
    [path.join(outside, "secret.txt"), /invalid target/],
    ["bin.dat", /not UTF-8 text/],
    ["latin1.txt", /not UTF-8 text/]
  ];
  for (const [target, reason] of cases) {
    const result = run("file-content.mjs", [target, "needle", "absent"], root);
    assert.equal(result.status, 2, target);
    assert.match(result.out, reason, target);
  }
  assert.equal(run("file-content.mjs", ["x"], root).status, 2, "bad usage is unknown");
  assert.equal(run("file-content.mjs", ["x", "y", "maybe"], root).status, 2);
});

test("service-role-in-client: a clean project exits 0 and reads git-ignored .env files", () => {
  const root = gitRepo({
    ".gitignore": GITIGNORE,
    "src/lib/admin.ts": "import 'server-only';\nconst key = process.env.SUPABASE_SERVICE_ROLE_KEY;\n",
    "src/app/page.tsx": "\"use client\";\nexport default function Page() { return null; }\n",
    ".env.local": `SUPABASE_SERVICE_ROLE_KEY=${SECRET}\nNEXT_PUBLIC_SUPABASE_URL=https://x.supabase.co\n`
  });
  const result = run("service-role-in-client.mjs", [], root);
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /clean: 0 hit\(s\) in 3 file\(s\)/, "two tracked sources plus the ignored .env.local");
});

test("service-role-in-client: a browser-exposed variable is reported by name, never by value", () => {
  const root = gitRepo({
    ".gitignore": GITIGNORE,
    ".env.local": `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY=${SECRET}\n`,
    "src/lib/client.ts": "createClient(url, process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!);\n",
    "app/vite.ts": "import.meta.env.VITE_SERVICE_ROLE_KEY;\n"
  });
  const result = run("service-role-in-client.mjs", [], root);
  assert.equal(result.status, 3);
  assert.match(result.out, /^\.env\.local:1: browser-exposed variable NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY/m);
  assert.match(result.out, /^src\/lib\/client\.ts:1: browser-exposed variable NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY/m);
  assert.match(result.out, /^app\/vite\.ts:1: browser-exposed variable VITE_SERVICE_ROLE_KEY/m);
  assert.doesNotMatch(result.out, /do-not-print-me/);
});

test("service-role-in-client: a \"use client\" module that mentions service_role is reported", () => {
  const root = gitRepo({
    "src/components/Admin.tsx": "// admin widget\n/* client */\n'use client';\n\nconst key = process.env.SUPABASE_SERVICE_ROLE_KEY;\n",
    "src/components/Bom.tsx": "﻿\"use client\";\nconst role = 'service_role';\n",
    "src/server/job.ts": "const role = 'service_role'; // not a client module\n",
    "src/components/Late.tsx": "import x from 'y';\n'use client';\nconst k = 'service_role';\n"
  });
  const result = run("service-role-in-client.mjs", [], root);
  assert.equal(result.status, 3);
  assert.match(result.out, /^src\/components\/Admin\.tsx:5: "use client" module mentions service_role/m);
  assert.match(result.out, /^src\/components\/Bom\.tsx:2: "use client" module mentions service_role/m);
  assert.doesNotMatch(result.out, /job\.ts|Late\.tsx/, "only a leading directive makes a client module");
});

test("service-role-in-client: no directory is skipped by name, at any depth", () => {
  const root = gitRepo({
    "src/app/build/page.tsx": "process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;\n",
    "packages/web/dist/env.ts": "process.env.NEXT_PUBLIC_SERVICE_ROLE;\n"
  });
  const result = run("service-role-in-client.mjs", [], root);
  assert.equal(result.status, 3, result.out);
  assert.match(result.out, /^src\/app\/build\/page\.tsx:1:/m);
  assert.match(result.out, /^packages\/web\/dist\/env\.ts:1:/m);
});

test("service-role-in-client: test files are not read", () => {
  const root = gitRepo({
    "src/ok.ts": "export {};\n",
    "src/env.test.ts": "assert.equal(process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY, undefined);\n",
    "src/__tests__/leak.ts": "process.env.NEXT_PUBLIC_SERVICE_ROLE;\n"
  });
  const result = run("service-role-in-client.mjs", [], root);
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /clean: 0 hit\(s\) in 1 file\(s\)/);
});

test("service-role-in-client: a hit on a comment-looking line is labelled, never dropped", () => {
  const root = gitRepo({
    ".gitignore": GITIGNORE,
    "src/components/Safe.tsx": "\"use client\";\n// Never import the service_role client here.\n",
    "src/doc.ts": "/* NEXT_PUBLIC_SERVICE_ROLE is forbidden */\n",
    ".env.local": `# NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY=${SECRET}\n`
  });
  const result = run("service-role-in-client.mjs", [], root);
  assert.equal(result.status, 3, "whether a line is really a comment cannot be known line by line");
  for (const file of ["src/components/Safe.tsx:2", "src/doc.ts:1", ".env.local:1"]) {
    assert.match(result.out, new RegExp(`^${file.replace(/[.]/g, "\\.")}: .*looks like a comment; dismiss the finding if it is one`, "m"));
  }
  assert.doesNotMatch(result.out, /do-not-print-me/);
});

test("service-role-in-client: a string that looks like a comment is still code", () => {
  const root = gitRepo({
    "src/a.ts": "const u = \"https://x\"; const k = process.env.NEXT_PUBLIC_SERVICE_ROLE_KEY;\n"
  });
  assert.equal(run("service-role-in-client.mjs", [], root).status, 3);
});

test("service-role-in-client: an unread file means unknown (2), not clean", () => {
  const outside = tree({ "env.production": `NEXT_PUBLIC_SUPABASE_URL=x\n` });
  const symlinked = gitRepo({ "src/a.ts": "export {};\n" }, { commit: false });
  try {
    fs.symlinkSync(path.join(outside, "env.production"), path.join(symlinked, ".env.production"));
  } catch {
    return; // symlinks need privileges on some Windows hosts; the large-file case below covers the rule
  }
  execFileSync("git", ["-C", symlinked, "add", "-A"]);
  execFileSync("git", ["-C", symlinked, "commit", "-q", "-m", "initial"]);
  const result = run("service-role-in-client.mjs", [], symlinked);
  assert.equal(result.status, 2, result.out);
  assert.match(result.out, /\.env\.production is a symlink leading out of the worktree; a clean answer is not possible/);
});

test("service-role-in-client: a file too large to read means unknown (2), and a hit still wins", () => {
  const root = gitRepo({ ".gitignore": GITIGNORE, "src/a.ts": "export {};\n" });
  fs.writeFileSync(path.join(root, ".env.big"), "");
  fs.truncateSync(path.join(root, ".env.big"), 51 * 1024 * 1024);
  const unknown = run("service-role-in-client.mjs", [], root);
  assert.equal(unknown.status, 2, unknown.out);
  assert.match(unknown.out, /\.env\.big is larger than/);

  fs.writeFileSync(path.join(root, ".env.local"), "NEXT_PUBLIC_SERVICE_ROLE=x\n");
  const hit = run("service-role-in-client.mjs", [], root);
  assert.equal(hit.status, 3, "what was read proves the leak, whatever else could not be read");
  assert.match(hit.out, /1 file\(s\) could not be read/);
});

test("service-role-in-client: nothing to read is unknown (2)", () => {
  const result = run("service-role-in-client.mjs", [], gitRepo({ "main.py": "print('hi')\n" }));
  assert.equal(result.status, 2);
  assert.match(result.out, /no JavaScript\/TypeScript or \.env files to read/);
});

test("service-role-in-client: leading block comments cannot stall the check", () => {
  // Backtracking blows up when the directive is NOT found, so the file that
  // matters is the one without it.
  const header = "/* eslint-disable */\n".repeat(400);
  const root = gitRepo({
    "src/Server.tsx": `${header}export const k = 'service_role';\n`,
    "src/C.tsx": `${header}"use client";\nconst k = 'service_role';\n`
  });
  const started = Date.now();
  const result = run("service-role-in-client.mjs", [], root);
  assert.equal(result.status, 3, result.out);
  assert.doesNotMatch(result.out, /Server\.tsx/);
  assert.ok(Date.now() - started < 10000, "must not backtrack");
});

test("sweep runs the built-in pattern end to end: a leak is confirmed, a clean project is clean", () => {
  const state = createEmptyState();
  applyPatternImport(state, planPatternImport(state, { candidates: builtinPatternCandidates() }));
  const leaky = createProject({ id: "leaky", name: "LEAKY", local: gitRepo({
    "src/lib/client.ts": "createClient(url, process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!);\n"
  }) });
  const clean = createProject({ id: "clean", name: "CLEAN", local: gitRepo({ "src/lib/admin.ts": "process.env.SUPABASE_SERVICE_ROLE_KEY;\n" }) });
  const unknown = createProject({ id: "unknown", name: "UNKNOWN", local: gitRepo({ "a.ts": "" }) });
  leaky.supabase = "leaky-ref";
  clean.supabase = "clean-ref";
  Object.assign(state.projects, { leaky, clean, unknown });

  const outcome = runSweep(state, {});
  const byProject = Object.fromEntries(outcome.rows.map((row) => [row.projectId, row]));
  assert.equal(byProject.leaky.outcome, "reproduced");
  assert.equal(byProject.clean.outcome, "clean");
  assert.equal(byProject.unknown.outcome, "skipped", "an unregistered Supabase is not answered");

  const [finding] = listFindings(leaky);
  assert.equal(finding.status, "confirmed", "a sweep reproduction confirms through R1(a)");
  assert.match(finding.confirmations[0].evidence.output, /NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY/);

  const matrix = buildFindingsMatrix(state, { patternKey: "service-role-in-client" });
  const cells = Object.fromEntries(matrix.rows[0].cells.map((cell) => [cell.projectId, cell.cell]));
  assert.match(cells.leaky, /confirmed/);
  assert.equal(cells.clean, "clean");
  assert.equal(cells.unknown, "unknown");
});

test("service-role-in-client: a regex literal or JSX text with /* does not hide the next line", () => {
  const root = gitRepo({
    "app/page.tsx": "const base = s.replace(/\\/*$/, \"\");\nconst db = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!);\n",
    "app/Note.tsx": "export const Note = () => <p>Files under src/* are watched</p>;\nexport const k = process.env.NEXT_PUBLIC_SERVICE_ROLE;\n",
    "app/open.ts": "/* never closed\nexport const k = process.env.VITE_SERVICE_ROLE_KEY;\n"
  });
  const result = run("service-role-in-client.mjs", [], root);
  assert.equal(result.status, 3, result.out);
  assert.match(result.out, /^app\/page\.tsx:2:/m);
  assert.match(result.out, /^app\/Note\.tsx:2:/m);
  assert.match(result.out, /^app\/open\.ts:2:/m, "an unterminated block comment is not stripped");
});

test("service-role-in-client: a mid-line comment is kept, so it can only add a hit", () => {
  const root = gitRepo({ "src/a.ts": "init(); // do not use NEXT_PUBLIC_SERVICE_ROLE here\n" });
  const result = run("service-role-in-client.mjs", [], root);
  assert.equal(result.status, 3, "a false hit is dismissed once; a hidden leak would never be seen");
});

function gitIn(cwd, ...args) {
  return execFileSync("git", ["-c", "protocol.file.allow=always", "-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

test("service-role-in-client: files inside a checked-out submodule are read", () => {
  const ui = gitRepo({ "Admin.tsx": "\"use client\";\nconst k = process.env.SUPABASE_SERVICE_ROLE_KEY;\n" });
  const root = gitRepo({ "src/a.ts": "export {};\n" });
  gitIn(root, "submodule", "add", "-q", ui, "packages/ui");
  gitIn(root, "commit", "-q", "-m", "add ui");
  const result = run("service-role-in-client.mjs", [], root);
  assert.equal(result.status, 3, result.out);
  assert.match(result.out, /^packages\/ui\/Admin\.tsx:2: "use client" module mentions service_role/m);
});

test("service-role-in-client: a submodule that is not checked out means unknown (2)", () => {
  const ui = gitRepo({ "Admin.tsx": "\"use client\";\nconst k = process.env.SUPABASE_SERVICE_ROLE_KEY;\n" });
  const origin = gitRepo({ "src/a.ts": "export {};\n" });
  gitIn(origin, "submodule", "add", "-q", ui, "packages/ui");
  gitIn(origin, "commit", "-q", "-m", "add ui");
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), "sumi-check-clone-"));
  gitIn(clone, "clone", "-q", origin, "app");
  const result = run("service-role-in-client.mjs", [], path.join(clone, "app"));
  assert.equal(result.status, 2, result.out);
  assert.match(result.out, /packages\/ui is a git submodule that is not checked out/);
});

test("service-role-in-client: many hits in a large file finish quickly", () => {
  const root = gitRepo({ "src/a.ts": "export {};\n" });
  fs.writeFileSync(path.join(root, "src", "big.ts"), "x(NEXT_PUBLIC_SERVICE_ROLE);\n".repeat(200000));
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "big"]);
  const started = Date.now();
  const result = run("service-role-in-client.mjs", [], root);
  assert.equal(result.status, 3);
  assert.match(result.out, /^src\/big\.ts:1: /m);
  assert.match(result.out, /^src\/big\.ts:50: /m);
  assert.doesNotMatch(result.out, /^src\/big\.ts:51: /m);
  assert.match(result.out, /\.\.\. and 199950 more hit\(s\)/);
  assert.match(result.out, /reproduced: 200000 hit\(s\)/);
  assert.ok(result.out.length < 10000, "output stays far below the sweep's buffer");
  assert.ok(Date.now() - started < 15000, `took ${Date.now() - started}ms`);
});

test("a hand-written bundled check gets the fixed exit contract, so 'could not check' is never a reproduction", () => {
  const check = normalizeCheck({ argv: bundledArgv("file-content.mjs", ["missing.yml", "x", "absent"]), expect: "exit-zero" });
  assert.deepEqual(check.reproducedExitCodes, [3]);
  assert.throws(() => normalizeCheck({ argv: bundledArgv("file-content.mjs"), reproducedExitCodes: [2] }), /fixed at 3/);
  assert.throws(() => normalizeCheck({ argv: bundledArgv("file-content.mjs"), errorExitCodes: [2] }), /takes no errorExitCodes/);
  assert.throws(() => normalizeCheck({ argv: bundledArgv("file-content.mjs"), expect: "exit-nonzero" }), /requires expect exit-zero/);

  const state = createEmptyState();
  addPattern(state, { key: "ci-node", title: "t", question: "q?", origin: "record", check: { argv: check.argv, expect: "exit-zero" } });
  state.projects.app = createProject({ id: "app", name: "APP", local: gitRepo({ "a.ts": "" }) });
  const [row] = runSweep(state, {}).rows;
  assert.equal(row.outcome, "error", "file-content exits 2 for a missing target");
  assert.deepEqual(listFindings(state.projects.app), []);
});

test("the fingerprint of a bundled check covers the script's content", () => {
  const pattern = { check: { argv: bundledArgv("service-role-in-client.mjs"), expect: "exit-zero" }, appliesTo: null };
  const script = fs.readFileSync(path.join(CHECKS_DIR, "service-role-in-client.mjs"), "utf8").replace(/\r\n/g, "\n");
  assert.equal(bundledScriptDigest(pattern.check.argv), createHash("sha256").update(script).digest("hex"));
  const expected = createHash("sha256").update(JSON.stringify({
    version: 1,
    check: normalizeCheck(pattern.check),
    requires: [],
    bundledScript: bundledScriptDigest(pattern.check.argv)
  })).digest("hex");
  assert.equal(getPatternFingerprint(pattern), expected, "changing the script changes the fingerprint, so old answers need a recheck");
  assert.equal(bundledScriptDigest(bundledArgv("no-such-check.mjs")), "missing");

  const plain = { check: { argv: ["node", "x.mjs"] }, appliesTo: null };
  assert.equal(getPatternFingerprint(plain), createHash("sha256").update(JSON.stringify({
    version: 1, check: normalizeCheck(plain.check), requires: []
  })).digest("hex"), "every other fingerprint is unchanged");
});

test("a malformed placeholder in a hand-edited state stops only its own pattern", () => {
  const state = createEmptyState();
  addPattern(state, { key: "fine", title: "t", question: "q?", origin: "record", check: { argv: [process.execPath, "-e", "process.exit(0)"] } });
  state.patterns.push({
    id: "P002", key: "broken", title: "t", question: "q?", kind: "mechanical", origin: "record", severity: "high", appliesTo: null,
    check: { argv: ["{sumi-node}", "{sumi-checks}/../../x.mjs"], cwd: "repo", timeoutMs: 1000, expect: "exit-zero" }
  });
  state.projects.app = createProject({ id: "app", name: "APP", local: gitRepo({ "a.ts": "" }) });
  let outcome;
  assert.doesNotThrow(() => { outcome = runSweep(state, {}); });
  const byPattern = Object.fromEntries(outcome.rows.map((row) => [row.patternKey, row]));
  assert.equal(byPattern.fine.outcome, "clean");
  assert.equal(byPattern.broken.outcome, "error");
  assert.match(byPattern.broken.reason, /placeholders are only valid/);
});

test("service-role-in-client: a BOM followed by a comment still makes a client module", () => {
  const root = gitRepo({ "src/Admin.tsx": "﻿// Admin panel\n\"use client\";\nconst k = process.env.SUPABASE_SERVICE_ROLE_KEY;\n" });
  const result = run("service-role-in-client.mjs", [], root);
  assert.equal(result.status, 3, result.out);
  assert.match(result.out, /^src\/Admin\.tsx:3: "use client" module mentions service_role/m);
});

test("service-role-in-client: a stray backtick cannot hide a later line", () => {
  const root = gitRepo({
    "src/a.ts": [
      "init(); // the ` key toggles the console",
      "const css = `",
      "/* reset",
      "body { margin: 0 }",
      "`;",
      "const k = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;",
      "/** done */",
      ""
    ].join("\n")
  });
  const result = run("service-role-in-client.mjs", [], root);
  assert.equal(result.status, 3, result.out);
  assert.match(result.out, /^src\/a\.ts:6: browser-exposed variable/m);
});

test("service-role-in-client: comment-looking lines are reported with a label", () => {
  const root = gitRepo({
    "src/doc.ts": [
      "/**",
      " * Never set NEXT_PUBLIC_SERVICE_ROLE_KEY.",
      " */",
      "/* note */ const k = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;",
      ""
    ].join("\n")
  });
  const result = run("service-role-in-client.mjs", [], root);
  assert.equal(result.status, 3, result.out);
  assert.match(result.out, /^src\/doc\.ts:2: .*looks like a comment/m);
  assert.match(result.out, /^src\/doc\.ts:4: .*looks like a comment/m);
});

test("service-role-in-client: many unterminated block comments finish quickly", () => {
  const root = gitRepo({ "src/a.ts": "/*\n".repeat(400000) });
  const started = Date.now();
  const result = run("service-role-in-client.mjs", [], root);
  assert.equal(result.status, 0, result.out);
  assert.ok(Date.now() - started < 15000, `took ${Date.now() - started}ms`);
});

test("a bundled check stored before the fixed exit contract still gets it in a sweep", () => {
  const state = createEmptyState();
  // As written by an earlier build: no reproducedExitCodes in the state file.
  state.patterns.push({
    id: "P001", key: "ci-node", title: "t", question: "q?", kind: "mechanical", origin: "record", severity: "medium", appliesTo: null,
    check: { argv: bundledArgv("file-content.mjs", ["missing.yml", "node-version:20", "absent"]), cwd: "repo", timeoutMs: 30000, expect: "exit-zero" }
  });
  state.projects.app = createProject({ id: "app", name: "APP", local: gitRepo({ "a.ts": "" }) });
  const [row] = runSweep(state, {}).rows;
  assert.equal(row.outcome, "error", "exit 2 (could not check) is never a reproduction");
  assert.match(row.reason, /only 0 \(clean\) and 3 \(reproduced\) are verdicts/);
  assert.deepEqual(listFindings(state.projects.app), []);
});

test("service-role-in-client: lines that start with * or // inside code are still hits", () => {
  const root = gitRepo({
    "src/md.ts": "export const md = `\n* key: ${process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY}\n`;\n",
    "src/url.ts": "export const u = `postgres:\n//${process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY}@db`;\n",
    "src/gen.ts": "class C {\n*[Symbol.iterator]() { yield process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY; }\n}\n"
  });
  const result = run("service-role-in-client.mjs", [], root);
  assert.equal(result.status, 3, result.out);
  assert.match(result.out, /^src\/md\.ts:2: /m);
  assert.match(result.out, /^src\/url\.ts:2: /m);
  assert.match(result.out, /^src\/gen\.ts:2: /m);
});

test("service-role-in-client: a long comment-looking line with many hits finishes quickly", () => {
  const root = gitRepo({ "src/a.ts": "export {};\n" });
  fs.writeFileSync(path.join(root, "src", "one.ts"), `* ${"NEXT_PUBLIC_SERVICE_ROLE ".repeat(200000)}\n`);
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "one line"]);
  const started = Date.now();
  const result = run("service-role-in-client.mjs", [], root);
  assert.equal(result.status, 3, result.out);
  assert.ok(Date.now() - started < 15000, `took ${Date.now() - started}ms`);
});

test("a bundled script named by its absolute path keeps the bundled exit contract", () => {
  const script = path.join(CHECKS_DIR, "file-content.mjs");
  // As an early build stored it, and as a hand-typed --check would be.
  for (const stored of [
    { argv: ["node", path.join(CHECKS_DIR, "service-role-in-client.mjs")], expect: "exit-zero", errorExitCodes: [1, 2] },
    { argv: ["node", script, "missing.yml", "x", "absent"], expect: "exit-zero" }
  ]) {
    const check = normalizeCheck(stored);
    assert.equal(check.argv[0], "{sumi-node}");
    assert.match(check.argv[1], /^\{sumi-checks\}\//);
    assert.deepEqual(check.reproducedExitCodes, [3]);
    assert.equal(check.errorExitCodes, undefined);
  }
  assert.deepEqual(normalizeCheck({ argv: ["node", path.join(os.tmpdir(), "file-content.mjs")] }).argv[0], "node",
    "a script outside SUMI's checks directory is the user's own");

  const state = createEmptyState();
  state.patterns.push({
    id: "P001", key: "ci-node", title: "t", question: "q?", kind: "mechanical", origin: "record", severity: "medium", appliesTo: null,
    check: { argv: ["node", script, "missing.yml", "x", "absent"], cwd: "repo", timeoutMs: 30000, expect: "exit-zero" }
  });
  state.projects.app = createProject({ id: "app", name: "APP", local: gitRepo({ "a.ts": "" }) });
  const [row] = runSweep(state, {}).rows;
  assert.equal(row.outcome, "error", "exit 2 (could not check) is never a reproduction");
  assert.deepEqual(listFindings(state.projects.app), []);
});
