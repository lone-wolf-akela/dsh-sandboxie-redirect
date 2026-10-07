/**
 * Per-workspace box lifecycle.
 *
 * One box per (workspace, mode) pair, created lazily and idempotently:
 *   workspace-write / copy-on-write -> `dsh_<adjective>_<noun>`  (`OpenFilePath`)
 *   read-only                       -> `dshr_<adjective>_<noun>` (`ReadFilePath`)
 *
 * Two boxes rather than one because Sandboxie expresses "the workspace is
 * writable" and "the workspace is read-only" as *different settings on the box*;
 * there is no per-launch override.
 *
 * The name itself is a deterministic word pair derived from the workspace
 * (see `naming.mjs`), so no state file is needed to find a workspace's box. The
 * rare case of two workspaces hashing to the same pair is resolved by walking
 * the next candidates: a box is only adopted when its workspace access rule
 * names THIS workspace, so a foreign box is stepped over rather than hijacked.
 *
 * Everything here goes through `SbieIni.exe`, which writes `Sandboxie.ini`
 * through the Sandboxie service. That matters: the config file itself is
 * admin-only, but the service route works from an ordinary user process.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { boxNameCandidates, boxNameFor, boxRoot, canonicalWorkspace, isManagedBoxName, resolveBoxRoot, sbieSandboxRoot } from "./naming.mjs";
import { boxExists, listBoxNames, queryBoxSetting, reloadConfig, sbieExe, sbieIni, setBoxSetting } from "./sbie.mjs";

export { boxNameFor, boxNameCandidates, boxRoot, canonicalWorkspace, isManagedBoxName, sbieSandboxRoot };

/**
 * Sandboxie's configured `FileRootPath`, per box, memoized for this process:
 * asking costs an `SbieIni.exe` spawn, and the answer only changes when the user
 * edits Sandboxie's settings.
 */
const rootTemplates = new Map();
function rootTemplateFor(box) {
  if (rootTemplates.has(box)) return rootTemplates.get(box);
  let template;
  try {
    template = queryBoxSetting(box, "FileRootPath") ?? queryBoxSetting("GlobalSettings", "FileRootPath");
  } catch {
    template = undefined;
  }
  rootTemplates.set(box, template);
  return template;
}

/** Drop the memoized `FileRootPath` values (after a settings change, or in tests). */
export function invalidateRootTemplates() {
  rootTemplates.clear();
}

/**
 * Where this box's copy actually lives: Sandboxie's configured `FileRootPath`
 * when it declares one, else the default layout (or `DSH_SBIE_ROOT`).
 */
export function rootFor(box) {
  return resolveBoxRoot(box, { template: rootTemplateFor(box) });
}

/** How many name candidates to try before giving up on a collision. */
const CANDIDATE_LIMIT = 12;

/**
 * The settings a managed box carries. Anything not listed keeps Sandboxie's
 * default, which is "writes are redirected into the box" — the whole point.
 */
export function boxSettings(workspace, mode) {
  const root = canonicalWorkspace(workspace);
  return [
    ["Enabled", "y"],
    ["ConfigLevel", "10"],
    [mode === "read-only" ? "ReadFilePath" : "OpenFilePath", `${root}\\*`],
    // Deletions become recorded tombstones in the copy instead of real unlinks.
    ["UseFileDeleteV2", "y"],
    ["UseRegDeleteV2", "y"],
    // Nothing is auto-recovered: the copy stays put until a human or --manage decides.
    ["AutoRecover", "n"],
    // Headless must never raise a modal "large file" prompt.
    ["CopyLimitKb", "131072"],
    ["CopyLimitSilent", "y"]
  ];
}

function accessKeyFor(mode) {
  return mode === "read-only" ? "ReadFilePath" : "OpenFilePath";
}

/** Whether an existing box's access rule names this workspace. */
export function boxOwnedBy(box, workspace, mode) {
  const current = queryBoxSetting(box, accessKeyFor(mode));
  if (current === undefined) return false;
  return current.toLowerCase().includes(`${canonicalWorkspace(workspace)}\\*`.toLowerCase());
}

/**
 * The box name this workspace uses: the first candidate that is either free or
 * already ours.
 */
