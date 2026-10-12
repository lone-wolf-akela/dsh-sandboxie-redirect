/**
 * Unit tests for the Sandboxie installation lookup.
 *
 * The resolver is exercised entirely through injected inputs — registry values,
 * environment, existence probe, directory reader — so these tests need no
 * Sandboxie, no registry access and no particular machine layout. The last two
 * checks do touch the live machine, guarded, purely as a canary that the real
 * path still resolves.
 *
 * usage: node test/sbie-locate.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  SBIE_DLL,
  defaultSbieDirs,
  directoryFromRegistryValue,
  expandEnvRefs,
  fixedDriveRoots,
  parseRegQueryValue,
  pathCandidateDirs,
  registryCandidateDirs,
  resolveSbieDir,
  sbieDirCandidates,
  scanSbieDirs,
  uniqueDirs
} from "../lib/sbie-locate.mjs";
import { sbieDir, sbieNotInstalledError } from "../lib/sbie.mjs";

let passed = 0;

function check(label, body) {
  try {
    body();
    passed += 1;
    console.log(`PASS  ${label}`);
  } catch (error) {
    console.log(`FAIL  ${label}  — ${error.message}`);
    process.exitCode = 1;
  }
}

/** An `existsSync` stand-in built from a set of existing paths (case-insensitive, like Windows). */
function existsFor(paths) {
  const set = new Set(paths.map((entry) => entry.replace(/[\\/]+$/, "").toLowerCase()));
  return (candidate) => set.has(String(candidate).replace(/[\\/]+$/, "").toLowerCase());
}

/** A `readdirSync`-with-fileTypes stand-in. */
function readdirFor(map) {
  return (dir) => {
    const entries = map[dir];
    if (entries === undefined) {
      const error = new Error(`ENOENT: ${dir}`);
      error.code = "ENOENT";
      throw error;
    }
    return entries.map((name) => ({
      name,
      isDirectory: () => !name.includes("."),
      isFile: () => name.includes(".")
    }));
  };
}

// ---------------------------------------------------------------------------
// Registry values -> folders
// ---------------------------------------------------------------------------

check("a quoted service ImagePath resolves to the folder it lives in", () => {
  assert.equal(
    directoryFromRegistryValue('"C:\\Program Files\\Sandboxie-Plus\\SbieSvc.exe"', "file"),
    "C:\\Program Files\\Sandboxie-Plus"
  );
});

check("the driver's \\??\\ path form is understood", () => {
  assert.equal(directoryFromRegistryValue("\\??\\C:\\Program Files\\Sandboxie-Plus\\SbieDrv.sys", "file"), "C:\\Program Files\\Sandboxie-Plus");
  assert.equal(directoryFromRegistryValue("\\\\?\\D:\\Sbie\\SbieDrv.sys", "file"), "D:\\Sbie");
});

check("an unexpanded REG_EXPAND_SZ reference is expanded from the environment", () => {
  const env = { ProgramFiles: "C:\\Program Files" };
  assert.equal(
    directoryFromRegistryValue('"%ProgramFiles%\\Sandboxie-Plus\\SbieSvc.exe"', "file", env),
    "C:\\Program Files\\Sandboxie-Plus"
  );
});

check("folder values keep their whole value and lose only the trailing separator", () => {
  assert.equal(directoryFromRegistryValue("D:\\Sbie\\", "dir"), "D:\\Sbie");
  assert.equal(directoryFromRegistryValue('"D:\\Sbie"', "dir"), "D:\\Sbie");
  assert.equal(directoryFromRegistryValue("C:\\Program Files\\Sandboxie-Plus", "dir"), "C:\\Program Files\\Sandboxie-Plus");
});

check("a value that cannot name a folder is rejected rather than guessed", () => {
  for (const bad of [undefined, null, "", "   ", "SbieSvc.exe", "\\", '"', 42]) {
    assert.equal(directoryFromRegistryValue(bad, "file"), undefined, `should reject ${JSON.stringify(bad)}`);
  }
});

check("environment references expand case-insensitively and unknown ones are left alone", () => {
  const env = { programfiles: "C:\\PF" };
  assert.equal(expandEnvRefs("%ProgramFiles%\\Sbie", env), "C:\\PF\\Sbie");
  assert.equal(expandEnvRefs("%NotASetting%\\Sbie", env), "%NotASetting%\\Sbie");
  assert.equal(expandEnvRefs("no references here", env), "no references here");
});

