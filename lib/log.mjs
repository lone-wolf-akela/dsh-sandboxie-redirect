/**
 * Where the plugin's diagnostics live.
 *
 * NOT in the package directory. Once installed as a bundle the package sits in
 * the profile's `node_modules` — and pnpm may serve it straight out of its
 * content-addressed store — so appending logs there pollutes the install tree,
 * trips store integrity checks and can fail outright when the tree is
 * read-only. Diagnostics therefore go to a per-user state directory, with the
 * OS temp directory as the last resort.
 *
 * Node builtins only: this module is imported at the top level of halves that
 * must load in the Electron host (see the module-level import rule in
 * AGENTS.md).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** State root: `$DSH_HOME/state`, which is `~/.dsh/state` by default. */
function stateRoot() {
  const home = process.env.DSH_HOME;
  if (typeof home === "string" && home.length > 0) return path.join(home, "state");
  return path.join(os.homedir(), ".dsh", "state");
}

/**
 * Candidate directories, in order: an explicit override (used by the tests so
 * they never touch a real user's state), the state root, then temp.
 */
function candidates() {
  const override = process.env.DSH_SBIE_LOG_DIR;
  const list = [];
  if (typeof override === "string" && override.length > 0) list.push(override);
  list.push(path.join(stateRoot(), "dsh-sandboxie-redirect"));
  list.push(path.join(os.tmpdir(), "dsh-sandboxie-redirect"));
  return list;
}

/**
 * The absolute path of one diagnostic file, creating its directory on the way.
 *
 * Never throws: a plugin that cannot write a log still has to run. When every
 * candidate directory is unusable the last path is returned anyway, so the
 * caller's own try/catch around the write is what finally swallows the error.
 */
export function logFile(name) {
  const tried = candidates();
  for (const dir of tried) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.statSync(dir).isDirectory()) return path.join(dir, name);
    } catch {
      /* try the next candidate */
    }
  }
  return path.join(tried[tried.length - 1], name);
}

/** The directory the diagnostics currently land in, for docs and diagnostics. */
export function logDirectory() {
  return path.dirname(logFile("host.log"));
}
