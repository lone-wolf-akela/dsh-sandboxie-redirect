/**
 * Find where DeepSeek Harness itself is installed.
 *
 * `koffi.node` does not come from npm: it ships *inside* the DSH installation,
 * as an unpacked native addon under `resources\app.asar.unpacked`. The launcher
 * that needs it is a plain Node process, so it has no `process.resourcesPath`
 * and no idea where the app that started it lives. `lib/koffi.mjs` used to
 * assume `%LOCALAPPDATA%\Programs\DeepSeek Harness` (and the two `%ProgramFiles%`
 * spellings), which fails the moment DSH is installed anywhere else — exactly
 * like the Sandboxie folder assumption this plugin already had to drop.
 *
 * Four sources, most trustworthy first:
 *
 *  1. `process.resourcesPath` — present when this runs inside Electron; the
 *     direct answer.
 *  2. `process.execPath` walked upwards. The host picks the launcher's Node
 *     through `redirect.mjs`'s `resolveNodePath()`, which prefers the runtime
 *     shipped *inside* the app; when that is what is running, its own path
 *     points straight back at the installation.
 *  3. The uninstall entry the installer writes. It lives under a generated key
 *     (`…\Uninstall\<GUID>`), so it is found by searching that hive for the
 *     display name, and `InstallLocation` / `DisplayIcon` / `UninstallString`
 *     are all accepted as evidence — the per-user installer only guarantees
 *     some of them.
 *  4. The conventional folders and `PATH`, for an installation that was
 *     unpacked by hand.
 *
 * WHY THIS MODULE IMPORTS ONLY NODE BUILTINS. `lib/koffi.mjs` imports it, and
 * `lib/sbie-locate.mjs` imports `lib/koffi.mjs`; reaching back into either from
 * here would close a cycle through the very loader this module exists to feed.
 * The few small helpers it needs are therefore repeated rather than shared, and
 * every side effect is injectable so the whole resolver is testable offline.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The executable that names a DSH installation folder. */
export const DSH_EXE = "DeepSeek Harness.exe";
/** The name the installer's uninstall entry carries (`DeepSeek Harness 0.2.0-rc.2`). */
export const DSH_DISPLAY_NAME = "DeepSeek Harness";
/** The folder name an installation uses by default (`%LOCALAPPDATA%\Programs\DeepSeek Harness`). */
export const DSH_DIR_NAME = "DeepSeek Harness";

/**
 * The uninstall hives an installer may have used. A per-user install lands in
 * HKCU; a machine-wide one in HKLM, in the view matching the installer's
 * bitness. Nothing fixed can be queried, because the subkey is a GUID.
 */
export const DSH_UNINSTALL_KEYS = [
  "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall"
];