// ---------------------------------------------------------------------------
// reg.exe output
// ---------------------------------------------------------------------------

check("a reg.exe value line is parsed without splitting a spaced value name apart", () => {
  const stdout = [
    "",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Sandboxie-Plus_is1",
    "    Inno Setup: App Path    REG_SZ    C:\\Program Files\\Sandboxie-Plus",
    "    InstallLocation    REG_SZ    C:\\Program Files\\Sandboxie-Plus\\",
    ""
  ].join("\r\n");
  assert.equal(parseRegQueryValue(stdout, "InstallLocation"), "C:\\Program Files\\Sandboxie-Plus\\");
  assert.equal(parseRegQueryValue(stdout, "Inno Setup: App Path"), "C:\\Program Files\\Sandboxie-Plus");
  assert.equal(parseRegQueryValue(stdout, "installlocation"), "C:\\Program Files\\Sandboxie-Plus\\");
  assert.equal(parseRegQueryValue(stdout, "NotThere"), undefined);
  assert.equal(parseRegQueryValue("", "InstallLocation"), undefined);
});

check("a reg.exe EXPAND_SZ value is expanded by the folder resolver", () => {
  const stdout = "    ImagePath    REG_EXPAND_SZ    \"%ProgramFiles%\\Sandboxie-Plus\\SbieSvc.exe\"";
  const value = parseRegQueryValue(stdout, "ImagePath");
  assert.equal(directoryFromRegistryValue(value, "file", { ProgramFiles: "C:\\Program Files" }), "C:\\Program Files\\Sandboxie-Plus");
});

// ---------------------------------------------------------------------------
// Candidate ordering
// ---------------------------------------------------------------------------

check("candidates are ordered override, registry, conventional folders, PATH", () => {
  const env = {
    DSH_SBIE_DIR: "E:\\PortableSbie",
    ProgramFiles: "C:\\PF",
    "ProgramFiles(x86)": "C:\\PF86",
    ProgramW6432: "C:\\PF64",
    LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local",
    SystemDrive: "C:",
    PATH: "C:\\Windows;C:\\Sbie\\bin;C:\\Other"
  };
  const dirs = sbieDirCandidates({ env, registryValues: [{ value: "D:\\Sbie\\SbieSvc.exe", kind: "file" }] });
  assert.equal(dirs[0], "E:\\PortableSbie", "the explicit override is trusted first");
  assert.equal(dirs[1], "D:\\Sbie", "the registry outranks the conventional folders");
  assert.deepEqual(dirs.slice(2, 4), [path.join("C:\\PF", "Sandboxie-Plus"), path.join("C:\\PF86", "Sandboxie-Plus")]);
  assert.ok(dirs.includes(path.join("C:\\Users\\someone\\AppData\\Local", "Programs", "Sandboxie-Plus")));
  assert.ok(dirs.includes(path.join("C:", "Sandboxie-Plus")));
  assert.ok(dirs.includes("C:\\Sbie\\bin"), "a Sandboxie-named PATH entry is a candidate");
  assert.ok(!dirs.includes("C:\\Other"), "an unrelated PATH entry is not");
  assert.equal(new Set(dirs.map((dir) => dir.toLowerCase())).size, dirs.length, "candidates must be unique");
});

check("the historical default still exists with no environment at all", () => {
  const dirs = defaultSbieDirs({});
  assert.deepEqual(dirs, ["C:\\Program Files\\Sandboxie-Plus"]);
});

check("PATH entries are normalised and only Sandboxie-named ones are kept", () => {
  assert.deepEqual(pathCandidateDirs({ PATH: 'C:\\Program Files\\Sandboxie-Plus\\;C:\\x;D:\\SbiePortable' }), [
    "C:\\Program Files\\Sandboxie-Plus",
    "D:\\SbiePortable"
  ]);
  assert.deepEqual(pathCandidateDirs({}), []);
});

