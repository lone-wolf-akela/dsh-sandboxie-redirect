/**
 * Locate a usable koffi FFI binding without owning a dependency tree.
 *
 * DSH ships koffi as a prebuilt Node-API addon under `app.asar.unpacked`, but
 * the harness install path differs per machine and per version, and the plain
 * `koffi` JS wrapper package is not always present. The addon itself is
 * self-contained, so we require the `.node` file directly.
 *
 * WHERE DSH ITSELF IS. The addon ships *inside* the installation, and this
 * module runs in the launcher — a plain Node process with no
 * `process.resourcesPath` — so the folder has to be discovered rather than
 * known. `lib/dsh-locate.mjs` does that: the interpreter's own path walked
 * upwards, the installer's uninstall entry, then the conventional locations and
 * `PATH`. Hardcoding `%LOCALAPPDATA%\Programs\DeepSeek Harness` here is what
 * made a relocated DSH report "koffi.node not found".
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { dshResourcesRoots } from "./dsh-locate.mjs";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

let cached;

/**
 * The directories the addon search starts from, most specific first: an
 * explicit override, a `vendor` folder beside the package, the DSH installation
 * this process belongs to, then the managed runtime pool.
 *
 * Everything is injectable so the ordering can be tested offline; only the
 * final directory check touches the real filesystem.
 */
export function koffiRootCandidates(options = {}) {
  const env = options.env ?? process.env;
  const isDirectory = options.isDirectory ?? ((candidate) => {
    try {
      return fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  });
  const roots = [];
  const push = (p) => {
    if (typeof p === "string" && p.length > 0 && !roots.includes(p)) roots.push(p);
  };
  push(env.DSH_SBIE_KOFFI_ROOT);
  push(path.join(here, "..", "vendor"));
  for (const dir of dshResourcesRoots({ ...options, env })) push(dir);
  push(env.DSH_HOME && path.join(env.DSH_HOME, "dsh-runtimes"));
  push(path.join(options.homeDir ?? os.homedir(), ".dsh", "dsh-runtimes"));
  return roots.filter((root) => {
    try {
      return isDirectory(root) === true;
    } catch {
      return false;
    }
  });
}

/** Depth-bounded search for a `koffi.node` under `root`. */
function findKoffiNode(root, maxDepth = 9) {
  const queue = [{ dir: root, depth: 0 }];
  let best;
  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    if (depth > maxDepth) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile()) {
        if (entry.name === "koffi.node") {
          // Prefer a win32-x64 build over any other architecture artifact.
          if (best === undefined || /win32[_-]?x64|x64/i.test(full)) best = full;
        }
      } else if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith("@") || /koffi|win32|x64|dependencies|resources|dsh/i.test(entry.name) || depth === 0) {
          queue.push({ dir: full, depth: depth + 1 });
        }
      }
    }
  }
  return best;
}

/** Resolve and load koffi once. Throws with an actionable message when absent. */
export function loadKoffi(options = {}) {
  if (cached !== undefined) return cached;
  if (process.env.DSH_SBIE_KOFFI) {
    cached = require(process.env.DSH_SBIE_KOFFI);
    return cached;
  }
  try {
    cached = require("koffi");
    return cached;
  } catch {}
  const tried = [];
  for (const root of koffiRootCandidates(options)) {
    tried.push(root);
    const found = findKoffiNode(root);
    if (found !== undefined) {
      cached = require(found);
      return cached;
    }
  }
  throw new Error(
    `koffi native addon not found. It ships inside the DeepSeek Harness installation (resources\\app.asar.unpacked), so this usually means DSH could not be located: set DSH_SBIE_KOFFI to a koffi.node path, or DSH_SBIE_KOFFI_ROOT to a folder to search. Searched: ${tried.join(", ") || "(no candidate roots)"}`
  );
}
