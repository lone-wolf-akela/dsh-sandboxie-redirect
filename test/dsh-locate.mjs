/**
 * Unit tests for the DeepSeek Harness installation lookup that feeds the koffi
 * search.
 *
 * The resolver is exercised through injected inputs — interpreter path,
 * registry output, environment, existence probes — so these tests need no DSH
 * installation, no registry and no Windows layout in particular. The last two
 * checks touch the live machine, guarded, as a canary that the real path still
 * resolves.
 *
 * usage: node test/dsh-locate.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  DSH_EXE,
  defaultDshRoots,
  dshInstallRoots,
  dshResourcesRoots,
  execPathInstallRoots,
  isDshInstallRoot,
  parseRegValueLine,
  parseUninstallPaths,
  pathDshRoots,
  readDshRegistryRoots,
  resourcesDirsFor,
  uniqueDirs
} from "../lib/dsh-locate.mjs";
import { koffiRootCandidates } from "../lib/koffi.mjs";

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

/** A fake Windows filesystem: a set of file paths and a set of directory paths. */
function fakeFs(files = [], dirs = []) {
  const lower = (value) => String(value).replace(/[\\/]+$/, "").toLowerCase();
  const fileSet = new Set(files.map(lower));
  const dirSet = new Set(dirs.map(lower));
  return {
    fileSet,
    dirSet,
    exists: (candidate) => fileSet.has(lower(candidate)) || dirSet.has(lower(candidate)),
    isDirectory: (candidate) => dirSet.has(lower(candidate))
  };
}

// ---------------------------------------------------------------------------
// Layout shapes
// ---------------------------------------------------------------------------

check("an installation root is recognised by its app bundle or its executable", () => {
  const root = "D:\\Apps\\DeepSeek Harness";
  assert.equal(isDshInstallRoot(root, { exists: fakeFs([path.join(root, "resources", "app.asar")]).exists }), true);
  assert.equal(isDshInstallRoot(root, { exists: fakeFs([], [path.join(root, "resources", "app.asar.unpacked")]).exists }), true);
  assert.equal(isDshInstallRoot(root, { exists: fakeFs([path.join(root, DSH_EXE)]).exists }), true);
  assert.equal(isDshInstallRoot(root, { exists: fakeFs([path.join(root, "resources", "readme.txt")]).exists }), false);
});

check("resources folders are derived from an installation root, a resources folder, or the payload", () => {
  const root = "D:\\Apps\\DeepSeek Harness";
  const resources = path.join(root, "resources");
  const unpacked = path.join(resources, "app.asar.unpacked");
  const fsLike = fakeFs([path.join(resources, "app.asar")], [unpacked]);
  assert.deepEqual(resourcesDirsFor(root, { exists: fsLike.exists }), [unpacked, resources]);
  assert.deepEqual(resourcesDirsFor(resources, { exists: fsLike.exists }), [unpacked, resources]);
  assert.deepEqual(resourcesDirsFor(unpacked, { exists: fakeFs([], [unpacked]).exists }), [unpacked]);
  assert.deepEqual(resourcesDirsFor("D:\\Nothing Here", { exists: fsLike.exists }), []);
});

// ---------------------------------------------------------------------------
// The interpreter's own path
// ---------------------------------------------------------------------------

check("the installation is found by walking up from the Node the app ships", () => {
  const root = "D:\\Apps\\DeepSeek Harness";
  const node = path.join(root, "resources", "runtime", "primary-runtime", "dependencies", "node", "bin", "node.exe");
  const fsLike = fakeFs([path.join(root, "resources", "app.asar"), node]);
  assert.deepEqual(execPathInstallRoots(node, { exists: fsLike.exists }), [root]);
});

check("an interpreter that lives outside any DSH installation contributes nothing", () => {
  const fsLike = fakeFs(["C:\\Program Files\\nodejs\\node.exe"]);
  assert.deepEqual(execPathInstallRoots("C:\\Program Files\\nodejs\\node.exe", { exists: fsLike.exists }), []);
  assert.deepEqual(execPathInstallRoots("", { exists: fsLike.exists }), []);
});

// ---------------------------------------------------------------------------
// The installer's uninstall entry
// ---------------------------------------------------------------------------

check("a reg.exe value line is split on the type token, not the first space run", () => {
  assert.deepEqual(parseRegValueLine("    DisplayIcon    REG_SZ    D:\\Apps\\DeepSeek Harness\\DeepSeek Harness.exe,0"), {
    name: "displayicon",
    type: "REG_SZ",
    value: "D:\\Apps\\DeepSeek Harness\\DeepSeek Harness.exe,0"
  });
  assert.equal(parseRegValueLine("HKEY_CURRENT_USER\\SOFTWARE\\...\\Uninstall\\{guid}"), undefined);
  assert.equal(parseRegValueLine(""), undefined);
});

