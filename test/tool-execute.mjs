/**
 * Execution tests for the `sandbox_clear` tool.
 *
 * The tool half runs inside the Electron host, so it cannot be imported as-is
 * offline: it reaches for the harness bundle (`importCore("@deepseek-ai/dsh-tools")`)
 * and for the real `child_process`. This test loads a scratch copy of the REAL
 * `lib/tool.mjs` with exactly three imports redirected — the harness loader, the
 * Node runtime lookup and `spawnSync` — then drives `execute` for every mode.
 * Everything else (the argument handling, the ownership test, the size
 * accounting, the ini reader) is the shipped code.
 *
 * WHY THIS EXISTS. `mode: "status"` shipped referencing `workspace` before its
 * `const` declaration in the same function body — a temporal-dead-zone
 * `ReferenceError` that no source-level check notices and that made the mode
 * fail every time it was called. The first check below is that reproduction; the
 * rest pin the other modes so a regression in any of them is a failed test
 * rather than a report from a user.
 *
 * usage: node test/tool-execute.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as naming from "../lib/naming.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.dirname(here);
// Diagnostics must never land in a real user's state directory because a test ran.
const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-sbie-tool-log-"));
process.env.DSH_SBIE_LOG_DIR = LOG_DIR;

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

async function checkAsync(label, body) {
  try {
    await body();
    passed += 1;
    console.log(`PASS  ${label}`);
  } catch (error) {
    console.log(`FAIL  ${label}  — ${error.message}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Load the real tool with three imports redirected
// ---------------------------------------------------------------------------

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-sbie-tool-test-"));
const iniPath = path.join(scratch, "Sandboxie.ini");
process.env.DSH_SBIE_INI = iniPath;

const coreStubPath = path.join(scratch, "core-stub.mjs");
fs.writeFileSync(
  coreStubPath,
  [
    "// Harness loader stand-in: captures the defineTool config instead of compiling it.",
    "export const registered = [];",
    "export async function importCore(specifier) {",
    '  if (specifier === "@deepseek-ai/dsh-tools") {',
    "    return { defineTool: (config) => { registered.push(config); return config; } };",
    "  }",
    '  throw new Error(`unexpected importCore(${specifier})`);',
    "}",
    ""
  ].join("\n"),
  "utf8"
);

const childStubPath = path.join(scratch, "child-stub.mjs");
fs.writeFileSync(
  childStubPath,
  [
    "// Child-process stand-in: records the launcher invocation instead of running it.",
    "export const spawned = [];",
    "export function spawnSync(command, args, options) {",
    "  spawned.push({ command, args, options });",
    '  return { status: 0, stdout: "cleaned", stderr: "" };',
    "}",
    ""
  ].join("\n"),
  "utf8"
);

const FAKE_NODE = "C:\\fake\\node.exe";
const redirectStubPath = path.join(scratch, "redirect-stub.mjs");
fs.writeFileSync(
  redirectStubPath,
  [`export const NODE = ${JSON.stringify(FAKE_NODE)};`, "export function resolveNodePath() { return NODE; }", ""].join("\n"),
  "utf8"
);

const absolute = (...parts) => JSON.stringify(pathToFileURL(path.join(pluginDir, ...parts)).href);
const toolSource = fs.readFileSync(path.join(pluginDir, "lib", "tool.mjs"), "utf8");
const loadable = toolSource
  .replace(/from\s+"node:child_process"/, `from ${JSON.stringify(pathToFileURL(childStubPath).href)}`)
  .replace(/from\s+"\.\/log\.mjs"/, `from ${absolute("lib", "log.mjs")}`)
  .replace(/from\s+"\.\/redirect\.mjs"/, `from ${JSON.stringify(pathToFileURL(redirectStubPath).href)}`)
  .replace(/await import\("\.\/core\.mjs"\)/, `await import(${JSON.stringify(pathToFileURL(coreStubPath).href)})`)
  .replace(/await import\("\.\/tool-schema\.mjs"\)/, `await import(${absolute("lib", "tool-schema.mjs")})`)
  .replace(/await import\("\.\/host\.mjs"\)/, `await import(${absolute("lib", "host.mjs")})`)
  .replace(/await import\("\.\/naming\.mjs"\)/, `await import(${absolute("lib", "naming.mjs")})`);
assert.notEqual(loadable, toolSource, "the import rewrite must have changed something");
for (const banned of ["node:child_process", '"./core.mjs"', '"./redirect.mjs"', '"./host.mjs"', '"./naming.mjs"', '"./tool-schema.mjs"']) {
  assert.ok(!loadable.includes(banned), `the scratch copy still reaches for ${banned}`);
}
const loadedToolPath = path.join(scratch, "tool-under-test.mjs");
fs.writeFileSync(loadedToolPath, loadable, "utf8");

const tool = await import(pathToFileURL(loadedToolPath).href);
const host = await import(pathToFileURL(path.join(pluginDir, "lib", "host.mjs")).href);
const { registered } = await import(pathToFileURL(coreStubPath).href);
const { spawned } = await import(pathToFileURL(childStubPath).href);

const WORKSPACE = "C:\\Users\\someone\\workspace";
const CANONICAL = naming.canonicalWorkspace(WORKSPACE);
const session = { id: "session-tool-test", seq: 42, header: { cwd: WORKSPACE } };
const exec = { agent: { session } };

// ---------------------------------------------------------------------------
// Registration and its wiring
// ---------------------------------------------------------------------------

const injectionCalls = [];
let registryUnavailable = false;
const scope = {
  tools: { register: () => {} },
  get(name) {
    if (registryUnavailable) throw new Error("registry unavailable");
    return name === "sessionProjections"
      ? { stateOf: () => ({ box: "dsh_test_box", root: "C:\\Sandbox\\someone\\dsh_test_box" }) }
      : undefined;
  }
};
await tool.apply({
  inject: (deps, callback) => {
    injectionCalls.push(deps);
    callback(scope);
  }
});

const config = registered[0];

await checkAsync("registration happens once, through the tools service", async () => {
  assert.deepEqual(injectionCalls, [["tools"]]);
  assert.equal(registered.length, 1, "defineTool must be called exactly once");
  assert.equal(config.name, "sandbox_clear");
  assert.deepEqual(config.parameters.mode.enum, ["inspect", "clear", "status"]);
  assert.equal(typeof config.execute, "function");
  assert.equal(config.presentCall({ mode: "clear" }).title, "Clear the sandbox copy");
  assert.equal(config.presentCall({ mode: "inspect" }).title, "Inspect the sandbox copy");
});

// ---------------------------------------------------------------------------
// Fixture configuration
// ---------------------------------------------------------------------------

const BOX = host.boxForHeader({ cwd: WORKSPACE }).box;
// Sandboxie's FileRootPath names the BOX's own folder, so the template must keep
// `%SANDBOX%` — a template without it is refused on purpose (see naming.mjs).
const COPY_PARENT = path.join(scratch, "copies");
const COPY_ROOT = path.join(COPY_PARENT, BOX);

function writeIni(sections) {
  const text = sections.map(([name, lines]) => [`[${name}]`, ...lines].join("\r\n")).join("\r\n\r\n");
  fs.writeFileSync(iniPath, `${text}\r\n`, "utf16le");
  host.invalidateBoxCache();
}

function writeOwnedBox() {
  fs.mkdirSync(path.join(COPY_ROOT, "drive", "C"), { recursive: true });
  fs.writeFileSync(path.join(COPY_ROOT, "drive", "C", "a.txt"), "0123456789", "utf8");
  fs.writeFileSync(path.join(COPY_ROOT, "drive", "C", "b.txt"), "01234", "utf8");
  writeIni([
    ["GlobalSettings", ["Template=Edge_Fix"]],
    [BOX, [`FileRootPath=${path.join(COPY_PARENT, "%SANDBOX%")}`, `OpenFilePath=${CANONICAL}\\*`]]
  ]);
}

writeIni([["GlobalSettings", ["Template=Edge_Fix"]]]);

// ---------------------------------------------------------------------------
// The modes
// ---------------------------------------------------------------------------

await checkAsync("REGRESSION: mode status resolves and carries the workspace", async () => {
  // Before the fix this threw `ReferenceError: Cannot access 'workspace' before
  // initialization`, because the const that names it was declared below the
  // early return in the same function body.
  const value = await config.execute({ mode: "status" }, exec);
  assert.equal(value.action, "status");
  assert.equal(value.workspace, CANONICAL, "status must report the canonical workspace");
  assert.deepEqual(value.copies, []);
  assert.deepEqual(value.cleared, []);
  assert.match(value.note, /projections=present/, "the note must report the projection registry");
  assert.match(value.note, /session=session-tool-test/);
  assert.match(value.note, /seq=42/);
  assert.ok(value.note.includes(JSON.stringify({ box: "dsh_test_box", root: "C:\\Sandbox\\someone\\dsh_test_box" })), value.note);
});

await checkAsync("mode status survives an unreachable projection registry", async () => {
  registryUnavailable = true;
  try {
    const value = await config.execute({ mode: "status" }, exec);
    assert.match(value.note, /status query threw: registry unavailable/, value.note);
    assert.equal(value.workspace, CANONICAL);
  } finally {
    registryUnavailable = false;
  }
});

await checkAsync("mode inspect reports the copy with its size", async () => {
  writeOwnedBox();
  const value = await config.execute({ mode: "inspect" }, exec);
  assert.equal(value.action, "inspect");
  assert.equal(value.workspace, CANONICAL);
  assert.equal(value.copies.length, 1, `expected one copy, got ${JSON.stringify(value.copies)}`);
  const [copy] = value.copies;
  assert.equal(copy.box, BOX);
  assert.equal(copy.root, COPY_ROOT);
  assert.equal(copy.files, 2);
  assert.equal(copy.bytes, 15);
  assert.equal(copy.truncated, false);
  assert.deepEqual(value.cleared, []);
  assert.match(value.note, /Call again with mode: "clear"/);
  assert.equal(spawned.length, 0, "inspect must never spawn anything");
});

await checkAsync("mode inspect on a workspace with no box says so instead of erroring", async () => {
  writeIni([["GlobalSettings", ["Template=Edge_Fix"]]]);
  const value = await config.execute({ mode: "inspect" }, exec);
  assert.deepEqual(value.copies, []);
  assert.match(value.note, /No copy exists for this workspace/);
});

await checkAsync("mode clear runs the launcher's --manage clean in a child process", async () => {
  writeOwnedBox();
  const before = spawned.length;
  const value = await config.execute({ mode: "clear" }, exec);
  assert.equal(value.action, "clear");
  assert.equal(value.workspace, CANONICAL);
  assert.equal(spawned.length, before + 1, "clear must spawn the launcher exactly once");
  const call = spawned[spawned.length - 1];
  assert.equal(call.command, FAKE_NODE, "the child must run under a resolved Node, never the host binary");
  assert.equal(call.args.length, 4);
  assert.equal(call.args[1], "--manage");
  assert.equal(call.args[2], "clean");
  assert.equal(call.args[3], CANONICAL, "clear must target the canonical workspace, not the raw cwd");
  assert.deepEqual(value.copies.map((copy) => copy.box), [BOX]);
  assert.match(value.note, /Nothing to clear|The copies are gone/, value.note);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** `render` is pure, so each action's text can be pinned without touching the world. */