/** Environment lookup that is case-insensitive, like Windows' own. */
function envLookup(env, name) {
  if (env === undefined || env === null) return undefined;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() !== wanted) continue;
    const value = env[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** Replace `%NAME%` references; unknown names are left alone (they simply fail validation later). */
export function expandEnvRefs(value, env = process.env) {
  return String(value).replace(/%([^%]+)%/g, (whole, name) => envLookup(env, name) ?? whole);
}

/** De-duplicate case-insensitively, keeping each first occurrence's spelling. */
export function uniqueDirs(dirs) {
  const seen = new Set();
  const unique = [];
  for (const dir of dirs ?? []) {
    if (typeof dir !== "string" || dir.length === 0) continue;
    const key = dir.replace(/[\\/]+$/, "").toLowerCase();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    unique.push(dir);
  }
  return unique;
}

function existsWith(exists, candidate) {
  try {
    return exists(candidate) === true;
  } catch {
    return false;
  }
}

const has = (exists, ...parts) => existsWith(exists, path.join(...parts));

/**
 * Whether `dir` is a DSH installation folder: it holds the app bundle (packed or
 * unpacked) under `resources`, or the launcher executable itself.
 */
export function isDshInstallRoot(dir, options = {}) {
  const exists = options.exists ?? fs.existsSync;
  if (typeof dir !== "string" || dir.length === 0) return false;
  return (
    has(exists, dir, "resources", "app.asar") ||
    has(exists, dir, "resources", "app.asar.unpacked") ||
    has(exists, dir, DSH_EXE)
  );
}

/**
 * The folders under which the koffi addon may be searched, given either a DSH
 * installation folder or DSH's `resources` folder (or its `app.asar.unpacked`
 * itself). Empty when the candidate is neither — which is what makes an
 * unvalidated guess safe.
 *
 * `app.asar.unpacked` comes first because that is where the addon actually is;
 * the plain `resources` folder is included as well, because the search under it
 * can still reach a payload that lives beside the packed bundle.
 */
export function resourcesDirsFor(candidate, options = {}) {
  const exists = options.exists ?? fs.existsSync;
  if (typeof candidate !== "string" || candidate.length === 0) return [];
  const base = path.basename(candidate).toLowerCase();

  // Already the unpacked payload — which is where the addon actually lives.
  if (base === "app.asar.unpacked") return [candidate];

  // Already DSH's `resources` folder.
  if (base === "resources" && (has(exists, candidate, "app.asar") || existsWith(exists, path.join(candidate, "app.asar.unpacked")))) {
    return [path.join(candidate, "app.asar.unpacked"), candidate];
  }

  // An installation folder — the packed bundle, the unpacked payload or the
  // executable is evidence enough.
  const resources = path.join(candidate, "resources");
  const unpacked = path.join(resources, "app.asar.unpacked");
  if (has(exists, resources, "app.asar") || existsWith(exists, unpacked)) return [unpacked, resources];
  if (has(exists, candidate, DSH_EXE)) return [unpacked, resources];
  return [];
}

/**
 * Installation folders implied by the interpreter running this code: walk up
 * from `node.exe` (or the Electron binary) and keep every ancestor that looks
 * like a DSH installation. The app ships its Node under
 * `resources\runtime\<pool>\dependencies\node\bin\node.exe`, so this is a
 * pointer, not a guess, whenever the host chose that Node.
 */
export function execPathInstallRoots(execPath, options = {}) {
  if (typeof execPath !== "string" || execPath.length === 0) return [];
  const maxUp = options.maxUp ?? 8;
  const roots = [];
  let dir = path.dirname(path.resolve(execPath));
  for (let index = 0; index < maxUp; index += 1) {
    if (isDshInstallRoot(dir, options)) roots.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached the drive root
    dir = parent;
  }
  return roots;
}

/** One `reg query` value line: `<name>\t<type>\t<data>`, tabs printed as two or more spaces. */
export function parseRegValueLine(line) {
  const match = /^\s{2,}(\S.*?)\s{2,}(REG_[A-Z_]+)\s{2,}(.*)$/.exec(String(line));
  if (match === null) return undefined;
  return { name: match[1].trim().toLowerCase(), type: match[2], value: match[3].trim() };
}

/** Strip the quotes Windows installers put around paths, and any trailing argument. */
function unquoteExecutable(value) {
  const text = String(value).trim();
  if (text.startsWith('"')) {
    const end = text.indexOf('"', 1);
    if (end !== -1) return text.slice(1, end);
  }
  return text.replace(/\s+\/\S+$/, "");
}

/**
 * Installation folders named by an uninstall hive's output.
 *
 * The search prints the whole matching key, so every value of interest is read
 * by name rather than by position. `DisplayIcon` carries `,0` (the icon index)
 * and `UninstallString` carries the uninstaller's switches, so both are reduced
 * to a folder.
 */
export function parseUninstallPaths(stdout, env = process.env) {
  const dirs = [];
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const parsed = parseRegValueLine(line);
    if (parsed === undefined) continue;
    const value = expandEnvRefs(parsed.value, env);
    if (parsed.name === "installlocation") {
      dirs.push(value.replace(/^"(.*)"$/s, "$1").replace(/[\\/]+$/, ""));
    } else if (parsed.name === "displayicon") {
      const exe = unquoteExecutable(value.replace(/,\s*-?\d+\s*$/, ""));
      if (/[\\/]/.test(exe)) dirs.push(path.dirname(exe));
    } else if (parsed.name === "uninstallstring") {
      const exe = unquoteExecutable(value);
      if (/[\\/]/.test(exe)) dirs.push(path.dirname(exe));
    }
  }
  return uniqueDirs(dirs);
}