check("registry values that cannot name a folder contribute no candidate", () => {
  assert.deepEqual(registryCandidateDirs([{ value: "SbieSvc.exe", kind: "file" }, { value: "D:\\Sbie", kind: "dir" }]), ["D:\\Sbie"]);
});

check("duplicate candidates collapse case-insensitively", () => {
  assert.deepEqual(uniqueDirs(["C:\\Sbie", "c:\\sbie\\", "D:\\Sbie"]), ["C:\\Sbie", "D:\\Sbie"]);
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

check("the explicit override wins when it really holds SbieDll.dll", () => {
  const dir = "E:\\PortableSbie";
  const found = resolveSbieDir({
    env: { DSH_SBIE_DIR: dir, ProgramFiles: "C:\\PF" },
    exists: existsFor([path.join(dir, SBIE_DLL), path.join("C:\\PF", "Sandboxie-Plus", SBIE_DLL)]),
    registryValues: [],
    scan: false
  });
  assert.deepEqual(found, { dir, source: "DSH_SBIE_DIR" });
});

check("an override that holds no SbieDll.dll falls through instead of failing", () => {
  const env = { DSH_SBIE_DIR: "E:\\Empty", ProgramFiles: "C:\\PF" };
  const found = resolveSbieDir({
    env,
    exists: existsFor([path.join("C:\\PF", "Sandboxie-Plus", SBIE_DLL)]),
    registryValues: [],
    scan: false
  });
  assert.deepEqual(found, { dir: path.join("C:\\PF", "Sandboxie-Plus"), source: "default-folder" });
});

check("a non-standard registry location is found without any environment help", () => {
  const dir = "D:\\Apps\\Sandboxie-Plus";
  const found = resolveSbieDir({
    env: {},
    exists: existsFor([path.join(dir, SBIE_DLL)]),
    registryValues: [{ value: `"${dir}\\SbieSvc.exe"`, kind: "file" }],
    scan: false
  });
  assert.deepEqual(found, { dir, source: "registry" });
});

check("the registry outranks a stale conventional folder", () => {
  const stale = path.join("C:\\PF", "Sandboxie-Plus");
  const real = "D:\\Sbie";
  const found = resolveSbieDir({
    env: { ProgramFiles: "C:\\PF" },
    exists: existsFor([path.join(stale, SBIE_DLL), path.join(real, SBIE_DLL)]),
    registryValues: [{ value: `${real}\\SbieSvc.exe`, kind: "file" }],
    scan: false
  });
  assert.equal(found.dir, real);
  assert.equal(found.source, "registry");
});

check("a broken registry hint (folder gone) does not stop the search", () => {
  const found = resolveSbieDir({
    env: { ProgramFiles: "C:\\PF" },
    exists: existsFor([path.join("C:\\PF", "Sandboxie-Plus", SBIE_DLL)]),
    registryValues: [{ value: "D:\\Uninstalled\\SbieSvc.exe", kind: "file" }],
    scan: false
  });
  assert.deepEqual(found, { dir: path.join("C:\\PF", "Sandboxie-Plus"), source: "default-folder" });
});

check("a Sandboxie-named PATH entry is used when nothing else answers", () => {
  const found = resolveSbieDir({
    env: { PATH: "C:\\Windows;D:\\PortableSandboxie" },
    exists: existsFor([path.join("D:\\PortableSandboxie", SBIE_DLL)]),
    registryValues: [],
    scan: false
  });
  assert.deepEqual(found, { dir: "D:\\PortableSandboxie", source: "PATH" });
});

check("the disk scan is the last resort, and only then", () => {
  const parent = "D:\\";
  const dir = path.join(parent, "Sandboxie-Plus");
  const calls = [];
  const found = resolveSbieDir({
    env: {},
    exists: existsFor([path.join(dir, SBIE_DLL)]),
    registryValues: [],
    parents: [],
    drives: [parent],
    readdir: (target, options) => {
      calls.push(target);
      return readdirFor({ [parent]: ["Sandboxie-Plus", "Steam", "Sandboxie-Test"] })(target, options);
    }
  });
  assert.deepEqual(found, { dir, source: "disk-scan" });
  assert.deepEqual(calls, [parent], "only fixed-drive roots are walked");

  // With a conventional candidate present, the expensive stage must not run.
  const cheapCalls = [];
  const cheap = resolveSbieDir({
    env: { ProgramFiles: "C:\\PF" },
    exists: existsFor([path.join("C:\\PF", "Sandboxie-Plus", SBIE_DLL)]),
    registryValues: [],
    drives: ["D:\\"],
    readdir: (target, options) => {
      cheapCalls.push(target);
      return readdirFor({})(target, options);
    }
  });
  assert.equal(cheap.source, "default-folder");
  assert.deepEqual(cheapCalls, [], "a machine with a conventional install never touches the disk");
});

check("nothing found anywhere is reported as nothing, not as a guess", () => {
  const options = { env: { ProgramFiles: "C:\\PF" }, exists: existsFor([]), registryValues: [], scan: false };
  assert.equal(resolveSbieDir(options), undefined);
  assert.equal(resolveSbieDir({ ...options, scan: true, drives: [], parents: [] }), undefined);
});

check("scanning keeps directories named after Sandboxie and drops everything else", () => {
  const parent = "C:\\Apps";
  const found = scanSbieDirs({
    parents: [parent, "C:\\Missing"],
    drives: [],
    readdir: readdirFor({ [parent]: ["Sandboxie-Plus", "notes.txt", "sandboxie-old", "Steam"] })
  });
  assert.deepEqual(found, [path.join(parent, "Sandboxie-Plus"), path.join(parent, "sandboxie-old")]);
});

// ---------------------------------------------------------------------------
// Live canaries (skipped silently on a machine without Sandboxie)
// ---------------------------------------------------------------------------

check("the live lookup still resolves to a folder that holds SbieDll.dll", () => {
  const live = resolveSbieDir({ scan: false });
  if (live === undefined) {
    console.log("      (no Sandboxie on this machine: live canary skipped)");
    assert.equal(sbieDir(), undefined, "the public lookup must agree that nothing was found");
    return;
  }
  assert.ok(live.dir.length > 0, "a resolved folder must be a path");
  assert.ok(["DSH_SBIE_DIR", "registry", "default-folder", "PATH"].includes(live.source), `unexpected source ${live.source}`);
  assert.equal(sbieDir(), live.dir, "the launcher's lookup must return the resolved folder");
});

check("the not-installed error names the DLL and the override", () => {
  const message = sbieNotInstalledError().message;
  assert.match(message, /SbieDll\.dll/, "must name the file it looked for");
  assert.match(message, /DSH_SBIE_DIR/, "must name the way out");
});

check("the reg.exe fallback parses the live registry the same way", () => {
  if (process.platform !== "win32") {
    console.log("      (not Windows: skipped)");
    return;
  }
  let result;
  try {
    result = spawnSync("reg.exe", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Services\\SbieSvc", "/v", "ImagePath"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000
    });
  } catch {
    console.log("      (reg.exe unavailable: skipped)");
    return;
  }
  if (result?.status !== 0) {
    console.log("      (no SbieSvc service: skipped)");
    return;
  }
  // The fallback reader is what runs when koffi cannot be located, so its
  // parser has to agree with the native one on real output, not just on the
  // synthetic line above.
  const dir = directoryFromRegistryValue(parseRegQueryValue(result.stdout, "ImagePath"), "file");
  assert.ok(dir !== undefined, "the live service ImagePath must resolve to a folder");
  const resolved = resolveSbieDir({ scan: false });
  if (resolved !== undefined) assert.equal(dir.toLowerCase(), resolved.dir.toLowerCase(), "both registry readers must agree");
});

check("fixed drives are enumerable on Windows", () => {
  if (process.platform !== "win32") {
    console.log("      (not Windows: skipped)");
    return;
  }
  const roots = fixedDriveRoots();
  // Empty is legitimate on a machine with no koffi (and therefore no DSH): the
  // scan stage is a last resort, and this only proves the enumeration never
  // returns something that is not a drive root.
  assert.ok(Array.isArray(roots), "the enumeration must answer with an array");
  assert.ok(roots.every((root) => /^[A-Z]:\\$/.test(root)), "roots are drive roots");
  if (roots.length === 0) console.log("      (koffi unavailable: drive enumeration skipped)");
});

console.log(`\n${passed} checks passed${process.exitCode === 1 ? " (some FAILED)" : ""}`);