function renderedText(value) {
  const parts = config.output.render({}, value);
  assert.equal(parts.length, 1, "render returns exactly one part");
  assert.equal(parts[0].type, "text");
  return parts[0].text;
}

check("each action gets its own head line", () => {
  const status = renderedText({ action: "status", workspace: CANONICAL, copies: [], cleared: [], note: "detail" });
  assert.ok(status.startsWith(`Session projection state for ${CANONICAL}.`), status);
  assert.ok(!status.includes("found."), `a status query must not answer in inspect's wording: ${status}`);
  assert.ok(status.endsWith("detail"), "the projection detail must survive rendering");

  const inspect = renderedText({
    action: "inspect",
    workspace: CANONICAL,
    copies: [{ box: BOX, root: COPY_ROOT, files: 2, bytes: 1536, truncated: false }],
    cleared: [],
    note: "n"
  });
  assert.ok(inspect.startsWith(`Sandbox copies for ${CANONICAL}: 1 found.`), inspect);
  assert.match(inspect, new RegExp(`- ${BOX}: 2 file\\(s\\), 1\\.5 KB at `), inspect);

  const empty = renderedText({ action: "inspect", workspace: CANONICAL, copies: [], cleared: [], note: "n" });
  assert.ok(empty.startsWith(`Sandbox copies for ${CANONICAL}: 0 found.`), empty);

  const cleared = renderedText({ action: "clear", workspace: CANONICAL, copies: [], cleared: [BOX], note: "n" });
  assert.ok(cleared.startsWith(`Cleared 1 sandbox copy/copies for ${CANONICAL}.`), cleared);

  const truncated = renderedText({
    action: "inspect",
    workspace: CANONICAL,
    copies: [{ box: BOX, root: COPY_ROOT, files: 20000, bytes: 1024, truncated: true }],
    cleared: [],
    note: "n"
  });
  assert.match(truncated, /\(counting stopped early\)/, truncated);
});

/** `execute` throws synchronously on its refusal paths and resolves otherwise; accept both. */
async function expectFailure(fn, pattern) {
  try {
    await fn();
  } catch (error) {
    assert.match(String(error?.message ?? error), pattern);
    return;
  }
  assert.fail(`expected the call to fail with ${pattern}`);
}

await checkAsync("a caller without a workspace is refused", async () => {
  await expectFailure(() => config.execute({ mode: "inspect" }, { agent: { session: { id: "s" } } }), /needs the calling session's workspace/);
});

await checkAsync("an unreadable configuration is refused rather than guessed", async () => {
  process.env.DSH_SBIE_INI = path.join(scratch, "missing", "Sandboxie.ini");
  host.invalidateBoxCache();
  try {
    await expectFailure(() => config.execute({ mode: "clear" }, exec), /refusing to act/);
  } finally {
    process.env.DSH_SBIE_INI = iniPath;
    host.invalidateBoxCache();
  }
});

console.log(`\n${passed} checks passed${process.exitCode === 1 ? " (some FAILED)" : ""}`);
if (process.exitCode === 1) console.log(`diagnostics: ${LOG_DIR}`);
