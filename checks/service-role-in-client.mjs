#!/usr/bin/env node
// Can the Supabase service role key reach the browser?
//
//   node checks/service-role-in-client.mjs
//
// Runs in the project worktree (the sweep's cwd) and reports two shapes:
//
//   A. A browser-exposed environment variable whose name contains SERVICE_ROLE
//      (NEXT_PUBLIC_, VITE_, PUBLIC_, EXPO_PUBLIC_, NUXT_PUBLIC_, REACT_APP_).
//      Bundlers inline these into client code at build time, so the name alone
//      is the leak. Source files and .env* files are both read.
//   B. A module whose first statement is the "use client" directive and that
//      mentions service_role. Anything such a module touches ships to the browser.
//
// Files come from git, not from walking directories: every tracked file,
// including those of checked-out submodules, plus git-ignored .env* files
// (where local keys live). Nothing is skipped by directory name, so
// src/app/build/page.tsx is read like any other file. Test files (*.test.*,
// *.spec.*, __tests__/, __mocks__/) are not read: they do not ship.
//
// Every occurrence is a hit, including ones on lines that look like
// comments: those are labelled, never dropped (see commentLabeler). A false
// hit is dismissed once and stays dismissed; a hidden leak is never seen.
//
// Fail-closed: a file that cannot be read (too large, a symlink leading out
// of the worktree, a submodule that is not checked out) or a worktree with
// nothing to read makes the run "could not check" unless another file
// already reproduced the leak.
//
// Only the file, line and variable name are printed. Never the line itself:
// a .env file holds the value on the same line, and sweep evidence is kept.
//
// Exit codes: 0 clean, 3 reproduced, 2 could not check. SUMI treats every
// other exit (a Node failure, a crash) as an execution error as well.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i;
const ENV_FILE = /^\.env(?:\..+)?$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const TEST_DIRS = new Set(["__tests__", "__mocks__"]);
const MAX_BYTES = 50 * 1024 * 1024;

const PUBLIC_SERVICE_ROLE = /\b(?:NEXT_PUBLIC|VITE|PUBLIC|EXPO_PUBLIC|NUXT_PUBLIC|REACT_APP)_[A-Z0-9_]*SERVICE_ROLE[A-Z0-9_]*\b/g;
const SERVICE_ROLE_MENTION = /service_role/i;
// Files are read as latin1, where a UTF-8 BOM appears as these three chars.
const BOM = "ï»¿";

// git runs from this script's own directory, never from the worktree: on
// Windows a bare command name is looked up in the working directory before
// PATH, and a git.exe committed to the project must not be what runs.
const TRUSTED_CWD = dirname(fileURLToPath(import.meta.url));

function couldNotCheck(reason) {
  console.log(`unknown: ${reason}`);
  process.exit(2);
}

function gitList(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { cwd: TRUSTED_CWD, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (result.status !== 0) couldNotCheck(`git ${args.join(" ")} failed: ${(result.stderr || result.error?.message || "").trim()}`);
  return result.stdout.split("\0").filter(Boolean);
}

function basename(file) {
  return file.slice(file.lastIndexOf("/") + 1);
}

function isTestFile(file) {
  return TEST_FILE.test(basename(file)) || file.split("/").some((segment) => TEST_DIRS.has(segment));
}

function listFiles(root, unreadable) {
  const tracked = gitList(root, ["ls-files", "-z", "--recurse-submodules"]);
  // --recurse-submodules lists nothing for a submodule that is not checked
  // out, which would otherwise look exactly like an empty, clean directory.
  for (const entry of gitList(root, ["ls-files", "-z", "-s"])) {
    const match = /^160000 [0-9a-f]+ \d+\t(.+)$/.exec(entry);
    if (match && !existsSync(join(root, ...match[1].split("/"), ".git"))) {
      unreadable.push(`${match[1]} is a git submodule that is not checked out`);
    }
  }
  // --directory folds an ignored directory into one entry, so node_modules/
  // costs one line; only .env* files that are themselves listed are kept.
  const ignoredEnv = gitList(root, ["ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory"])
    .filter((file) => !file.endsWith("/") && ENV_FILE.test(basename(file)));
  return [...new Set([...tracked, ...ignoredEnv])]
    .filter((file) => (SOURCE_EXT.test(file) || ENV_FILE.test(basename(file))) && !isTestFile(file))
    .sort();
}

function readInside(root, file) {
  const full = join(root, ...file.split("/"));
  let real;
  try {
    real = lstatSync(full).isSymbolicLink() ? realpathSync(full) : full;
  } catch {
    return { error: "cannot be read" };
  }
  const rel = relative(root, real);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { error: "is a symlink leading out of the worktree" };
  let stat;
  try {
    stat = statSync(real);
  } catch {
    return { error: "cannot be read" };
  }
  if (!stat.isFile()) return { error: "is not a regular file" };
  if (stat.size > MAX_BYTES) return { error: `is larger than ${MAX_BYTES} bytes` };
  // The patterns are ASCII, so working on bytes (decoded as latin1) finds
  // them whatever the file's encoding is.
  return { bytes: readFileSync(real) };
}

/** Line lookups in one pass: the offsets of every newline, searched by bisection. */
function lineIndex(text) {
  const breaks = [];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) breaks.push(i);
  const lineNumber = (index) => {
    let lo = 0;
    let hi = breaks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (breaks[mid] < index) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
  const lineAt = (index) => {
    const line = lineNumber(index);
    const start = line === 1 ? 0 : breaks[line - 2] + 1;
    const end = line - 1 < breaks.length ? breaks[line - 1] : text.length;
    return { line, start, end };
  };
  return { lineNumber, lineAt };
}

/**
 * Does the line holding `index` look like a comment? This only LABELS a hit;
 * it never drops one. Whether a line is really a comment depends on parser
 * state (a template literal, a generator method, JSX or a Vue template can
 * put code on a line that starts with * or //), and every way of guessing it
 * has hidden real leaks. A false hit is dismissed once and stays dismissed;
 * a dropped one would never be seen. Computed once per line.
 */
function commentLabeler(text, { lineAt }, isEnv) {
  const cache = new Map();
  return (index) => {
    const { line, start, end } = lineAt(index);
    if (!cache.has(line)) {
      const body = text.slice(start, end).trimStart();
      cache.set(line, isEnv ? body.startsWith("#") : body.startsWith("//") || body.startsWith("/*") || body.startsWith("*"));
    }
    return cache.get(line) ? " (on a line that looks like a comment; dismiss the finding if it is one)" : "";
  };
}

/**
 * Does the module start with the "use client" directive? Only the prefix is
 * read: a BOM, whitespace, // lines and complete block comments may come
 * before it, nothing else. One indexOf per comment, so the cost is linear.
 */
function startsWithUseClient(text) {
  let i = text.startsWith(BOM) ? BOM.length : 0;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text.startsWith("//", i)) {
      const nl = text.indexOf("\n", i);
      if (nl < 0) return false;
      i = nl + 1;
      continue;
    }
    if (text.startsWith("/*", i)) {
      const close = text.indexOf("*/", i + 2);
      if (close < 0) return false;
      i = close + 2;
      continue;
    }
    return text.startsWith("\"use client\"", i) || text.startsWith("'use client'", i);
  }
}

