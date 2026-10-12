/**
 * Find where Sandboxie-Plus is installed.
 *
 * The engine is reached through `SbieDll.dll` and `SbieIni.exe`, both of which
 * live in the installation folder — and that folder is NOT always the default
 * `%ProgramFiles%\Sandboxie-Plus`. A user may install to another drive, to a
 * per-user folder, or into a portable directory. Probing a fixed list of four
 * paths therefore reports "Sandboxie-Plus is not installed" on machines where
 * it plainly is.
 *
 * The authoritative source is Sandboxie's own service registration:
 * `SbieDll_RunSandboxed` is only usable while `SbieSvc` runs, and the service
 * key's `ImagePath` names the real installation folder. The driver service and
 * the installer's uninstall entry name it too. Those are read first, then the
 * conventional folders, then `PATH`, and only if all of that fails is the disk
 * walked — a bounded, one-level scan of well-known parent folders and of each
 * fixed drive's root, looking for a directory whose name names Sandboxie.
 *
 * Everything here is dependency-light on purpose: the module is imported by the
 * launcher (a plain Node process) and is unit-testable with no Sandboxie, no
 * registry, and no Windows at all, because every side effect is injectable.
 * `koffi` is loaded lazily and only when the registry is actually consulted.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadKoffi } from "./koffi.mjs";

/** The DLL whose presence in a folder is what makes it an installation folder. */
export const SBIE_DLL = "SbieDll.dll";

/** Windows' predefined `HKEY_LOCAL_MACHINE`. */
const HKEY_LOCAL_MACHINE = 0x80000002;
/** `RegGetValueW` restrictions: accept `REG_SZ` and `REG_EXPAND_SZ` (expanded for us). */
const RRF_RT_REG_SZ = 0x00000002;
const RRF_RT_REG_EXPAND_SZ = 0x00000004;
/** The largest registry value this module bothers to hold (a path never comes close). */
const REGISTRY_VALUE_BYTES = 4096;
/** `GetDriveTypeW` answer for a fixed disk. */
const DRIVE_FIXED = 3;

/**
 * Registry locations that name the installation folder, most authoritative
 * first. `kind: "file"` means the value names a file inside the folder (so the
 * folder is its directory); `kind: "dir"` means the value IS the folder.
 *
 * `HKLM\SYSTEM\CurrentControlSet\Services\SbieSvc` is the load-bearing one: a
 * Sandboxie that cannot register that service cannot start a boxed process at
 * all, so the folder it names is the folder this plugin must use whenever the
 * plugin can work.
 */