check("InstallLocation, DisplayIcon and UninstallString all yield an installation folder", () => {
  const stdout = [
    "",
    "HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\1bf39983-50d0-5fe0-9ef4-cece76f67c5e",
    "    DisplayName    REG_SZ    DeepSeek Harness 0.2.0-rc.2",
    "    UninstallString    REG_SZ    \"D:\\Apps\\DeepSeek Harness\\Uninstall DeepSeek Harness.exe\" /currentuser",
    "    QuietUninstallString    REG_SZ    \"D:\\Apps\\DeepSeek Harness\\Uninstall DeepSeek Harness.exe\" /currentuser /S",
    "    DisplayIcon    REG_SZ    D:\\Apps\\DeepSeek Harness\\DeepSeek Harness.exe,0",
    "    InstallLocation    REG_SZ    D:\\Apps\\DeepSeek Harness",
    ""
  ].join("\r\n");
  assert.deepEqual(parseUninstallPaths(stdout), ["D:\\Apps\\DeepSeek Harness"]);
});

check("an uninstall entry with only a DisplayIcon still names the folder", () => {
  const stdout = "    DisplayIcon    REG_SZ    C:\\Tools\\Harness\\DeepSeek Harness.exe,0";
  assert.deepEqual(parseUninstallPaths(stdout), ["C:\\Tools\\Harness"]);
});

