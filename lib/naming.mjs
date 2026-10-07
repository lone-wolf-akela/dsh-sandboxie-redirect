/**
 * Pure naming/geometry helpers. Deliberately free of koffi and of any DSH core
 * import, so the harness host process can load this module safely (the host
 * must not pull the FFI binding in just to render a system-prompt line).
 *
 * Box names are Docker-style word pairs derived deterministically from the
 * workspace, so every consumer — the launcher, `--manage`, and the UI — derives
 * the same name with no shared state file:
 *
 *   workspace-write / copy-on-write -> `dsh_<adjective>_<noun>`
 *   read-only                       -> `dshr_<adjective>_<noun>`
 *
 * `boxNameCandidates()` walks a deterministic sequence so a collision between
 * two workspaces resolves to the next pair instead of either sharing a box or
 * falling back to hex.
 */
import path from "node:path";
import { ADJECTIVES, NOUNS } from "./words.mjs";

/** Canonical form of a workspace path used for hashing (no trailing separator). */
export function canonicalWorkspace(workspace) {
  let resolved = path.resolve(workspace);
  if (resolved.length > 3 && resolved.endsWith(path.sep)) resolved = resolved.slice(0, -1);
  return resolved;
}

/** 64-bit FNV-1a over the UTF-8 bytes of `text`. Same algorithm in host and browser. */
export function fnv1a64(text) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash;
}

/** The box-name prefix that encodes the workspace-access mode. */
export function boxPrefix(mode) {
  return mode === "read-only" ? "dshr" : "dsh";
}

function wordsFor(key, nonce) {
  const hash = fnv1a64(nonce === 0 ? key : `${key}#${nonce}`);
  const adjective = ADJECTIVES[Number(hash % BigInt(ADJECTIVES.length))];
  const noun = NOUNS[Number((hash / BigInt(ADJECTIVES.length)) % BigInt(NOUNS.length))];
  return `${adjective}_${noun}`;
}

/** The first-choice box name (no collision handling): `dsh_brisk_otter`. */
export function boxNameFor(workspace, mode) {
  return `${boxPrefix(mode)}_${wordsFor(`${mode === "read-only" ? "ro" : "rw"}:${canonicalWorkspace(workspace).toLowerCase()}`, 0)}`;
}

/** The deterministic fallback sequence for one workspace, first choice first. */
export function boxNameCandidates(workspace, mode, count = 8) {
  const key = `${mode === "read-only" ? "ro" : "rw"}:${canonicalWorkspace(workspace).toLowerCase()}`;
  const prefix = boxPrefix(mode);
  const names = [];
  for (let nonce = 0; nonce < count; nonce += 1) {
    const name = `${prefix}_${wordsFor(key, nonce)}`;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Whether a box name is one this plugin manages — including the legacy
 * `Dsh_<8 hex>` scheme, so boxes created before the word naming stay visible
 * and cleanable in `--manage`.
 */
export function isManagedBoxName(name) {
  return /^dshr?_[a-z]+_[a-z]+$/.test(name) || /^Dshr?_[0-9a-f]{8}$/.test(name);
}

/** Sandboxie's own per-user sandbox root. */
export function sbieSandboxRoot() {
  return path.join(process.env.SystemDrive ?? "C:", "Sandbox", process.env.USERNAME ?? "user");
}

/** Where Sandboxie keeps a box's redirected (copy-on-write) tree. */
export function boxRoot(box) {
  return path.join(sbieSandboxRoot(), box);
}