export const SBIE_REGISTRY_SOURCES = [
  {
    key: "HKLM\\SYSTEM\\CurrentControlSet\\Services\\SbieSvc",
    values: [{ name: "ImagePath", kind: "file" }]
  },
  {
    key: "HKLM\\SYSTEM\\CurrentControlSet\\Services\\SbieDrv",
    values: [{ name: "ImagePath", kind: "file" }]
  },
  {
    key: "HKLM\\SOFTWARE\\Sandboxie-Plus",
    values: [
      { name: "InstallDir", kind: "dir" },
      { name: "InstallLocation", kind: "dir" },
      { name: "SbieHome", kind: "dir" },
      { name: "HomeDir", kind: "dir" }
    ]
  },
  {
    key: "HKLM\\SOFTWARE\\WOW6432Node\\Sandboxie-Plus",
    values: [
      { name: "InstallDir", kind: "dir" },
      { name: "InstallLocation", kind: "dir" },
      { name: "SbieHome", kind: "dir" },
      { name: "HomeDir", kind: "dir" }
    ]
  },
  {
    // Sandboxie-Plus ships an Inno Setup installer; both registry views are read
    // because the installer's bitness decides which one it wrote.
    key: "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Sandboxie-Plus_is1",
    values: [
      { name: "InstallLocation", kind: "dir" },
      { name: "Inno Setup: App Path", kind: "dir" },
      { name: "DisplayIcon", kind: "file" }
    ]
  },
  {
    key: "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Sandboxie-Plus_is1",
    values: [
      { name: "InstallLocation", kind: "dir" },
      { name: "Inno Setup: App Path", kind: "dir" },
      { name: "DisplayIcon", kind: "file" }
    ]
  }
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

/**
 * Replace `%NAME%` references with the environment's values. Unknown names are
 * left alone: a candidate that keeps an unresolved placeholder simply fails the
 * `SbieDll.dll` check and costs nothing, whereas guessing a value could point
 * at the wrong folder.
 */
export function expandEnvRefs(value, env = process.env) {
  return String(value).replace(/%([^%]+)%/g, (whole, name) => envLookup(env, name) ?? whole);
}

/**
 * Turn one registry value into the folder it names.
 *
 * Handles the shapes these keys actually hold: surrounding quotes, the
 * `\??\`/`\\?\` prefixes the driver service uses, `%ProgramFiles%`-style
 * references (already expanded on the `RegGetValueW` path, expanded here on the
 * `reg.exe` one), and trailing separators. Returns `undefined` when the value
 * cannot name a folder.
 *
 * @param raw - the registry value.
 * @param kind - `"file"` (a file inside the folder) or `"dir"` (the folder).
 * @param env - environment used to expand `%NAME%` references.
 */
export function directoryFromRegistryValue(raw, kind = "dir", env = process.env) {
  if (typeof raw !== "string") return undefined;
  let text = expandEnvRefs(raw, env).trim();
  if (text.length === 0) return undefined;
  const quoted = /^"(.*)"$/s.exec(text);
  if (quoted !== null) text = quoted[1].trim();
  // `\??\C:\…` (driver ImagePath), `\\?\C:\…` (long-path form), `\SystemRoot\…`.
  text = text.replace(/^(?:\\\?\?\\|\\\\\?\\|\\SystemRoot\\)/i, "");
  if (text.length === 0) return undefined;
  const trimmed = text.replace(/[\\/]+$/, "");
  if (trimmed.length === 0) return undefined;
  if (kind !== "file") return trimmed;
  // A file value must carry a directory; a bare name would resolve to ".".
  if (!/[\\/]/.test(trimmed)) return undefined;
  const dir = path.dirname(trimmed).replace(/[\\/]+$/, "");
  return dir.length === 0 || dir === "." ? undefined : dir;
}

/**
 * The value of one `reg query` line, or `undefined`.
 *
 * The format is fixed: `<value>\t<type>\t<data>`, with two or more spaces in
 * place of tabs. A value name may itself contain spaces (`Inno Setup: App
 * Path`), so the name/type split is found by the `REG_*` token rather than by
 * splitting on the first run of whitespace.
 *
 * @param stdout - `reg query <key> /v <name>` output.
 * @param name - the value name that was asked for.
 */
export function parseRegQueryValue(stdout, name) {
  const wanted = String(name).toLowerCase();
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const match = /^\s{2,}(\S.*?)\s{2,}(REG_[A-Z_]+)\s{2,}(.*)$/.exec(line);
    if (match === null) continue;
    if (match[1].trim().toLowerCase() !== wanted) continue;
    return match[3].trim();
  }
  return undefined;
}

/** Read the registry through koffi/advapi32 (wide characters, no subprocess). */
function readRegistryValuesNative() {
  const koffi = loadKoffi();
  const advapi = koffi.load("advapi32.dll");
  const regGetValue = advapi.func("__stdcall", "RegGetValueW", "int32", [
    "uintptr", // HKEY
    "str16", // LPCWSTR lpSubKey
    "str16", // LPCWSTR lpValue
    "uint32", // DWORD dwFlags
    "void *", // LPDWORD pdwType
    "void *", // PVOID pvData
    koffi.inout(koffi.pointer("uint32")) // LPDWORD pcbData
  ]);
  const found = [];
  for (const source of SBIE_REGISTRY_SOURCES) {
    const subkey = source.key.replace(/^HKLM\\/i, "");
    for (const entry of source.values) {
      const buffer = Buffer.alloc(REGISTRY_VALUE_BYTES);
      const size = [buffer.length];
      const status = regGetValue(HKEY_LOCAL_MACHINE, subkey, entry.name, RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ, null, buffer, size);
      if (status !== 0) continue; // ERROR_FILE_NOT_FOUND / no such key: simply not this source
      const value = buffer.toString("utf16le").replace(/\0[\s\S]*$/s, "").trim();
      if (value.length > 0) found.push({ value, kind: entry.kind, source: source.key });
    }
  }
  return found;
}

/**
 * Read the registry through `reg.exe`; used only when koffi cannot be used at all.
 *
 * One spawn per KEY rather than per value: `reg query <key>` prints every value
 * of the key, and the parser picks the ones that interest us. Spawning costs
 * tens of milliseconds each, so this halves the fallback's latency.
 */
