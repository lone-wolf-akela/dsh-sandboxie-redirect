/**
 * Execution-level test: the DELEGATION-INHERITANCE decision, in both consumers.
 *
 * The regression this pins: a delegated subagent was confined by the stock ACL
 * runner. The harness seeds only `auto` and `danger-full-access` into a delegated
 * child and pins the child's approval policy to `never`, so the child's own
 * projection reads `custom` even when its parent runs copy-on-write. The stock
 * `workspace-write` runner then has to materialize a Low mandatory label on the
 * workspace, which needs WRITE_OWNER; a workspace whose inherited DACL grants
 * only Modify fails that grant (Win32 5) and the child's tool runtime never
 * starts — "a subagent cannot call any tool".
 *
 * So two decisions are driven here, through the REAL modules: which runner the
 * shell provider picks, and whether the model-facing note is shown. The lib/
 * directory is copied to a scratch tree and only `./core.mjs` is replaced with a
 * stub that answers every stock confine with a `STOCK`-prefixed argv. Nothing
 * else is faked — redirect.mjs, naming.mjs, host.mjs, note.mjs and tool.mjs are
 * byte-identical to what ships.
 *
 * usage: node test/provider-delegation.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalWorkspace } from "../lib/naming.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.dirname(here);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-sbie-provider-test-"));
const logs = path.join(scratch, "logs");

// Diagnostics must never land in a real user's state directory just because a
// test ran; the plugin honours this override for exactly that. Both are set
// BEFORE the plugin modules are imported: they resolve these at module scope.
process.env.DSH_SBIE_LOG_DIR = logs;
// The redirect resolves a genuine node through this override; using the
// interpreter that runs this test keeps the suite machine-independent.
process.env.DSH_SBIE_NODE = process.execPath;
// A nonexistent configuration makes the note's box-root lookup deterministic
// instead of depending on this machine's Sandboxie.ini.
process.env.DSH_SBIE_INI = path.join(scratch, "Sandboxie.ini");

// The provider's companions report to stderr while a provider is constructed.
// That is expected here (their services are stubbed out), so hold the noise and
// release it only if the suite fails.
const capturedStderr = [];
const realStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk) => {
  capturedStderr.push(String(chunk));
  return true;
};

const WORKSPACE = "C:\\Users\\someone\\workspace";
const COMMAND = ["pwsh", "-Command", "echo ok"];

/**
 * Stand-in for the three harness imports the provider and its companions make.
 * The base class answers the stock path with an argv a test can recognise, so no
 * real ACL runner (and no machine-specific grant) is involved.
 */
const CORE_STUB = [
  "class StubService {",
  "  constructor(ctx, name) { this.ctx = ctx; this.name = name; }",
  "}",
  "",
  "class StubLocalSandbox extends StubService {",
  "  constructor(ctx, config) { super(ctx, \"sandbox\"); }",
  "  async confine(argv, policy) {",
  "    return { argv: [\"STOCK\", ...argv], enforcement: \"stock\", mode: policy?.mode };",
  "  }",
  "}",
  "",
  "export function importCore(specifier) {",
  "  if (specifier === \"@deepseek-ai/cordis\") return Promise.resolve({ Service: StubService });",
  "  if (specifier === \"@deepseek-ai/dsh-sandbox-local\") return Promise.resolve({ default: StubLocalSandbox });",
  "  if (specifier === \"@deepseek-ai/dsh-tools\") return Promise.resolve({ defineTool: (tool) => tool });",
  "  return Promise.reject(new Error(\"unexpected importCore(\" + specifier + \")\"));",
  "}",
  ""
].join("\n");

const corePath = path.join(scratch, "core.mjs");
fs.writeFileSync(corePath, CORE_STUB, "utf8");
const coreUrl = JSON.stringify(pathToFileURL(corePath).href);

