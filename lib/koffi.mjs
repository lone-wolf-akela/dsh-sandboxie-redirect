/**
 * Locate a usable koffi FFI binding without owning a dependency tree.
 *
 * DSH ships koffi as a prebuilt Node-API addon under `app.asar.unpacked`, but
 * the harness install path differs per machine and per version, and the plain
 * `koffi` JS wrapper package is not always present. The addon itself is
 * self-contained, so we require the `.node` file directly.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

let cached;

function candidateRoots() {
  const roots = [];
  const push = (p) => {
    if (typeof p === "string" && p.length > 0 && !roots.includes(p)) roots.push(p);
  };
  push(process.env.DSH_SBIE_KOFFI_ROOT);
  push(path.join(here, "..", "vendor"));
  push(process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "DeepSeek Harness", "resources", "app.asar.unpacked"));
  push(process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "DeepSeek Harness", "resources"));
  push(process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "DeepSeek Harness", "resources", "app.asar.unpacked"));
  push(process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "DeepSeek Harness", "resources", "app.asar.unpacked"));
  push(process.env.DSH_HOME && path.join(process.env.DSH_HOME, "dsh-runtimes"));
  push(path.join(os.homedir(), ".dsh", "dsh-runtimes"));
  return roots.filter((r) => {
    try {
      return fs.statSync(r).isDirectory();
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
export function loadKoffi() {
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
  for (const root of candidateRoots()) {
    tried.push(root);
    const found = findKoffiNode(root);
    if (found !== undefined) {
      cached = require(found);
      return cached;
    }
  }
  throw new Error(
    `koffi native addon not found. Set DSH_SBIE_KOFFI to a koffi.node path. Searched: ${tried.join(", ") || "(no candidate roots)"}`
  );
}