function readRegistryValuesRegExe() {
  const found = [];
  for (const source of SBIE_REGISTRY_SOURCES) {
    let result;
    try {
      result = spawnSync("reg.exe", ["query", source.key], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000
      });
    } catch {
      continue;
    }
    if (result?.status !== 0) continue;
    for (const entry of source.values) {
      const value = parseRegQueryValue(result.stdout, entry.name);
      if (value !== undefined && value.length > 0) found.push({ value, kind: entry.kind, source: source.key });
    }
  }
  return found;
}

/**
 * Every registry value that names an installation folder, in source order.
 *
 * `koffi` is tried first because it decodes the wide-character values exactly
 * and spawns nothing; `reg.exe` is the fallback, since a machine where the
 * plugin works always has it even if koffi cannot be located.
 */
export function readSbieRegistryValues() {
  try {
    return readRegistryValuesNative();
  } catch {
    /* no koffi, or advapi32 unavailable: reg.exe still answers */
  }
  try {
    return readRegistryValuesRegExe();
  } catch {
    return [];
  }
}

/** Folders from registry values, in order, with `undefined`s dropped. */
export function registryCandidateDirs(values, env = process.env) {
  const dirs = [];
  for (const entry of values ?? []) {
    const dir = directoryFromRegistryValue(entry?.value, entry?.kind, env);
    if (dir !== undefined) dirs.push(dir);
  }
  return dirs;
}

/**
 * The conventional installation folders. `%ProgramFiles%` and friends cover a
 * relocated Windows as well as a relocated Sandboxie; the literal last entry is
 * the historical default, kept so a machine with no environment at all still
 * gets the old behaviour.
 */
export function defaultSbieDirs(env = process.env) {
  const dirs = [];
  const under = (base) => {
    if (typeof base !== "string" || base.length === 0) return undefined;
    return path.join(base, "Sandboxie-Plus");
  };
  for (const name of ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]) {
    const dir = under(envLookup(env, name));
    if (dir !== undefined) dirs.push(dir);
  }
  const localAppData = envLookup(env, "LOCALAPPDATA");
  if (localAppData !== undefined) dirs.push(path.join(localAppData, "Programs", "Sandboxie-Plus"));
  const systemDrive = envLookup(env, "SystemDrive");
  if (systemDrive !== undefined) dirs.push(path.join(systemDrive, "Sandboxie-Plus"));
  dirs.push("C:\\Program Files\\Sandboxie-Plus");
  return dirs;
}

/**
 * Directories from `PATH` that are plausibly an installation folder. Only names
 * that mention Sandboxie are considered, so a long `PATH` does not turn into a
 * long list of candidates.
 */
export function pathCandidateDirs(env = process.env) {
  const raw = envLookup(env, "PATH");
  if (raw === undefined) return [];
  const dirs = [];
  for (const entry of raw.split(";")) {
    const dir = entry.trim().replace(/^"(.*)"$/s, "$1").trim();
    if (dir.length === 0) continue;
    if (!/sbie|sandboxie/i.test(dir)) continue;
    dirs.push(dir.replace(/[\\/]+$/, ""));
  }
  return dirs;
}

/** Parent folders whose immediate children may be an installation folder. */
export function scanParentDirs(env = process.env) {
  const dirs = [];
  for (const name of ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]) {
    const base = envLookup(env, name);
    if (base !== undefined) dirs.push(base);
  }
  const localAppData = envLookup(env, "LOCALAPPDATA");
  if (localAppData !== undefined) dirs.push(path.join(localAppData, "Programs"));
  const systemDrive = envLookup(env, "SystemDrive");
  if (systemDrive !== undefined) {
    dirs.push(`${systemDrive}\\`);
    dirs.push(path.join(systemDrive, "Programs"));
    dirs.push(path.join(systemDrive, "Apps"));
  }
  return dirs;
}

/**
 * Roots of the machine's fixed drives, so an installation on `D:` is found.
 *
 * Only `DRIVE_FIXED` disks are returned: probing a disconnected network drive,
 * an empty optical drive or a card reader can block for seconds, and Sandboxie
 * on such a volume is not a case worth that cost.
 */
export function fixedDriveRoots() {
  try {
    const koffi = loadKoffi();
    const kernel32 = koffi.load("kernel32.dll");
    const getLogicalDrives = kernel32.func("GetLogicalDrives", "uint32", []);
    const getDriveType = kernel32.func("GetDriveTypeW", "uint32", ["str16"]);
    const mask = getLogicalDrives();
    const roots = [];
    for (let index = 0; index < 26; index += 1) {
      if ((mask & (1 << index)) === 0) continue;
      const root = `${String.fromCharCode(65 + index)}:\\`;
      if (getDriveType(root) === DRIVE_FIXED) roots.push(root);
    }
    return roots;
  } catch {
    return [];
  }
}

