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

/** Sandboxie's default sandbox root — the PARENT of every box directory. */
export function defaultSandboxRoot(env = process.env) {
  return path.join(env.SystemDrive ?? "C:", "Sandbox", env.USERNAME ?? "user");
}

/**
 * Expand a Sandboxie `FileRootPath` into one box's own directory, for example
 * `C:\Sandbox\%USER%\%SANDBOX%` → `C:\Sandbox\<user>\dsh_able_willow`.
 *
 * The setting names the BOX's folder, `%SANDBOX%` included, and that is why a
 * template WITHOUT that placeholder is refused instead of followed: every box
 * would resolve to one shared directory, and that directory is what `--manage`
 * deletes. Returning `null` keeps the caller on the default layout — a wrong
 * path costs a missed cleanup, never a deletion of the wrong tree.
 *
 * Also `null` for an empty template, an unknown placeholder (`%SID%`, …), a
 * placeholder whose environment value is missing, or a relative result.
 */
export function expandFileRootPath(template, options = {}) {
  const env = options.env ?? process.env;
  const box = options.box;
  if (typeof template !== "string" || template.trim().length === 0) return null;
  if (typeof box !== "string" || box.length === 0) return null;
  if (!template.toLowerCase().includes("%sandbox%")) return null;

  const user = env.USERNAME ?? "user";
  const values = {
    "%USER%": user,
    "%SANDBOX%": box,
    "%SYSTEMDRIVE%": env.SystemDrive ?? "C:",
    "%USERPROFILE%": env.USERPROFILE ?? path.join(env.SystemDrive ?? "C:", "Users", user),
    "%WINDIR%": env.WINDIR ?? path.join(env.SystemDrive ?? "C:", "Windows")
  };

  let expanded = template.trim();
  for (const [token, value] of Object.entries(values)) {
    if (!expanded.toLowerCase().includes(token.toLowerCase())) continue;
    if (value.length === 0) return null;
    expanded = expanded.replace(new RegExp(token, "gi"), value);
  }

  // Any surviving placeholder belongs to Sandboxie's wider set (%SID%, %APPDATA%, …).
  if (/%[A-Za-z_]+%/.test(expanded)) return null;
  const resolved = path.normalize(expanded);
  return path.isAbsolute(resolved) ? resolved : null;
}

/**
 * The directory one box's copy lives in, in order: `DSH_SBIE_ROOT\<box>`, the
 * expanded `FileRootPath`, the default layout's `<sandbox root>\<box>`.
 *
 * @param box - the box name.
 * @param options.template - Sandboxie's `FileRootPath` for that box, when known.
 */
export function resolveBoxRoot(box, options = {}) {
  const env = options.env ?? process.env;
  const override = env.DSH_SBIE_ROOT;
  if (typeof override === "string" && override.trim().length > 0) return path.join(path.resolve(override.trim()), box);
  return expandFileRootPath(options.template, { box, env }) ?? path.join(defaultSandboxRoot(env), box);
}

/**
 * The sandbox root for this machine as far as a caller with no access to
 * Sandboxie's configuration can tell: the override, else the default layout.
 */
export function sbieSandboxRoot(env = process.env) {
  const override = env.DSH_SBIE_ROOT;
  if (typeof override === "string" && override.trim().length > 0) return path.resolve(override.trim());
  return defaultSandboxRoot(env);
}

/**
 * Where Sandboxie keeps a box's redirected (copy-on-write) tree.
 *
 * @param box - the box name.
 * @param root - an already-resolved sandbox ROOT (the parent), for callers that
 *   read Sandboxie's configuration themselves; defaults to
 *   {@link sbieSandboxRoot}. Callers holding a `FileRootPath` want
 *   {@link resolveBoxRoot} instead — that setting is the box directory itself.
 */
export function boxRoot(box, root) {
  return path.join(root ?? sbieSandboxRoot(), box);
}