function scan(root) {
  const unreadable = [];
  const files = listFiles(root, unreadable);
  if (!files.length && !unreadable.length) couldNotCheck("no JavaScript/TypeScript or .env files to read; this check cannot answer for this project");
  const hits = [];
  let scanned = 0;
  for (const file of files) {
    const read = readInside(root, file);
    if (read.error) {
      unreadable.push(`${file} ${read.error}`);
      continue;
    }
    scanned++;
    // Bytes decoded as latin1: the patterns are ASCII, so this finds them
    // whatever the file's encoding is.
    const text = read.bytes.toString("latin1");
    const isEnv = ENV_FILE.test(basename(file));
    const lines = lineIndex(text);
    const label = commentLabeler(text, lines, isEnv);
    for (const match of text.matchAll(PUBLIC_SERVICE_ROLE)) {
      const line = lines.lineNumber(match.index);
      hits.push({ file, line, text: `${file}:${line}: browser-exposed variable ${match[0]} names the service role${label(match.index)}` });
    }
    if (!isEnv && startsWithUseClient(text)) {
      const mention = SERVICE_ROLE_MENTION.exec(text);
      if (mention) {
        const line = lines.lineNumber(mention.index);
        hits.push({ file, line, text: `${file}:${line}: "use client" module mentions service_role${label(mention.index)}` });
      }
    }
  }
  const byFileAndLine = (a, b) => a.file.localeCompare(b.file) || a.line - b.line;
  return { scanned, unreadable, hits: hits.sort(byFileAndLine).map((hit) => hit.text) };
}

let result;
try {
  result = scan(realpathSync(process.cwd()));
} catch (error) {
  couldNotCheck(`could not scan the worktree: ${error.message}`);
}

const unreadableNote = result.unreadable.length
  ? `${result.unreadable.length} file(s) could not be read: ${result.unreadable.slice(0, 10).join("; ")}${result.unreadable.length > 10 ? `; and ${result.unreadable.length - 10} more` : ""}`
  : "";
// A hit in a file that was read is a reproduction whatever else could not be
// read. Without a hit, an unread file means the answer is unknown, not clean.
if (!result.hits.length && unreadableNote) couldNotCheck(`${unreadableNote}; a clean answer is not possible`);
// Print a bounded number of hits. A file with thousands of them must still
// come back as a reproduction, not overflow the sweep's output buffer and be
// read as a check that died.
const MAX_PRINTED = 50;
for (const hit of result.hits.slice(0, MAX_PRINTED)) console.log(hit);
if (result.hits.length > MAX_PRINTED) console.log(`... and ${result.hits.length - MAX_PRINTED} more hit(s)`);
console.log(`${result.hits.length ? "reproduced" : "clean"}: ${result.hits.length} hit(s) in ${result.scanned} file(s)${unreadableNote ? `; ${unreadableNote}` : ""}`);
process.exit(result.hits.length ? 3 : 0);
