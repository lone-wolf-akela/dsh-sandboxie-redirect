/**
 * The copy-on-write preset, as pure values and functions.
 *
 * No core import, no koffi: this module is unit-testable with plain Node and is
 * the single source of truth for the preset id, the redirect argv shape, the
 * node-path search, and the model-facing explanation.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { boxNameFor, boxRoot, canonicalWorkspace } from "./naming.mjs";

/**
 * The preset id that selects copy-on-write. It is written into the session log
 * (`permission/preset` events and the `permissions` projection), so it is a
 * compatibility surface: renaming it later makes existing sessions fall back to
 * `custom` instead of matching.
 */
export const REDIRECT_PRESET = "copy-on-write";

/** Signatures this runner's own failures speak (must match the profile's runnerFailureSignatures). */
export const RUNNER_FATAL_SIGNATURE = "dsh-sbie-run: ";

/**
 * Whether a session's folded `permissions` state selects copy-on-write.
 * Anything other than an exact preset match is NOT copy-on-write, so every
 * unexpected shape fails back to the stock workspace-write behaviour.
 */
export function isRedirectPresetState(state) {
  return state?.preset === REDIRECT_PRESET;
}

/**
 * Every place a genuine `node.exe` may live, most specific first.
 *
 * `process.execPath` is deliberately NOT a candidate while the host is
 * Electron: there it is the Electron binary, and starting the launcher with it
 * would put the native Sandboxie work back into an Electron process — the very
 * thing this design avoids. Under a plain-Node host (the source-execution path)
 * it IS a genuine node and is used.
 *
 * Order matters. The desktop app ships its own Node under its `resources`
 * directory, which is user-relocatable and therefore only reachable through
 * `process.resourcesPath`. The managed-runtime pool under the DSH home comes
 * second, because this build provisions it lazily, only when something asks for
 * it — a fresh machine may not have it yet.
 */
export function nodeCandidates(options = {}) {
  const env = options.env ?? process.env;
  const exists = options.exists ?? fs.existsSync;
  const found = [];
  const push = (candidate) => {
    if (typeof candidate !== "string" || candidate.length === 0) return;
    if (found.includes(candidate)) return;
    try {
      if (exists(candidate)) found.push(candidate);
    } catch {
      /* an unreadable candidate is simply not a candidate */
    }
  };

  push(env.DSH_SBIE_NODE);

  const resources = typeof options.resourcesPath === "string"
    ? options.resourcesPath
    : (typeof process.resourcesPath === "string" ? process.resourcesPath : undefined);
  if (resources !== undefined) {
    push(path.join(resources, "runtime", "primary-runtime", "dependencies", "node", "bin", "node.exe"));
  }

  const home = options.homeDir ?? os.homedir();
  const dshHome = typeof env.DSH_HOME === "string" && env.DSH_HOME.length > 0 ? env.DSH_HOME : path.join(home, ".dsh");
  const runtimes = path.join(dshHome, "dsh-runtimes");
  let entries = [];
  try {
    entries = fs.readdirSync(runtimes);
  } catch {
    /* no runtime pool on this machine (yet) */
  }
  for (const entry of entries) {
    push(path.join(runtimes, entry, "dependencies", "node", "bin", "node.exe"));
  }

  const electron = options.isElectron ?? (typeof process.versions?.electron === "string");
  if (electron === false) push(options.execPath ?? process.execPath);

  return found;
}

/**
 * The one node to run the launcher with, or `null` when this machine offers
 * none.
 *
 * `null` is a hard failure and the caller has to say so: there is NO safe
 * fallback. An Electron binary is not a Node, and using it silently would fail
 * later, inside the box, in a way nobody can attribute.
 */
export function resolveNodePath(options = {}) {
  return nodeCandidates(options)[0] ?? null;
}

/**
 * The redirect invocation DSH hands to the sandbox provider.
 *
 * Explicit flags rather than the bubblewrap dialect: the launcher then reads
 * the workspace and the mode directly instead of inferring them from
 * `--bind <ws> <ws>`.
 */
export function redirectArgv(request) {
  const workspace = canonicalWorkspace(request.workspace);
  return [
    request.nodePath,
    request.launcherPath,
    "--workspace",
    workspace,
    "--mode",
    "workspace-write",
    "--",
    ...request.argv
  ];
}