export function resolveBoxName(workspace, mode, options = {}) {
  const log = options.logger ?? (() => {});
  const candidates = boxNameCandidates(workspace, mode, CANDIDATE_LIMIT);
  for (const [index, candidate] of candidates.entries()) {
    if (!boxExists(candidate)) return candidate;
    if (boxOwnedBy(candidate, workspace, mode)) return candidate;
    log(`box ${candidate} belongs to a different workspace; trying the next name`);
    if (index === candidates.length - 1) {
      throw new Error(
        `every generated box name for ${canonicalWorkspace(workspace)} (${mode}) is taken by another workspace: ${candidates.join(", ")}`
      );
    }
  }
  throw new Error(`could not resolve a box name for ${canonicalWorkspace(workspace)}`);
}

/**
 * Create the box if needed and make sure its workspace access rule is intact.
 *
 * @param {{workspace: string, mode: "workspace-write"|"read-only", box?: string, logger?: (msg: string) => void}} request
 * @returns {{box: string, root: string, created: boolean, workspace: string, mode: string}}
 */
export function ensureBox(request) {
  const workspace = canonicalWorkspace(request.workspace);
  const mode = request.mode === "read-only" ? "read-only" : "workspace-write";
  const log = request.logger ?? (() => {});
  const box = request.box ?? resolveBoxName(workspace, mode, { logger: log });
  const root = rootFor(box);
  const accessKey = accessKeyFor(mode);
  const accessRule = `${workspace}\\*`;

  if (boxExists(box)) {
    if (!boxOwnedBy(box, workspace, mode)) {
      log(`box ${box}: workspace access rule missing or stale, rewriting`);
      setBoxSetting(box, accessKey, accessRule);
      reloadConfig();
    }
    return { box, root, created: false, workspace, mode };
  }

  log(`box ${box}: creating for ${workspace} (${mode})`);
  for (const [key, value] of boxSettings(workspace, mode)) {
    if (!setBoxSetting(box, key, value)) throw new Error(`SbieIni.exe set ${box} ${key} failed`);
  }
  reloadConfig();
  if (!boxExists(box)) {
    throw new Error(`box ${box} was written but Sandboxie does not report it (check C:\\Windows\\Sandboxie.ini)`);
  }
  return { box, root, created: true, workspace, mode };
}

/** Managed boxes (`dsh_*` / `dshr_*`, plus legacy `Dsh_<hex>`) and the workspace each shadows. */
export function listManagedBoxes() {
  const boxes = [];
  for (const name of listBoxNames()) {
    if (!isManagedBoxName(name)) continue;
    const mode = /^dshr/i.test(name) ? "read-only" : "workspace-write";
    const access = queryBoxSetting(name, "OpenFilePath") ?? queryBoxSetting(name, "ReadFilePath") ?? "";
    const root = rootFor(name);
    boxes.push({
      box: name,
      mode,
      workspace: access.replace(/\\\*$/, ""),
      root,
      exists: fs.existsSync(root),
      legacy: /_[0-9a-f]{8}$/.test(name)
    });
  }
  return boxes;
}

/**
 * Every existing managed box bound to one workspace, in both access modes —
 * both the current word-named candidates and any legacy hex-named box.
 */
export function managedBoxesFor(workspace) {
  const target = canonicalWorkspace(workspace).toLowerCase();
  const found = new Map();
  for (const mode of ["workspace-write", "read-only"]) {
    for (const candidate of boxNameCandidates(workspace, mode, CANDIDATE_LIMIT)) {
      if (!boxExists(candidate)) continue;
      if (!boxOwnedBy(candidate, workspace, mode)) continue;
      found.set(candidate, { box: candidate, mode });
    }
  }
  for (const entry of listManagedBoxes()) {
    if (entry.workspace.toLowerCase() === target) found.set(entry.box, { box: entry.box, mode: entry.mode });
  }
  return [...found.values()];
}

/** Stop every process running inside a box. */
export function terminateBox(box, options = {}) {
  const exe = options.startExe ?? sbieExe("Start.exe");
  const result = spawnSync(exe, [`/box:${box}`, "/silent", "/terminate"], { windowsHide: true, timeout: 30000 });
  return result.status === 0;
}

/** Remove a managed box: stop its processes, drop its copy tree, delete its config section. */
export function removeBox(box, options = {}) {
  const log = options.logger ?? (() => {});
  terminateBox(box, options);
  const root = rootFor(box);
  if (fs.existsSync(root)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    log(`removed ${root}`);
  }
  // Sandboxie's documented whole-section delete: `set <box> * ""` removes
  // every line of that section. (`delete <box>` only removes a value line.)
  const del = sbieIni(["set", box, "*", ""]);
  if (!del.ok) log(`note: could not drop the [${box}] section (SbieIni exit ${del.status}); it stays in Sandboxie.ini but is disabled`);
  reloadConfig();
}
