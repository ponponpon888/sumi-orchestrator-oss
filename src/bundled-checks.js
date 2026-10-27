import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Checks that ship with SUMI are stored location-independently:
 *
 *   ["{sumi-node}", "{sumi-checks}/file-content.mjs", ...args]
 *
 * and resolved only when a sweep runs them. Two reasons:
 *
 * - The pattern fingerprint and the import digest must not change when SUMI is
 *   installed somewhere else, or every sweep result would turn stale.
 * - `{sumi-node}` is the Node binary running SUMI itself (process.execPath),
 *   spawned directly. A PATH lookup of `node` inside the project worktree
 *   would let that project's .nvmrc / .tool-versions / volta pin, a version
 *   manager shim, or a node.bat in the worktree decide what runs, and a shim
 *   that fails exits with a code that must not be read as a verdict.
 */
export const BUNDLED_NODE = "{sumi-node}";
export const BUNDLED_PREFIX = "{sumi-checks}/";
export const CHECKS_DIR = fileURLToPath(new URL("../checks/", import.meta.url));

// The contract every bundled script keeps: 0 clean, 3 reproduced, anything
// else (2 = could not check, a Node failure, a crash) an execution error.
export const BUNDLED_REPRODUCED_EXIT_CODES = Object.freeze([3]);

const BUNDLED_SCRIPT = /^\{sumi-checks\}\/[a-z0-9]+(?:-[a-z0-9]+)*\.mjs$/;

export function isBundledArgv(argv) {
  return Array.isArray(argv) && argv[0] === BUNDLED_NODE;
}

/**
 * The placeholders are only meaningful in exactly one shape. Anywhere else
 * they would be passed to a user-authored command verbatim, so refuse them.
 */
export function validateBundledArgv(argv) {
  const placeholders = argv
    .map((arg, index) => ({ arg, index }))
    .filter(({ arg }) => arg.includes("{sumi-"));
  if (!placeholders.length) return;
  if (argv[0] !== BUNDLED_NODE || !BUNDLED_SCRIPT.test(argv[1] || "")) {
    throw new Error(`Pattern check placeholders are only valid as "${BUNDLED_NODE} ${BUNDLED_PREFIX}<name>.mjs ...".`);
  }
  const stray = placeholders.filter(({ index }) => index > 1);
  if (stray.length) throw new Error(`Pattern check placeholder in an argument position: ${stray[0].arg}`);
}

/**
 * What a bundled check runs is the script's content, not its argv, so the
 * sweep fingerprint includes this digest: upgrading SUMI with a changed
 * check turns earlier answers into RECHECK REQUIRED instead of keeping a
 * "clean" the new check might not agree with.
 */
export function bundledScriptDigest(argv) {
  const script = path.join(CHECKS_DIR, String(argv[1] || "").slice(BUNDLED_PREFIX.length));
  try {
    const text = fs.readFileSync(script, "utf8").replace(/\r\n/g, "\n");
    return createHash("sha256").update(text).digest("hex");
  } catch {
    return "missing";
  }
}

const NODE_COMMAND = /^node(?:\.exe)?$/i;
const SCRIPT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.mjs$/;

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * A bundled script named by its absolute path ("node <install>/checks/x.mjs",
 * the form an early build stored, or one typed by hand) is still a bundled
 * script and keeps the same exit contract. It is rewritten to the
 * placeholder form; any other argv is returned unchanged.
 */
export function canonicalBundledArgv(argv) {
  if (!Array.isArray(argv) || argv.length < 2 || isBundledArgv(argv)) return argv;
  if (!NODE_COMMAND.test(path.basename(argv[0])) || !path.isAbsolute(argv[1])) return argv;
  if (!samePath(path.dirname(argv[1]), CHECKS_DIR)) return argv;
  const name = path.basename(argv[1]);
  return SCRIPT_NAME.test(name) ? bundledArgv(name, argv.slice(2)) : argv;
}

export function bundledArgv(script, args = []) {
  return [BUNDLED_NODE, `${BUNDLED_PREFIX}${script}`, ...args];
}

/**
 * Turn a stored bundled argv into the command to spawn. A missing script is
 * an error before anything runs, never a process that exits non-zero.
 */
export function resolveBundledInvocation(argv) {
  validateBundledArgv(argv);
  const script = path.join(CHECKS_DIR, argv[1].slice(BUNDLED_PREFIX.length));
  if (!fs.existsSync(script)) return { error: `bundled check not found: ${script}` };
  return { command: process.execPath, args: [script, ...argv.slice(2)] };
}
