/**
 * Pure-logic unit tests for the copy-on-write preset. Plain Node, no Electron,
 * no Sandboxie: everything the plugin decides before it touches the world.
 *
 * usage: node test/unit.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boxNameCandidates, boxNameFor, boxRoot, canonicalWorkspace, expandFileRootPath, fnv1a64, isManagedBoxName, resolveBoxRoot, sbieSandboxRoot } from "../lib/naming.mjs";
import { REDIRECT_PRESET, RUNNER_FATAL_SIGNATURE, isRedirectPresetState, redirectArgv, redirectPolicyNote, redirectWrap, resolveNodePath } from "../lib/redirect.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.dirname(here);
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

check("preset id is the agreed machine value", () => {
  assert.equal(REDIRECT_PRESET, "copy-on-write");
});

check("only an exact preset match selects copy-on-write", () => {
  assert.equal(isRedirectPresetState({ preset: "copy-on-write" }), true);
  for (const bad of [{ preset: "workspace-write" }, { preset: "custom" }, { preset: null }, {}, undefined, "copy-on-write"]) {
    assert.equal(isRedirectPresetState(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});

check("box naming is a stable, readable, mode-scoped word pair", () => {
  const ws = "C:\\Users\\someone\\ws";
  const write = boxNameFor(ws, "workspace-write");
  assert.match(write, /^dsh_[a-z]+_[a-z]+$/, `expected a dsh_word_word name, got ${write}`);
  assert.equal(write, boxNameFor(`${ws}\\`, "workspace-write"), "trailing separator must not change the box");
  assert.equal(write, boxNameFor(ws.toUpperCase(), "workspace-write"), "case must not change the box");
  assert.match(boxNameFor(ws, "read-only"), /^dshr_[a-z]+_[a-z]+$/, "read-only gets its own prefixed name");
  assert.notEqual(write, boxNameFor(ws, "read-only"));
  assert.notEqual(write, boxNameFor("C:\\Users\\someone\\ws2", "workspace-write"));
  // Sandboxie's box-name limits: 34 wide chars, and only alphanumerics/underscore.
  assert.ok(write.length <= 34, `box name too long: ${write}`);
  assert.match(write, /^[A-Za-z0-9_]+$/, "Sandboxie accepts only alphanumerics and underscore");
});

check("the collision fallback walks a deterministic, distinct sequence", () => {
  const ws = "C:\\Users\\someone\\ws";
  const candidates = boxNameCandidates(ws, "workspace-write", 8);
  assert.equal(candidates.length, 8);
  assert.equal(new Set(candidates).size, 8, "candidates must be distinct");
  assert.equal(candidates[0], boxNameFor(ws, "workspace-write"), "first candidate is the plain name");
  assert.deepEqual(candidates, boxNameCandidates(`${ws}\\`, "workspace-write", 8), "sequence must be reproducible");
  for (const candidate of candidates) {
    assert.match(candidate, /^dsh_[a-z]+_[a-z]+$/);
    assert.ok(candidate.length <= 34);
  }
});

check("managed names cover the word scheme and the legacy hex scheme", () => {
  for (const name of ["dsh_brisk_otter", "dshr_calm_heron"]) assert.equal(isManagedBoxName(name), true, name);
  for (const name of ["Dsh_1bdac009", "Dshr_edfd44f2"]) assert.equal(isManagedBoxName(name), true, name);
  for (const name of ["DefaultBox", "BaiduPan", "dsh_x", "dsh_Brisk_Otter", "dsh_brisk-otter"]) {
    assert.equal(isManagedBoxName(name), false, name);
  }
});

check("the hash is a real 64-bit FNV-1a and spreads workspaces apart", () => {
  assert.equal(fnv1a64(""), 0xcbf29ce484222325n);
  assert.equal(fnv1a64("a"), 0xaf63dc4c8601ec8cn);
  const names = new Set();
  for (let i = 0; i < 200; i += 1) names.add(boxNameFor(`C:\\ws\\project-${i}`, "workspace-write"));
  assert.ok(names.size > 190, `200 workspaces should rarely collide, got ${names.size} distinct names`);
});

check("box root sits under the per-user sandbox root", () => {
  const box = boxNameFor("C:\\ws", "workspace-write");
  assert.equal(boxRoot(box), path.join(sbieSandboxRoot(), box));
  assert.ok(canonicalWorkspace("C:\\ws\\") === "C:\\ws" || canonicalWorkspace("C:\\ws\\").length > 0);
});

check("a relocated sandbox folder is reachable: DSH_SBIE_ROOT wins, and boxRoot takes a resolved root", () => {
  const previous = process.env.DSH_SBIE_ROOT;
  try {
    delete process.env.DSH_SBIE_ROOT;
    assert.ok(
      boxRoot("dsh_a_b").endsWith(path.join("Sandbox", process.env.USERNAME ?? "user", "dsh_a_b")),
      "the default layout must survive untouched"
    );
    process.env.DSH_SBIE_ROOT = "D:\\sbie\\root";
    assert.equal(sbieSandboxRoot(), path.resolve("D:\\sbie\\root"));
    assert.equal(boxRoot("dsh_a_b"), path.join("D:\\sbie\\root", "dsh_a_b"));
    assert.equal(boxRoot("dsh_a_b", "E:\\already\\resolved"), path.join("E:\\already\\resolved", "dsh_a_b"));
  } finally {
    if (previous === undefined) delete process.env.DSH_SBIE_ROOT;
    else process.env.DSH_SBIE_ROOT = previous;
  }
});

check("a Sandboxie FileRootPath becomes the box directory, or is refused when it cannot be trusted", () => {
  const env = { USERNAME: "someone", SystemDrive: "C:", WINDIR: "C:\\Windows", USERPROFILE: "C:\\Users\\someone" };
  const expand = (template, box = "dsh_a_b") => expandFileRootPath(template, { box, env });

  assert.equal(expand("D:\\Sbie\\%USER%\\%SANDBOX%"), path.normalize("D:\\Sbie\\someone\\dsh_a_b"));
  assert.equal(expand("D:\\Sbie\\%sandbox%"), path.normalize("D:\\Sbie\\dsh_a_b"), "placeholders are case-insensitive");
  assert.equal(expand("  D:\\Sbie\\%USER%\\%SANDBOX%  "), path.normalize("D:\\Sbie\\someone\\dsh_a_b"), "surrounding space is trimmed");

  // Every refusal below protects the same thing: a directory this plugin would
  // otherwise measure and DELETE as if it were one box's copy.
  assert.equal(expand(""), null);
  assert.equal(expand("   "), null);
  assert.equal(expand(undefined), null);
  assert.equal(expand("D:\\Sbie\\%USER%"), null, "without %SANDBOX% every box would share one directory");
  assert.equal(expand("relative\\%SANDBOX%"), null, "a non-absolute template is not usable");
  assert.equal(expand("D:\\Sbie\\%SID%\\%SANDBOX%"), null, "an unknown placeholder must not be guessed");
  assert.equal(expandFileRootPath("D:\\Sbie\\%SANDBOX%", { box: undefined, env }), null, "…and neither may a missing box name");

  const overridden = { ...env, DSH_SBIE_ROOT: "E:\\override" };
  assert.equal(resolveBoxRoot("dsh_a_b", { template: "D:\\Sbie\\%SANDBOX%", env }), path.normalize("D:\\Sbie\\dsh_a_b"));
  assert.equal(resolveBoxRoot("dsh_a_b", { template: "nonsense", env }), path.normalize("C:\\Sandbox\\someone\\dsh_a_b"));
  assert.equal(
    resolveBoxRoot("dsh_a_b", { template: "D:\\Sbie\\%SANDBOX%", env: overridden }),
    path.join(path.resolve("E:\\override"), "dsh_a_b"),
    "the override outranks a configured template, and names the PARENT"
  );
});

check("the redirect argv is explicit, ordered, and preserves the command verbatim", () => {
  const argv = redirectArgv({
    nodePath: "C:\\node\\node.exe",
    launcherPath: "C:\\plugin\\bin\\dsh-sbie-run.mjs",
    workspace: "C:\\ws",
    argv: ["pwsh", "-Command", "echo hi", "--", "not-a-separator"]
  });
  assert.deepEqual(argv, [
    "C:\\node\\node.exe",
    "C:\\plugin\\bin\\dsh-sbie-run.mjs",
    "--workspace",
    "C:\\ws",
    "--mode",
    "workspace-write",
    "--",
    "pwsh",
    "-Command",
    "echo hi",
    "--",
    "not-a-separator"
  ]);
});

check("every launcher-module helper the CLI calls is actually imported", () => {
  // A missing import binding is not a syntax error and does not throw at import
  // time: it throws a ReferenceError the moment that function runs, which for
  // `--manage show` means a stack trace instead of the box it was asked about.
  // This check exists because exactly that shipped once.
  const source = fs.readFileSync(path.join(pluginDir, "lib", "cli.mjs"), "utf8");
  const imported = new Set();
  for (const match of source.matchAll(/^import\s*\{([^}]*)\}\s*from/gm)) {
    for (const raw of match[1].split(",")) {
      const name = raw.trim().split(/\s+as\s+/).pop();
      if (name) imported.add(name);
    }
  }
  const helpers = [
    "rootFor", "boxRoot", "sbieSandboxRoot", "boxExists", "sbieIni", "reloadConfig", "sbieDir",
    "canonicalWorkspace", "boxNameCandidates", "boxNameFor", "listManagedBoxes", "managedBoxesFor", "removeBox"
  ];
  const missing = helpers.filter((name) => new RegExp(`\\b${name}\\s*\\(`).test(source) && !imported.has(name));
  assert.deepEqual(missing, [], `lib/cli.mjs calls ${missing.join(", ")} without importing it`);
});

check("the launcher's own flags are parsed by its own parser", async () => {
  // The provider's argv must survive parseRunnerArgv; check the contract by
  // shape (the launcher itself is exercised by test/run-tests.mjs inside DSH).
  const argv = redirectArgv({ nodePath: "n", launcherPath: "l", workspace: "C:\\ws", argv: ["cmd", "/c", "exit 7"] });
  const separator = argv.indexOf("--");
  assert.equal(argv[separator + 1], "cmd");
  assert.equal(argv.slice(separator + 1).length, 3);
  assert.equal(argv[argv.indexOf("--workspace") + 1], "C:\\ws");
  assert.equal(argv[argv.indexOf("--mode") + 1], "workspace-write");
});

check("the wrap reports full enforcement and the configured fatal signature", () => {
  const wrap = redirectWrap({ nodePath: "n", launcherPath: "l", workspace: "C:\\ws", argv: ["cmd"] });
  assert.equal(wrap.enforcement, "full");
  assert.deepEqual(wrap.runnerFailureRules, [{ fatalSignatures: [RUNNER_FATAL_SIGNATURE] }]);
  assert.equal(RUNNER_FATAL_SIGNATURE, "dsh-sbie-run: ");
  assert.ok(wrap.denialSignatures.includes("permission denied"));
});

check("the model note carries the operating rules an agent cannot infer", () => {
  // This text is the ONLY channel that reaches a future agent automatically, so
  // each rule below is load-bearing: dropping one costs a hung command or a
  // wrong conclusion about whether the real disk changed.
  const note = redirectPolicyNote("C:\\Users\\someone\\ws");
  const rules = [
    [/shell command/i, "must say to read out-of-workspace writes with a shell command"],
    [/OUTSIDE the sandbox/i, "must say the harness file tools run outside the sandbox"],
    [/merged view/i, "must warn that a shell Test-Path sees the merged view"],
    [/DSH_SBIE_BOX/, "must name the authoritative box env vars"],
    [/resolved against Sandboxie's own state/i, "must warn not to derive the box name from the path"],
    [/sandbox_permissions[^.]*OUTSIDE/i, "must explain that escalation runs the call outside the box"],
    [/written for the ACL presets/i, "must say WHY the parameter description reads like the denial-then-retry story"],
    [/is ever denied/i, "must state that an out-of-workspace write is not denied under this preset"],
    [/no denied command to retry/i, "must tell the agent not to wait for a denial marker before escalating"],
    [/silently captures anything you INSTALL/i, "must warn that out-of-workspace installs land in the copy"],
    [/never enumerate or walk `C:\\Sandbox\\`/i, "must forbid walking C:\\Sandbox from inside the box"],
    [/"--manage"|`--manage`/, "must say --manage cannot run from inside the box"]
  ];
  for (const [pattern, why] of rules) assert.match(note, pattern, why);
});

check("node resolution: env override, then the shipped runtime, then the managed pool — never Electron", () => {
  const fake = "C:\\fake\\node.exe";
  assert.equal(
    resolveNodePath({ env: { DSH_SBIE_NODE: fake }, exists: (p) => p === fake, isElectron: true }),
    fake,
    "the explicit override wins"
  );

  // The desktop app's own Node: the install directory is user-chosen, so
  // resourcesPath is the only handle on it.
  const resources = "C:\\somewhere\\DeepSeek Harness\\resources";
  const shipped = path.join(resources, "runtime", "primary-runtime", "dependencies", "node", "bin", "node.exe");
  assert.equal(
    resolveNodePath({ env: {}, resourcesPath: resources, homeDir: "C:\\no-such-home", isElectron: true, exists: (p) => p === shipped }),
    shipped,
    "the runtime shipped with the app is found through resourcesPath"
  );

  const home = path.join(here, "fixture-home");
  const runtime = path.join(home, ".dsh", "dsh-runtimes", "dsh-primary-runtime", "dependencies", "node", "bin", "node.exe");
  fs.mkdirSync(path.dirname(runtime), { recursive: true });
  fs.writeFileSync(runtime, "");
  try {
    assert.equal(
      resolveNodePath({ env: {}, homeDir: home, resourcesPath: "C:\\nope", isElectron: true, execPath: "C:\\electron.exe" }),
      runtime,
      "the managed runtime pool is the fallback"
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }

  // The case that used to be silent: an Electron host with no node anywhere.
  assert.equal(
    resolveNodePath({ env: {}, homeDir: path.join(here, "no-such-home"), resourcesPath: "C:\\nope", isElectron: true, execPath: "C:\\electron.exe" }),
    null,
    "no node at all must be null, NOT the Electron binary"
  );

  // A plain-Node host (source execution) IS a genuine node, so it is used.
  assert.equal(
    resolveNodePath({
      env: {},
      homeDir: path.join(here, "no-such-home"),
      resourcesPath: "C:\\nope",
      isElectron: false,
      execPath: "C:\\node.exe",
      exists: (p) => p === "C:\\node.exe"
    }),
    "C:\\node.exe",
    "a non-Electron host may use its own interpreter"
  );
});

check("the model note names the workspace and the copy, and warns about the file tools", () => {
  const note = redirectPolicyNote("C:\\Users\\someone\\ws");
  assert.match(note, /copy-on-write/);
  assert.ok(note.includes(JSON.stringify("C:\\Users\\someone\\ws")), "must name the workspace");
  const expectedRoot = boxRoot(boxNameFor("C:\\Users\\someone\\ws", "workspace-write"));
  assert.ok(note.includes(JSON.stringify(expectedRoot)), `must name the copy root ${expectedRoot}`);
  assert.match(note, /shell command/);
  assert.match(note, /refuse writes outside the workspace/);
});

check("the plugin ships the files the profile rows point at", () => {
  for (const rel of [
    "bin/dsh-sbie-run.mjs",
    "lib/provider.mjs",
    "lib/note.mjs",
    "lib/host.mjs",
    "lib/client.js",
    "lib/redirect.mjs",
    "lib/naming.mjs",
    "lib/core.mjs",
    "lib/words.mjs"
  ]) {
    assert.ok(fs.existsSync(path.join(pluginDir, rel)), `missing ${rel}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"));
  assert.equal(manifest.name, "@lone-wolf-akela/dsh-sandboxie-redirect");
  assert.equal(manifest.dsh?.client?.platform, "web");
  assert.equal(manifest.exports?.["./client"]?.default, "./lib/client.js");
  // The module-loader id and the bundle row are both the package name, so the
  // three cannot drift apart silently.
  const clientSource = fs.readFileSync(path.join(pluginDir, "lib", "client.js"), "utf8");
  assert.ok(
    clientSource.includes(`id: ${JSON.stringify(manifest.name)}`),
    "the client half's ModuleLoader id must be the package name"
  );
  assert.ok(
    fs.readFileSync(path.join(pluginDir, "cordis.patch.yml"), "utf8").includes(`name: ${JSON.stringify(manifest.name)}`),
    "the bundle row must name the package"
  );
});

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
