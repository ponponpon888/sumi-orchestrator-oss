#!/usr/bin/env node
// Literal file-content check for imported pitfall records.
//
//   node checks/file-content.mjs <target> <literal> <present|absent>
//
// Runs in the project worktree (the sweep's cwd). The meaning matches the
// pitfall database's `detection.kind: "file-content"`: <target> is one
// repository-relative file, <literal> is a plain substring (not a regex), and
// <expect> says what a project WITHOUT the problem looks like.
//
// Exit codes, chosen so that a crash can never read as a reproduction:
//   0  expectation met (clean)
//   3  expectation not met (reproduced)
//   2  could not check: bad arguments, target missing, outside the worktree,
//      too large, or not readable as UTF-8 text
//   1  Node itself failed (missing script, uncaught error)
// SUMI registers 1 and 2 as execution errors, so both leave the cell unknown.
//
// The file's content is never printed: only the target, the literal and the
// verdict, so evidence cannot carry a secret that sat next to the literal.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_BYTES = 2 * 1024 * 1024;

function unknown(reason) {
  console.log(`unknown: ${reason}`);
  process.exit(2);
}

function readWithin(root, target) {
  if (!target || target.includes("\\") || target.includes(":") || isAbsolute(target) || target.split("/").includes("..")) {
    unknown(`invalid target ${JSON.stringify(target)}; use a repository-relative path with forward slashes`);
  }
  let file;
  try {
    file = realpathSync(resolve(root, target));
  } catch {
    unknown(`target not found: ${target}`);
  }
  const rel = relative(root, file);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) unknown(`target resolves outside the worktree: ${target}`);
  const stat = statSync(file);
  if (!stat.isFile()) unknown(`target is not a regular file: ${target}`);
  if (stat.size > MAX_BYTES) unknown(`target is larger than ${MAX_BYTES} bytes: ${target}`);
  let text;
  try {
    // Fatal decoding: an unreadable file must not turn into a passing "absent".
    text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file));
  } catch {
    unknown(`target is not UTF-8 text: ${target}`);
  }
  if (text.includes("\u0000")) unknown(`target is not UTF-8 text: ${target}`);
  return text;
}

const [target, literal, expect, ...extra] = process.argv.slice(2);
if (extra.length || !literal || !["present", "absent"].includes(expect)) {
  unknown("usage: node checks/file-content.mjs <target> <literal> <present|absent>");
}

const root = realpathSync(process.cwd());
const found = readWithin(root, target).includes(literal);
const pass = found === (expect === "present");
console.log(`${pass ? "clean" : "reproduced"}: ${JSON.stringify(literal)} is ${found ? "present in" : "absent from"} ${target} (expected ${expect})`);
process.exit(pass ? 0 : 3);