/** The copy-on-write redirect facts reported to the sandbox seam. */
export function redirectWrap(request) {
  return {
    argv: redirectArgv(request),
    enforcement: "full",
    denialSignatures: ["read-only file system", "permission denied"],
    runnerFailureRules: [{ fatalSignatures: [RUNNER_FATAL_SIGNATURE] }]
  };
}

/**
 * The model-facing explanation for a copy-on-write session.
 *
 * This is the ONLY channel that reaches a future agent automatically: it is
 * contributed as a per-session system-prompt context, so it is present on every
 * request while the preset is selected and absent otherwise. It carries the
 * operating rules an agent cannot infer from the sandbox's behaviour — the
 * ones that otherwise cost a hung command or a wrong conclusion about whether
 * the real disk changed. Full detail (and the reasoning) lives in README.zh.md.
 *
 * @param cwd - the session workspace; the box root shown to the model is derived from it.
 * @param root - the copy root, when the caller could read Sandboxie's configured
 *   sandbox folder; omitted, the default layout is named instead.
 */
export function redirectPolicyNote(cwd, root) {
  const workspace = canonicalWorkspace(cwd ?? process.cwd());
  const copyRoot = typeof root === "string" && root.length > 0 ? root : boxRoot(boxNameFor(workspace, "workspace-write"));
  return [
    "This session's file policy is copy-on-write (copy-on-write preset) for shell commands:",
    `- Writes under the workspace (${JSON.stringify(workspace)}) go to the real disk as usual.`,
    `- Writes, edits and deletes ANYWHERE ELSE still succeed, but only inside this workspace's Sandboxie copy at ${JSON.stringify(copyRoot)}; the real files outside the workspace are not touched.`,
    "- Deletions outside the workspace leave the real file in place and only record a tombstone in that copy.",
    "",
    "Operating rules for this mode:",
    "- Reading back an out-of-workspace write: read it WITH A SHELL COMMAND (the sandbox merges the copy for you). The harness read/write/edit file tools run OUTSIDE the sandbox, so they see the real disk and still refuse writes outside the workspace. Never conclude \"the write did not happen\" from a host-side read tool — and never conclude \"it leaked to the real disk\" from a shell `Test-Path`, which sees the merged view. Host tools see reality; shell commands see the copy.",
    "- The box name and root are resolved against Sandboxie's own state (a name already owned by another workspace steps to the next candidate), so do NOT derive them from the workspace path. Inside a command, `$env:DSH_SBIE_BOX` and `$env:DSH_SANDBOX_ROOT` are authoritative.",
    "- Escalation (`sandbox_permissions` together with `justification`) runs ONE call entirely OUTSIDE the box, against the real disk; the next call is back in the box.",
    `- That parameter's own description — \"the narrowest wider sandbox mode for a one-shot retry of the exact command the sandbox just denied\" — is written for the ACL presets (read-only / workspace-write), where a denial comes first. Under copy-on-write nothing outside the workspace is ever denied: the write succeeds into the copy, no \`[sandbox: file access denied under … mode]\` marker appears, and there is no denied command to retry. So do not wait for such a marker before escalating, and do not read the absence of one as \"the real disk was written\". Choose escalation deliberately: it is the lever for a call that must genuinely act on the real disk (installing or configuring something outside the workspace, or replacing a stale copy with reality), it is never a way to make a single file real, and it is not needed to READ the real disk — the host-side file tools already read it.`,
    "- The same redirection silently captures anything you INSTALL or CONFIGURE outside the workspace from a command — a plugin under `~/.dsh/plugins`, a profile file, any config edit. The write reports success, lands in the copy, and an in-box read-back confirms it, so the real file keeps its old contents while every check you can run from inside the box says otherwise. Judge such a change with a HOST-SIDE read, or make it through escalation; `tools/install.mjs` refuses to run inside a box for exactly this reason.",
    "- Inside a command, never enumerate or walk `C:\\Sandbox\\`: that is the box's own storage, and walking it recurses into the redirection layer and hangs. Inspect the copy with host-side tools instead.",
    "- `--manage` and any nested launch of `bin/dsh-sbie-run.mjs` need Sandboxie's API, and Sandboxie hides the box list from a process that is itself inside a box. Run those from a `danger-full-access` session (or a plain console), not from a shell command here.",
    "",
    "- The copy is not auto-recovered. It can be inspected, recovered or discarded from the Sandboxie SandMan window, or removed with `--manage clean`."
  ].join("\n");
}
