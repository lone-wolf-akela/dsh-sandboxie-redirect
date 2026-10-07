/**
 * Reach the DSH core packages from a plugin that lives outside the app bundle.
 *
 * Plugins under `$DSH_HOME/plugins` get no module resolution into the harness:
 * bare specifiers fail (measured). The harness's own modules live inside
 * `app.asar`, which plain Node cannot read — but the Electron host can, because
 * Electron patches `fs`. So: resolve from inside the asar with a `createRequire`
 * rooted at the harness node_modules, then import the resulting file URL.
 *
 * Measured working inside the host (Electron 44 / Node 24.18): `resolve`,
 * `import`, and even `readdirSync` inside `app.asar`.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

function resourcesRoot() {
  if (typeof process.resourcesPath === "string" && process.resourcesPath.length > 0) return process.resourcesPath;
  return path.join(path.dirname(process.execPath), "resources");
}

/** Candidate module roots, most specific first. */
export function coreModuleRoots(resources = resourcesRoot()) {
  return [
    path.join(resources, "app.asar", "dsh", "node_modules"),
    path.join(resources, "app.asar", "node_modules"),
    path.join(resources, "app.asar.unpacked", "dsh", "node_modules")
  ].filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

const cache = new Map();

/**
 * Import one harness package by name from inside the app bundle.
 * @param specifier - a bare package name (or subpath export) the harness ships.
 */
export async function importCore(specifier) {
  const cached = cache.get(specifier);
  if (cached !== undefined) return cached;
  const failures = [];
  for (const root of coreModuleRoots()) {
    try {
      const resolved = createRequire(path.join(root, "noop.js")).resolve(specifier);
      const module = await import(pathToFileURL(resolved).href);
      cache.set(specifier, module);
      return module;
    } catch (error) {
      failures.push(`${root}: ${error?.code ?? ""} ${error?.message ?? error}`);
    }
  }
  throw new Error(`cannot resolve harness package ${specifier} from ${resourcesRoot()} (${failures.join(" | ")})`);
}