const libDir = path.join(scratch, "lib");
fs.mkdirSync(libDir);
for (const name of fs.readdirSync(path.join(pluginDir, "lib"))) {
  if (!name.endsWith(".mjs") || name === "core.mjs") continue;
  const source = fs
    .readFileSync(path.join(pluginDir, "lib", name), "utf8")
    .replace(/from\s+["']\.\/core\.mjs["']/g, "from " + coreUrl)
    .replace(/import\(\s*["']\.\/core\.mjs["']\s*\)/g, "import(" + coreUrl + ")");
  fs.writeFileSync(path.join(libDir, name), source, "utf8");
}

const Provider = (await import(pathToFileURL(path.join(libDir, "provider.mjs")).href)).default;
const applyNote = (await import(pathToFileURL(path.join(libDir, "note.mjs")).href)).apply;

let passed = 0;
async function check(label, body) {
  try {
    await body();
    passed += 1;
    console.log("PASS  " + label);
  } catch (error) {
    console.log("FAIL  " + label + "  — " + error.message);
    process.exitCode = 1;
  }
}

function session(id, header) {
  return { id, header: Object.assign({ id, cwd: WORKSPACE }, header) };
}

/** One provider over the supplied imperative state (sessions, knob states, derived presets). */
function providerWith(sessions, states, currents) {
  const services = {
    sessions: { list: () => sessions },
    sessionProjections: { stateOf: (candidate) => states.get(String(candidate.id)) },
    permissionPresets: { current: (candidate) => currents.get(String(candidate.id)) || "custom" }
  };
  return new Provider({
    get: (name) => services[name],
    // The companions (header chip, note, sandbox_clear) register through inject
    // and have their own tests; runner choice does not depend on them.
    inject: () => {}
  });
}

/** Run one confine and classify the chosen runner. */
async function runnerFor(provider, policy) {
  const result = await provider.confine(COMMAND, Object.assign({ workspaceRoot: WORKSPACE }, policy), undefined);
  if (result.argv[0] === "STOCK") return { runner: "stock", result };
  assert.ok(String(result.argv[1]).endsWith("dsh-sbie-run.mjs"), "a non-stock runner must be our launcher");
  return { runner: "redirect", result };
}

/** The note text note.mjs contributes for one session. */
function noteFor(sessions, states, target) {
  const services = {
    sessions: { list: () => sessions },
    sessionProjections: { stateOf: (candidate) => states.get(String(candidate.id)) }
  };
  let render;
  const ctx = {
    inject: (deps, callback) => {
      callback({
        get: (name) => services[name],
        systemPrompt: {
          context: (definition) => {
            render = definition.text;
          },
          getContextOrder: () => 0
        }
      });
    }
  };
  applyNote(ctx);
  assert.equal(typeof render, "function", "note.mjs must contribute a systemPrompt context");
  return render({ agent: { session: target } });
}

const root = session("root");
const child = session("child", { origin: "subagent", parentSession: "root" });
const grandchild = session("grandchild", { origin: "subagent", parentSession: "child" });
const stockRoot = session("stock-root");
const copyOnWrite = new Map([["root", { preset: "copy-on-write" }], ["child", { preset: null }], ["grandchild", { preset: null }]]);

// ---------------------------------------------------------------------------
// Which runner: the decision that used to be wrong for subagents
// ---------------------------------------------------------------------------

await check("a copy-on-write session is redirected", async () => {
  const provider = providerWith([root], new Map([["root", { preset: "copy-on-write" }]]), new Map([["root", "copy-on-write"]]));
  const { runner } = await runnerFor(provider, { mode: "workspace-write", sessionId: "root" });
  assert.equal(runner, "redirect");
});

await check("a DELEGATED session inherits copy-on-write (the reported bug)", async () => {
  const provider = providerWith([root, child], copyOnWrite, new Map([["root", "copy-on-write"], ["child", "custom"]]));
  const { runner, result } = await runnerFor(provider, { mode: "workspace-write", sessionId: "child" });
  assert.equal(runner, "redirect", "the subagent's runtime must be confined by the box, not the stock ACL runner");
  assert.equal(result.enforcement, "full");
  assert.equal(result.argv[0], process.execPath, "the launcher must run on a genuine node");
  assert.equal(result.argv[result.argv.indexOf("--workspace") + 1], canonicalWorkspace(WORKSPACE));
  assert.equal(result.argv[result.argv.indexOf("--mode") + 1], "workspace-write");
  assert.deepEqual(result.argv.slice(result.argv.indexOf("--") + 1), COMMAND, "the command must survive verbatim");
});

await check("inheritance follows a subagent's subagent", async () => {
  const provider = providerWith([root, child, grandchild], copyOnWrite, new Map([["root", "copy-on-write"]]));
  const { runner } = await runnerFor(provider, { mode: "workspace-write", sessionId: "grandchild" });
  assert.equal(runner, "redirect");
});

await check("a selection that only the knobs match still counts", async () => {
  // A session restored from a bundle can match the preset bundle without ever
  // writing permission/preset; the permission service answers that case.
  const provider = providerWith([root], new Map([["root", {}]]), new Map([["root", "copy-on-write"]]));
  const { runner } = await runnerFor(provider, { mode: "workspace-write", sessionId: "root" });
  assert.equal(runner, "redirect");
});

// ---------------------------------------------------------------------------
// What must NOT be inherited
// ---------------------------------------------------------------------------

await check("a stock parent does not make its child copy-on-write", async () => {
  const provider = providerWith(
    [stockRoot, child],
    new Map([["stock-root", { preset: "workspace-write" }], ["child", { preset: null }]]),
    new Map([["stock-root", "workspace-write"]])
  );
  const { runner } = await runnerFor(provider, { mode: "workspace-write", sessionId: "child" });
  assert.equal(runner, "stock");
});

await check("an explicit selection on the child wins over inheritance", async () => {
  const provider = providerWith(
    [root, child],
    new Map([["root", { preset: "copy-on-write" }], ["child", { preset: "workspace-write" }]]),
    new Map([["root", "copy-on-write"], ["child", "workspace-write"]])
  );
  const { runner } = await runnerFor(provider, { mode: "workspace-write", sessionId: "child" });
  assert.equal(runner, "stock", "inheritance must never override a deliberately chosen preset");
});

await check("a read-only policy never takes the copy-on-write runner", async () => {
  // The redirect always executes workspace-write, so choosing it for a read-only
  // call would widen the call instead of narrowing it.
  const provider = providerWith([root], new Map([["root", { preset: "copy-on-write" }]]), new Map([["root", "copy-on-write"]]));
  const { runner } = await runnerFor(provider, { mode: "read-only", sessionId: "root" });
  assert.equal(runner, "stock");
});

await check("danger-full-access is left to the stock path", async () => {
  const provider = providerWith([root], new Map([["root", { preset: "copy-on-write" }]]), new Map([["root", "copy-on-write"]]));
  const { runner } = await runnerFor(provider, { mode: "danger-full-access", sessionId: "root" });
  assert.equal(runner, "stock");
});

await check("a call without a session id keeps the agentless stock path", async () => {
  const provider = providerWith([root], new Map(), new Map());
  const { runner } = await runnerFor(provider, { mode: "workspace-write" });
  assert.equal(runner, "stock");
});

await check("a parent that is not resident contributes nothing", async () => {
  const provider = providerWith([child], new Map([["child", { preset: null }]]), new Map());
  const { runner } = await runnerFor(provider, { mode: "workspace-write", sessionId: "child" });
  assert.equal(runner, "stock");
});

await check("a parentSession without the delegation origin is not inheritance", async () => {
  const lineage = session("lineage", { parentSession: "root" });
  const provider = providerWith(
    [root, lineage],
    new Map([["root", { preset: "copy-on-write" }], ["lineage", { preset: null }]]),
    new Map([["root", "copy-on-write"]])
  );
  const { runner } = await runnerFor(provider, { mode: "workspace-write", sessionId: "lineage" });
  assert.equal(runner, "stock");
});

await check("an unknown session id falls back to stock", async () => {
  const provider = providerWith([root], new Map([["root", { preset: "copy-on-write" }]]), new Map([["root", "copy-on-write"]]));
  const { runner } = await runnerFor(provider, { mode: "workspace-write", sessionId: "absent" });
  assert.equal(runner, "stock");
});

// ---------------------------------------------------------------------------
// The model-facing note follows the same rule, or a subagent is told the wrong thing
// ---------------------------------------------------------------------------

await check("the note explains the box to a copy-on-write session", () => {
  const note = noteFor([root], new Map([["root", { preset: "copy-on-write" }]]), root);
  assert.match(note, /copy-on-write/);
  assert.ok(note.includes(JSON.stringify(canonicalWorkspace(WORKSPACE))), "the note must name the workspace");
  assert.match(note, /shell command/);
});

await check("the note reaches a DELEGATED session too", () => {
  // A subagent's shell commands share the box, so it needs the same operating
  // rules; its own projection reads custom, which is why this needs the walk.
  for (const target of [child, grandchild]) {
    const note = noteFor([root, child, grandchild], copyOnWrite, target);
    assert.match(note, /copy-on-write/, target.id + " must be told about the box");
    assert.match(note, /merged view/, target.id + " must get the operating rules");
  }
});

await check("the note stays absent for every session that is not copy-on-write", () => {
  const states = new Map([["root", { preset: "copy-on-write" }], ["child", { preset: "workspace-write" }], ["stock-root", { preset: "workspace-write" }]]);
  assert.equal(noteFor([root], states, stockRoot), "", "a stock session must not be told about a box");
  assert.equal(noteFor([root, child], states, child), "", "an explicit choice on the child must win here too");
  const lineage = session("lineage", { parentSession: "root" });
  assert.equal(noteFor([root, lineage], states, lineage), "", "lineage without the delegation origin is not inheritance");
  const childless = [...copyOnWrite].filter(([id]) => id !== "root");
  assert.equal(noteFor([child], new Map(childless), child), "", "a parent that is not resident contributes nothing");
  assert.equal(noteFor([root], new Map([["root", { preset: "copy-on-write" }]]), undefined), "", "no session, no note");
  const noWorkspace = { id: "nw", header: { id: "nw", origin: "subagent", parentSession: "root" } };
  assert.equal(
    noteFor([root, noWorkspace], new Map([["root", { preset: "copy-on-write" }], ["nw", { preset: null }]]), noWorkspace),
    "",
    "a session without a workspace cannot name the copy"
  );
});

// ---------------------------------------------------------------------------
// The decision is recorded, so a future report is answerable
// ---------------------------------------------------------------------------

await check("the inherited decision is logged once, with the parent that authorised it", () => {
  const log = fs.readFileSync(path.join(logs, "provider.log"), "utf8");
  const line = log.split(/\r?\n/).find((entry) => entry.includes("delegated session child inherits copy-on-write"));
  assert.ok(line, "the child's inherited confinement must be traceable in provider.log");
  assert.match(line, /parent root/, "the log must name the session that authorised the inheritance");
});

fs.rmSync(scratch, { recursive: true, force: true });
process.stderr.write = realStderrWrite;
if (process.exitCode) {
  console.log("\n--- captured provider diagnostics ---");
  console.log(capturedStderr.join("").trim());
}
console.log("\n" + passed + " checks passed" + (process.exitCode ? " (with failures)" : ""));