/**
 * Walk the immediate children of `parents` (and of `drives`' roots) for a
 * directory whose NAME names Sandboxie.
 *
 * One level only, and by name only: this is the last resort after the
 * authoritative sources, so it must be cheap and must never wander into a
 * user's tree. A directory that matches but holds no `SbieDll.dll` is simply
 * filtered out by the caller's existence check. Junctions and symlinks count as
 * directories, so a linked installation is not missed by the name sweep.
 */
export function scanSbieDirs(options = {}) {
  const readdir = options.readdir ?? fs.readdirSync;
  const parents = [...(options.parents ?? scanParentDirs(options.env)), ...(options.drives ?? [])];
  const seen = new Set();
  const found = [];
  for (const parent of parents) {
    if (typeof parent !== "string" || parent.length === 0) continue;
    let entries;
    try {
      entries = readdir(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const isDirectory = entry?.isDirectory?.() === true || entry?.isSymbolicLink?.() === true;
      if (!isDirectory) continue;
      const name = String(entry.name ?? "");
      if (!/sandboxie/i.test(name)) continue;
      const dir = path.join(parent, name);
      const key = dir.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(dir);
    }
  }
  return found;
}

/** De-duplicate candidates case-insensitively, keeping the first occurrence's spelling. */
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

/**
 * Every cheap candidate, in the order they are trusted: the explicit override,
 * then what Sandboxie's own registry entries say, then the conventional
 * folders, then `PATH`. The disk scan is deliberately NOT part of this list —
 * it is expensive and is only reached when nothing here holds `SbieDll.dll`.
 *
 * This is the same list `resolveSbieDir` walks (minus the scan), so the
 * "not installed" message can be built from it and cannot claim to have looked
 * somewhere the resolver never looks.
 */
export function sbieDirCandidates(options = {}) {
  const env = options.env ?? process.env;
  const override = typeof env?.DSH_SBIE_DIR === "string" && env.DSH_SBIE_DIR.length > 0 ? [env.DSH_SBIE_DIR] : [];
  const registryValues = options.registryValues ?? readSbieRegistryValues();
  return uniqueDirs([
    ...override,
    ...registryCandidateDirs(registryValues, env),
    ...defaultSbieDirs(env),
    ...pathCandidateDirs(env)
  ]);
}

/**
 * The installation folder, with the reason it was chosen.
 *
 * @param options.env - environment (default `process.env`).
 * @param options.exists - existence probe (default `fs.existsSync`).
 * @param options.registryValues - registry values to trust, when the caller has
 *   them; the real registry is read only when this is omitted.
 * @param options.readdir / options.parents / options.drives - the disk scan's
 *   inputs, injectable so the whole resolver is testable off-Windows.
 * @param options.scan - `false` disables the last-resort scan.
 * @returns `{dir, source}` or `undefined`.
 */
export function resolveSbieDir(options = {}) {
  const env = options.env ?? process.env;
  const exists = options.exists ?? fs.existsSync;
  const hasDll = (dir) => {
    try {
      return exists(path.join(dir, SBIE_DLL)) === true;
    } catch {
      return false;
    }
  };

  const override = typeof env?.DSH_SBIE_DIR === "string" && env.DSH_SBIE_DIR.length > 0 ? env.DSH_SBIE_DIR : undefined;
  if (override !== undefined && hasDll(override)) return { dir: override, source: "DSH_SBIE_DIR" };

  const registryValues = options.registryValues ?? readSbieRegistryValues();
  for (const dir of registryCandidateDirs(registryValues, env)) {
    if (hasDll(dir)) return { dir, source: "registry" };
  }
  for (const dir of defaultSbieDirs(env)) {
    if (hasDll(dir)) return { dir, source: "default-folder" };
  }
  for (const dir of pathCandidateDirs(env)) {
    if (hasDll(dir)) return { dir, source: "PATH" };
  }

  if (options.scan === false) return undefined;
  const drives = options.drives ?? fixedDriveRoots();
  for (const dir of scanSbieDirs({ ...options, env, drives })) {
    if (hasDll(dir)) return { dir, source: "disk-scan" };
  }
  return undefined;
}