/**
 * Installation folders named by the uninstall hives, through `reg.exe`.
 *
 * One spawn per hive with a data-only search for the display name, which prints
 * only matching keys; parsing needs no block structure because of that. Every
 * failure (no entry, no reg.exe) means "this machine told us nothing", never an
 * error.
 */
export function readDshRegistryRoots(options = {}) {
  const env = options.env ?? process.env;
  const spawn = options.spawnSync ?? spawnSync;
  const dirs = [];
  for (const key of DSH_UNINSTALL_KEYS) {
    let result;
    try {
      result = spawn("reg.exe", ["query", key, "/s", "/f", DSH_DISPLAY_NAME, "/d"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000
      });
    } catch {
      continue;
    }
    if (result?.status !== 0) continue;
    dirs.push(...parseUninstallPaths(result.stdout, env));
  }
  return uniqueDirs(dirs);
}

/**
 * The folders a DSH installation conventionally occupies. A per-user install
 * goes under `%LOCALAPPDATA%\Programs`; a machine-wide one under either
 * `%ProgramFiles%` spelling, which is why all three are probed.
 */
export function defaultDshRoots(env = process.env) {
  const roots = [];
  const localAppData = envLookup(env, "LOCALAPPDATA");
  if (localAppData !== undefined) roots.push(path.join(localAppData, "Programs", DSH_DIR_NAME));
  for (const name of ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]) {
    const base = envLookup(env, name);
    if (base !== undefined) roots.push(path.join(base, DSH_DIR_NAME));
  }
  return roots;
}

/** `PATH` entries that name DeepSeek Harness; a portable install is often launched from one. */
export function pathDshRoots(env = process.env) {
  const raw = envLookup(env, "PATH");
  if (raw === undefined) return [];
  const roots = [];
  for (const entry of raw.split(";")) {
    const dir = entry.trim().replace(/^"(.*)"$/s, "$1").trim().replace(/[\\/]+$/, "");
    if (dir.length === 0) continue;
    if (!/deepseek[\s_-]*harness/i.test(dir)) continue;
    roots.push(dir);
  }
  return roots;
}

/**
 * Every installation folder worth probing, in trust order: what the running
 * interpreter points at, what the installer recorded, then the conventional
 * locations and `PATH`. Later entries are unvalidated on purpose — validation
 * happens in `resourcesDirsFor`, so a wrong guess contributes nothing.
 */
export function dshInstallRoots(options = {}) {
  const env = options.env ?? process.env;
  return uniqueDirs([
    ...execPathInstallRoots(options.execPath ?? process.execPath, options),
    ...(options.registryRoots ?? readDshRegistryRoots(options)),
    ...defaultDshRoots(env),
    ...pathDshRoots(env)
  ]);
}

/**
 * The folders to hand to the koffi search, existing ones only, de-duplicated,
 * in trust order.
 *
 * `process.resourcesPath` is consulted first when it exists: inside Electron it
 * IS the answer, and it costs nothing to prefer it.
 */
export function dshResourcesRoots(options = {}) {
  const env = options.env ?? process.env;
  const exists = options.exists ?? fs.existsSync;
  const resourcesPath = typeof options.resourcesPath === "string"
    ? options.resourcesPath
    : (typeof process.resourcesPath === "string" ? process.resourcesPath : undefined);
  const candidates = [];
  if (resourcesPath !== undefined && resourcesPath.length > 0) candidates.push(resourcesPath);
  candidates.push(...dshInstallRoots({ ...options, env }));
  const dirs = [];
  for (const candidate of candidates) dirs.push(...resourcesDirsFor(candidate, { exists }));
  return uniqueDirs(dirs).filter((dir) => existsWith(exists, dir));
}
