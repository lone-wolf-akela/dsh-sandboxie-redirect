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
 * Locate a real `node.exe` to run the launcher with.
 *
 * `process.execPath` in the Electron host is the Electron binary, not Node, so
 * it is only the last resort. The harness's managed runtime ships a genuine
 * node and is what the profile's runnerCommand already used.
 */
export function resolveNodePath(options = {}) {
  const env = options.env ?? process.env;
  const exists = options.exists ?? fs.existsSync;
  if (typeof env.DSH_SBIE_NODE === "string" && exists(env.DSH_SBIE_NODE)) return env.DSH_SBIE_NODE;

  const runtimes = path.join(options.homeDir ?? os.homedir(), ".dsh", "dsh-runtimes");
  let entries = [];
  try {
    entries = fs.readdirSync(runtimes);
  } catch {}
  for (const entry of entries) {
    const candidate = path.join(runtimes, entry, "dependencies", "node", "bin", "node.exe");
    if (exists(candidate)) return candidate;
  }
  return options.execPath ?? process.execPath;
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
 */
export function redirectPolicyNote(cwd) {
  const workspace = canonicalWorkspace(cwd ?? process.cwd());
  const root = boxRoot(boxNameFor(workspace, "workspace-write"));
  return [
    "This session's file policy is copy-on-write (copy-on-write preset) for shell commands:",
    `- Writes under the workspace (${JSON.stringify(workspace)}) go to the real disk as usual.`,
    `- Writes, edits and deletes ANYWHERE ELSE still succeed, but only inside this workspace's Sandboxie copy at ${JSON.stringify(root)}; the real files outside the workspace are not touched.`,
    "- Deletions outside the workspace leave the real file in place and only record a tombstone in that copy.",
    "",
    "Operating rules for this mode:",
    "- Reading back an out-of-workspace write: read it WITH A SHELL COMMAND (the sandbox merges the copy for you). The harness read/write/edit file tools run OUTSIDE the sandbox, so they see the real disk and still refuse writes outside the workspace. Never conclude \"the write did not happen\" from a host-side read tool — and never conclude \"it leaked to the real disk\" from a shell `Test-Path`, which sees the merged view. Host tools see reality; shell commands see the copy.",
    "- The box name and root are resolved against Sandboxie's own state (a name already owned by another workspace steps to the next candidate), so do NOT derive them from the workspace path. Inside a command, `$env:DSH_SBIE_BOX` and `$env:DSH_SANDBOX_ROOT` are authoritative.",
    "- Escalation via `sandbox_permissions` does NOT open a hole in the box: that one call runs entirely OUTSIDE it, with full access to the real disk, and the next call is back in the box. It is not a way to make a single file real.",
    "- The same redirection silently captures anything you INSTALL or CONFIGURE outside the workspace from a command — a plugin under `~/.dsh/plugins`, a profile file, any config edit. The write reports success, lands in the copy, and an in-box read-back confirms it, so the real file keeps its old contents while every check you can run from inside the box says otherwise. Judge such a change with a HOST-SIDE read, or make it through escalation; `tools/install.mjs` refuses to run inside a box for exactly this reason.",
    "- Inside a command, never enumerate or walk `C:\\Sandbox\\`: that is the box's own storage, and walking it recurses into the redirection layer and hangs. Inspect the copy with host-side tools instead.",
    "- `--manage` and any nested launch of `bin/dsh-sbie-run.mjs` need Sandboxie's API, and Sandboxie hides the box list from a process that is itself inside a box. Run those from a `danger-full-access` session (or a plain console), not from a shell command here.",
    "",
    "- The copy is not auto-recovered. It can be inspected, recovered or discarded from the Sandboxie SandMan window, or removed with `--manage clean`."
  ].join("\n");
}