check("an environment reference in a registry value is expanded", () => {
  const stdout = "    InstallLocation    REG_SZ    %LOCALAPPDATA%\\Programs\\DeepSeek Harness";
  assert.deepEqual(parseUninstallPaths(stdout, { LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local" }), [
    "C:\\Users\\someone\\AppData\\Local\\Programs\\DeepSeek Harness"
  ]);
});

check("the uninstall search asks every hive once and survives a missing entry", () => {
  const calls = [];
  const spawnSync = (command, args) => {
    calls.push(args[1]);
    if (args[1].startsWith("HKLM")) return { status: 1, stdout: "", stderr: "ERROR" };
    return {
      status: 0,
      stdout: "    InstallLocation    REG_SZ    D:\\Apps\\DeepSeek Harness"
    };
  };
  assert.deepEqual(readDshRegistryRoots({ spawnSync }), ["D:\\Apps\\DeepSeek Harness"]);
  assert.equal(calls.length, 3, "one spawn per hive");
});

// ---------------------------------------------------------------------------
// Candidate assembly
// ---------------------------------------------------------------------------

check("installation folders are ordered interpreter, installer, conventional, PATH", () => {
  const root = "D:\\Apps\\DeepSeek Harness";
  const node = path.join(root, "resources", "runtime", "primary-runtime", "dependencies", "node", "bin", "node.exe");
  const env = {
    LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local",
    ProgramFiles: "C:\\PF",
    PATH: "C:\\Windows;D:\\Portable DeepSeek Harness;D:\\Other"
  };
  const roots = dshInstallRoots({
    env,
    execPath: node,
    registryRoots: ["E:\\Registered\\DeepSeek Harness"],
    exists: fakeFs([path.join(root, "resources", "app.asar"), node]).exists
  });
  assert.equal(roots[0], root, "the installation this process runs from wins");
  assert.equal(roots[1], "E:\\Registered\\DeepSeek Harness", "the installer's record is second");
  assert.ok(roots.includes(path.join("C:\\Users\\someone\\AppData\\Local", "Programs", "DeepSeek Harness")));
  assert.ok(roots.includes(path.join("C:\\PF", "DeepSeek Harness")));
  assert.ok(roots.includes("D:\\Portable DeepSeek Harness"), "a DSH-named PATH entry is a candidate");
  assert.ok(!roots.includes("D:\\Other"), "an unrelated PATH entry is not");
});

check("conventional folders cover the per-user and both Program Files spellings", () => {
  assert.deepEqual(defaultDshRoots({}), []);
  assert.deepEqual(
    defaultDshRoots({ LOCALAPPDATA: "C:\\L", ProgramFiles: "C:\\PF", "ProgramFiles(x86)": "C:\\PF86", ProgramW6432: "C:\\PF64" }),
    [
      path.join("C:\\L", "Programs", "DeepSeek Harness"),
      path.join("C:\\PF", "DeepSeek Harness"),
      path.join("C:\\PF86", "DeepSeek Harness"),
      path.join("C:\\PF64", "DeepSeek Harness")
    ]
  );
});

check("PATH entries are normalised and only DSH-named ones are kept", () => {
  assert.deepEqual(pathDshRoots({ PATH: '"C:\\Program Files\\DeepSeek Harness";C:\\x;D:\\deepseek_harness\\' }), [
    "C:\\Program Files\\DeepSeek Harness",
    "D:\\deepseek_harness"
  ]);
  assert.deepEqual(pathDshRoots({}), []);
});

check("duplicate folders collapse case-insensitively", () => {
  assert.deepEqual(uniqueDirs(["D:\\DSH", "d:\\dsh\\", "E:\\DSH"]), ["D:\\DSH", "E:\\DSH"]);
});

// ---------------------------------------------------------------------------
// The roots the koffi search actually starts from
// ---------------------------------------------------------------------------

check("only existing resources folders reach the koffi search, payload first", () => {
  const root = "D:\\Apps\\DeepSeek Harness";
  const resources = path.join(root, "resources");
  const unpacked = path.join(resources, "app.asar.unpacked");
  const node = path.join(resources, "runtime", "primary-runtime", "dependencies", "node", "bin", "node.exe");
  const fsLike = fakeFs([path.join(resources, "app.asar"), node], [resources, unpacked]);
  assert.deepEqual(
    dshResourcesRoots({ env: {}, execPath: node, registryRoots: [], exists: fsLike.exists }),
    [unpacked, resources]
  );
});

check("REGRESSION: a DSH outside the default folder is found without any registry entry", () => {
  // The exact shape of the reported bug: DSH installed on another drive, the
  // default per-user folder absent, and the launcher started with the app's own
  // Node. The old hardcoded candidate list found nothing here.
  const root = "D:\\Apps\\DeepSeek Harness";
  const resources = path.join(root, "resources");
  const unpacked = path.join(resources, "app.asar.unpacked");
  const node = path.join(resources, "runtime", "primary-runtime", "dependencies", "node", "bin", "node.exe");
  const vendor = path.join("C:\\plugin", "vendor");
  const fsLike = fakeFs([path.join(resources, "app.asar"), node], [unpacked, resources, vendor]);
  const roots = koffiRootCandidates({
    env: { LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local", DSH_HOME: "C:\\Users\\someone\\.dsh" },
    execPath: node,
    registryRoots: [],
    homeDir: "C:\\Users\\someone",
    exists: fsLike.exists,
    isDirectory: fsLike.isDirectory
  });
  assert.equal(roots[0], unpacked, "the discovered payload is searched first");
  assert.equal(roots[1], resources);
  assert.ok(!roots.some((dir) => dir.includes("AppData\\Local\\Programs")), "the absent default folder is not claimed");
});

check("an explicit override still outranks discovery, and the runtime pool stays last", () => {
  const root = "D:\\Apps\\DeepSeek Harness";
  const resources = path.join(root, "resources");
  const unpacked = path.join(resources, "app.asar.unpacked");
  const node = path.join(resources, "runtime", "primary-runtime", "dependencies", "node", "bin", "node.exe");
  const vendor = path.join("C:\\plugin", "vendor");
  const runtimes = "C:\\Users\\someone\\.dsh\\dsh-runtimes";
  const fsLike = fakeFs([path.join(resources, "app.asar"), node], [unpacked, resources, vendor, runtimes]);
  const roots = koffiRootCandidates({
    env: { DSH_SBIE_KOFFI_ROOT: "C:\\given", DSH_HOME: "C:\\Users\\someone\\.dsh" },
    execPath: node,
    registryRoots: [],
    homeDir: "C:\\Users\\someone",
    exists: (candidate) => candidate === "C:\\given" || fsLike.exists(candidate),
    isDirectory: (candidate) => candidate === "C:\\given" || fsLike.isDirectory(candidate)
  });
  assert.equal(roots[0], "C:\\given", "the documented override wins");
  assert.equal(roots[roots.length - 1], runtimes, "the managed runtime pool is last");
});

// ---------------------------------------------------------------------------
// Live canaries (skipped silently on a machine without DSH)
// ---------------------------------------------------------------------------

check("the live lookup resolves the running DSH installation", () => {
  const resources = dshResourcesRoots();
  if (resources.length === 0) {
    console.log("      (no DSH found on this machine: live canary skipped)");
    return;
  }
  for (const dir of resources) assert.ok(fs.existsSync(dir), `${dir} must exist`);
  assert.ok(
    resources.some((dir) => dir.toLowerCase().endsWith("app.asar.unpacked")),
    `expected an unpacked payload among ${JSON.stringify(resources)}`
  );
});

check("the live koffi root list keeps the live payload", () => {
  const resources = dshResourcesRoots();
  if (resources.length === 0) {
    console.log("      (no DSH found on this machine: live canary skipped)");
    return;
  }
  const roots = koffiRootCandidates();
  for (const dir of resources) {
    assert.ok(roots.some((root) => root.toLowerCase() === dir.toLowerCase()), `${dir} must be searched`);
  }
});

console.log(`\n${passed} checks passed${process.exitCode === 1 ? " (some FAILED)" : ""}`);
