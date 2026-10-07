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
import { boxNameCandidates, boxNameFor, boxRoot, canonicalWorkspace, fnv1a64, isManagedBoxName, sbieSandboxRoot } from "../lib/naming.mjs";
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
    [/silently captures anything you INSTALL/i, "must warn that out-of-workspace installs land in the copy"],
    [/never enumerate or walk `C:\\Sandbox\\`/i, "must forbid walking C:\\Sandbox from inside the box"],
    [/"--manage"|`--manage`/, "must say --manage cannot run from inside the box"]
  ];
  for (const [pattern, why] of rules) assert.match(note, pattern, why);
});

check("node resolution prefers the env override, then the managed runtime", () => {
  const fake = "C:\\fake\\node.exe";
  assert.equal(resolveNodePath({ env: { DSH_SBIE_NODE: fake }, exists: (p) => p === fake, execPath: "C:\\electron.exe" }), fake);

  const home = path.join(here, "fixture-home");
  const runtime = path.join(home, ".dsh", "dsh-runtimes", "dsh-primary-runtime", "dependencies", "node", "bin", "node.exe");
  fs.mkdirSync(path.dirname(runtime), { recursive: true });
  fs.writeFileSync(runtime, "");
  try {
    assert.equal(resolveNodePath({ env: {}, homeDir: home, execPath: "C:\\electron.exe" }), runtime);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }

  assert.equal(resolveNodePath({ env: {}, homeDir: path.join(here, "no-such-home"), execPath: "C:\\electron.exe" }), "C:\\electron.exe");
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
  assert.equal(manifest.name, "dsh-sandboxie-redirect");
  assert.equal(manifest.dsh?.client?.platform, "web");
  assert.equal(manifest.exports?.["./client"]?.default, "./lib/client.js");
});

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
