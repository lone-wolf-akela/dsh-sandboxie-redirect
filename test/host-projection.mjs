/**
 * Host-half tests: the session projection that carries the Sandboxie box name.
 *
 * Plain Node, no Electron and no harness bundle. The host half is loaded from
 * a scratch copy, so this test works even when the file reaches for the harness
 * bundle: no relative `./core.mjs` import survives the rewrite, and the cases
 * below prove the definition does not need one to be built.
 *
 * Two things are pinned here, and they are the two that have burned us:
 *
 * 1. HARDENING. An earlier version appended a `sandbox/box` session event, and
 *    the harness refuses to reload any log containing an event type it does not
 *    know unless the envelope carries `ignorable: true` — a marker live
 *    `Session.append()` cannot set. Every session written by that version
 *    stopped opening. Nothing on this path may append a session event again.
 *
 * 2. WHEN THE NAME IS KNOWABLE. A box's name is only decided once the box
 *    exists (collisions are resolved against Sandboxie's own state), so the
 *    projection must report nothing until this workspace owns a box, and must
 *    start reporting as the session advances afterwards.
 *
 * usage: node test/host-projection.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.dirname(here);
// Diagnostic files must never land in a real user's state directory just
// because a test ran; the plugin honours this override for exactly that.
process.env.DSH_SBIE_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-sbie-host-log-"));
const hostSource = fs.readFileSync(path.join(pluginDir, "lib", "host.mjs"), "utf8");
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

const WORKSPACE = "C:\\Users\\someone\\workspace";
const OTHER_WORKSPACE = "C:\\Users\\someone\\other";
const HEADER = {
  version: 4,
  id: "session-host-projection-test",
  createdAt: 1,
  cwd: WORKSPACE,
  isSeeded: false,
  delegationDepth: 0
};

/**
 * A fixture configuration file, read through the real reader (the file is
 * UTF-16LE, so a wrong encoding would silently find no sections at all).
 */
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-sbie-host-test-"));
const iniPath = path.join(scratch, "Sandboxie.ini");
process.env.DSH_SBIE_INI = iniPath;

/** Import the host half without touching the module cache or the bundle. */
const loadable = hostSource
  .replace(/from\s+"\.\/naming\.mjs"/, `from ${JSON.stringify(pathToFileURL(path.join(pluginDir, "lib", "naming.mjs")).href)}`)
  .replace(/from\s+"\.\/core\.mjs"/, `from ${JSON.stringify(pathToFileURL(path.join(pluginDir, "lib", "core.mjs")).href)}`)
  .replace(/from\s+"\.\/log\.mjs"/, `from ${JSON.stringify(pathToFileURL(path.join(pluginDir, "lib", "log.mjs")).href)}`);
const hostModulePath = path.join(scratch, "host.mjs");
fs.writeFileSync(hostModulePath, loadable, "utf8");
const host = await import(pathToFileURL(hostModulePath).href);

/** This workspace's first-choice box name — exactly what the launcher would create. */
const OWN_BOX = host.boxForHeader(HEADER).box;
const FOREIGN_BOX = host.boxForHeader({ cwd: OTHER_WORKSPACE }).box;

function writeIni(sections) {
  const text = sections.map(([name, lines]) => [`[${name}]`, ...lines].join("\r\n")).join("\r\n\r\n");
  fs.writeFileSync(iniPath, `${text}\r\n`, "utf16le");
  // Drop the reader's short memo so the next call sees the new file. (Calling
  // `readIniSections(0)` would NOT do it: a `now` in the past still satisfies
  // `now - at < MEMO` and returns the stale value.)
  host.invalidateBoxCache();
}

const EMPTY_INI = [["GlobalSettings", ["Template=Edge_Fix"]]];
// Start with a configuration that has no box for this workspace yet.
writeIni(EMPTY_INI);

const appends = [];
const session = {
  header: HEADER,
  append: (type, data) => {
    appends.push({ type, data });
    return { type, seq: appends.length, time: 0, data };
  }
};

const listeners = [];
let definition;
const ctx = {
  effect: () => () => {},
  on: (name, listener) => {
    listeners.push(name);
    void listener;
    return () => {};
  },
  get: () => undefined,
  sessions: { list: () => [session] },
  sessionProjections: {
    register: (value) => {
      definition = value;
      return () => {};
    },
    stateOf: () => undefined
  }
};
// `apply` registers through `ctx.inject`, the way note.mjs does, so that the
// registration lands on the live registry once the service exists. The fake ctx
// mirrors cordis: the callback runs with this same context.
ctx.inject = (deps, callback) => {
  for (const dep of deps) if (!(dep in ctx)) throw new Error(`fake ctx is missing the ${dep} service`);
  callback(ctx);
};
await host.apply(ctx);

// ---------------------------------------------------------------------------
// Hardening: nothing here may touch the session log
// ---------------------------------------------------------------------------

check("the host half folds the box without the harness bundle", () => {
  assert.notEqual(definition, undefined, "the projection must register even when the bundle is unreachable");
  assert.equal(typeof definition.init, "function");
  assert.equal(typeof definition.apply, "function");
  assert.equal(typeof definition.wire.view, "function");
});

check("the projection key and the retired event type are the agreed strings", () => {
  assert.equal(host.BOX_PROJECTION, "sandboxBox");
  assert.equal(host.LEGACY_BOX_EVENT, "sandbox/box");
});

check("apply registers exactly one projection, even with no bundle", () => {
  assert.notEqual(definition, undefined, "the projection must register");
  assert.equal(definition.key, "sandboxBox");
});

check("the old session/created listener is gone", () => {
  assert.deepEqual(listeners, [], "host.mjs must not subscribe to session/created");
});

check("no code path appends a session event any more", () => {
  assert.deepEqual(appends, [], `the host half must never append to a session, got ${JSON.stringify(appends)}`);
  const code = hostSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.doesNotMatch(code, /\.append\s*\(/, "host.mjs must not call session.append() in code");
  assert.doesNotMatch(code, /session\/created/, "host.mjs must not hook session/created");
});

check("stateVersion is bumped so a cached row of an older shape is discarded", () => {
  // v1 stored an event-derived value; v2 froze the box at the sessions first event;`r`n  // v3 carried the workspace so the box could be re-checked; v4 stopped trusting the`r`n  // retired event, which is a behaviour change that must invalidate checkpointed rows.
  assert.equal(definition.stateVersion, 5);
});

// ---------------------------------------------------------------------------
// When the name is knowable
// ---------------------------------------------------------------------------

check("init reports NO box while the workspace owns none", () => {
  const state = definition.init(HEADER, 0);
  assert.equal(state.box, null, "a name must not be guessed before the box exists");
  assert.equal(state.root, null);
  assert.equal(state.cwd, WORKSPACE, "the workspace must be carried for later re-checks");
});

check("init reports the box once the workspace owns one", () => {
  writeIni([[OWN_BOX, ["Enabled=y", `OpenFilePath=${WORKSPACE}\\*`]]]);
  const state = definition.init(HEADER, 0);
  assert.equal(state.box, OWN_BOX);
  assert.equal(state.root, host.boxForHeader(HEADER).root);
  writeIni(EMPTY_INI);
});

check("a box owned by ANOTHER workspace is never reported as ours", () => {
  const sections = host.parseIniSections(`[${OWN_BOX}]\r\nOpenFilePath=${OTHER_WORKSPACE}\\*\r\n`);
  assert.equal(host.ownedBoxFor(WORKSPACE, sections), null, "a foreign box must be stepped over, not adopted");
});

check("the first candidate this workspace owns wins, in launcher order", () => {
  const candidates = host.boxNameCandidates(WORKSPACE, "workspace-write", 12);
  const sections = host.parseIniSections(
    [`[${candidates[0]}]`, `OpenFilePath=${OTHER_WORKSPACE}\\*`, `[${candidates[1]}]`, `OpenFilePath=${WORKSPACE}\\*`].join("\r\n")
  );
  const owned = host.ownedBoxFor(WORKSPACE, sections);
  assert.equal(owned.box, candidates[1], "candidate 0 belongs to someone else");
});

check("apply publishes the box as the session advances, with one new reference", () => {
  const before = definition.init(HEADER, 0);
  assert.equal(
    definition.apply(before, { type: "user/message", seq: 0, time: 1, data: {} }),
    before,
    "an unbound state must stay the same reference"
  );

  // The launcher creates the box; the next committed event must notice it.
  writeIni([[OWN_BOX, ["Enabled=y", `OpenFilePath=${WORKSPACE}\\*`]]]);
  const after = definition.apply(before, { type: "tool/result", seq: 1, time: 2, data: {} });
  assert.notEqual(after, before, "noticing the box must produce a new reference (that is what republishes the view)");
  assert.equal(after.box, OWN_BOX);
  assert.equal(after.cwd, WORKSPACE, "the new state must keep the workspace");

  // Once bound, later events keep the same reference so the change feed stays quiet.
  assert.equal(definition.apply(after, { type: "user/message", seq: 2, time: 3, data: {} }), after);
  writeIni(EMPTY_INI);
});

check("a bound box that DISAPPEARS is cleared, so the chip cannot outlive it", () => {
  // Deleting the sandbox (SandMan, or `--manage clean`) must retract the chip.
  // Latching the first non-null answer would leave it claiming a dead box.
  writeIni([[OWN_BOX, ["Enabled=y", `OpenFilePath=${WORKSPACE}\\*`]]]);
  const bound = definition.apply(definition.init(HEADER, 0), { type: "tool/result", seq: 1, time: 2, data: {} });
  assert.equal(bound.box, OWN_BOX);

  writeIni(EMPTY_INI);
  const cleared = definition.apply(bound, { type: "tool/result", seq: 2, time: 3, data: {} });
  assert.notEqual(cleared, bound, "losing the box must produce a new reference (that is what retracts the chip)");
  assert.equal(cleared.box, null);
  assert.equal(cleared.cwd, WORKSPACE, "the workspace must survive so a recreated box is noticed again");
  assert.equal(definition.wire.view(cleared).box, null);

  // And it comes back if the box is recreated.
  writeIni([[OWN_BOX, ["Enabled=y", `OpenFilePath=${WORKSPACE}\\*`]]]);
  const again = definition.apply(cleared, { type: "tool/result", seq: 3, time: 4, data: {} });
  assert.equal(again.box, OWN_BOX);
  writeIni(EMPTY_INI);
});

check("an UNREADABLE configuration never clears a bound box", () => {
  // "Cannot tell" must not be read as "there is no box": a transient read
  // failure would otherwise hide the chip for a box that still exists.
  const bound = { cwd: WORKSPACE, box: OWN_BOX, root: host.boxForHeader(HEADER).root };
  const previous = process.env.DSH_SBIE_INI;
  process.env.DSH_SBIE_INI = path.join(scratch, "missing-so-nothing-can-be-told.ini");
  host.invalidateBoxCache();
  try {
    assert.equal(
      definition.apply(bound, { type: "tool/result", seq: 9, time: 9, data: {} }),
      bound,
      "an unreadable config must keep the current state reference"
    );
  } finally {
    process.env.DSH_SBIE_INI = previous;
    host.invalidateBoxCache();
  }
});

check("apply ignores unrelated events and keeps the same reference", () => {
  const state = definition.init(HEADER, 0);
  for (const event of [
    { type: "sandbox/mode", seq: 0, time: 1, data: { mode: "workspace-write" } },
    { type: "permission/preset", seq: 1, time: 1, data: { preset: "copy-on-write" } },
    { type: "user/message", seq: 2, time: 2, data: {} },
    { type: "sandbox/box", seq: 3, time: 3, data: { box: "dsh_x_y", root: "C:\\Sandbox\\u\\dsh_x_y" } }
  ]) {
    assert.equal(definition.apply(state, event), state, `unexpected fold for ${event.type}`);
  }
});

check("the retired event NEVER decides the box, however well-formed it is", () => {
  // This is the regression that made the header chip claim a sandbox Sandboxie
  // did not have: a repaired log carries `sandbox/box` rows with the marker, and
  // folding them back in reports a name recorded in the past as the present.
  const state = definition.init(HEADER, 0);
  const folded = definition.apply(state, {
    type: host.LEGACY_BOX_EVENT,
    seq: 3,
    time: 4,
    data: { box: "dsh_legacy_name", root: "C:\\Sandbox\\someone\\dsh_legacy_name" },
    ignorable: true
  });
  assert.equal(folded, state, "a recorded name is history, not evidence the box exists now");
  assert.equal(folded.box, null);
});

check("the retired event is tolerated in every shape (no throw, no fold)", () => {
  const state = definition.init(HEADER, 0);
  for (const event of [
    { type: host.LEGACY_BOX_EVENT, seq: 3, time: 4, data: { box: "dsh_x_y", root: "C:\\Sandbox\\u\\dsh_x_y" } },
    { type: host.LEGACY_BOX_EVENT, seq: 4, time: 5, data: {}, ignorable: true },
    { type: host.LEGACY_BOX_EVENT, seq: 5, time: 6, data: { box: "" }, ignorable: true },
    { type: host.LEGACY_BOX_EVENT, seq: 6, time: 7, data: { box: 7 }, ignorable: true },
    { type: host.LEGACY_BOX_EVENT, seq: 7, time: 8, data: null, ignorable: true }
  ]) {
    assert.equal(definition.apply(state, event), state, `unexpected fold for ${JSON.stringify(event.data)}`);
  }
});

check("the retired payload stays readable for diagnostics", () => {
  const payload = host.boxFromLegacyEvent({ data: { box: "dsh_recorded_then", root: "C:\\Sandbox\\u\\dsh_recorded_then" } });
  assert.deepEqual(payload, { box: "dsh_recorded_then", root: "C:\\Sandbox\\u\\dsh_recorded_then" });
  // A root-less payload falls back to the conventional root for that box name.
  assert.equal(host.boxFromLegacyEvent({ data: { box: "dsh_recorded_then" } }).root.endsWith("dsh_recorded_then"), true);
  assert.equal(host.boxFromLegacyEvent({ data: {} }), undefined);
  assert.equal(host.boxFromLegacyEvent(undefined), undefined);
});

// ---------------------------------------------------------------------------
// Reading the configuration file
// ---------------------------------------------------------------------------

check("the configuration parser reads UTF-16LE sections, not NUL-mangled ones", () => {
  const sections = host.parseIniSections("[GlobalSettings]\r\nTemplate=X\r\n\r\n[dsh_brisk_otter]\r\nEnabled=y\r\n");
  assert.deepEqual([...sections.keys()], ["globalsettings", "dsh_brisk_otter"]);
  assert.deepEqual(sections.get("dsh_brisk_otter"), ["Enabled=y"]);
});

check("the reader survives a missing configuration file", () => {
  const previous = process.env.DSH_SBIE_INI;
  process.env.DSH_SBIE_INI = path.join(scratch, "does-not-exist.ini");
  host.invalidateBoxCache();
  assert.equal(host.readIniSections(), null, "an unreadable file must answer null, never throw");
  process.env.DSH_SBIE_INI = previous;
  host.invalidateBoxCache();
});

check("init returns null for a header without a usable cwd", () => {
  for (const header of [{}, { cwd: "" }, { cwd: 42 }, undefined]) {
    assert.equal(definition.init(header, 0), null, `expected null for ${JSON.stringify(header)}`);
  }
});

check("the wire view produces the client shape and tolerates a null state", () => {
  writeIni([[OWN_BOX, ["Enabled=y", `OpenFilePath=${WORKSPACE}\\*`]]]);
  const view = definition.wire.view(definition.init(HEADER, 0));
  assert.equal(view.box, OWN_BOX);
  assert.equal(typeof view.root, "string");

  writeIni(EMPTY_INI);
  const empty = definition.wire.view(definition.init(HEADER, 0));
  assert.equal(empty.box, null);
  assert.equal(empty.root, null);
  assert.deepEqual(definition.wire.view(null), { box: null, root: null });
});

// The fixture must not follow us out of the test (the real plugin reads the
// real configuration file, and an override left in the environment would make
// a later process blind to every box).
delete process.env.DSH_SBIE_INI;
fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\n${passed} passed${process.exitCode === 1 ? ", with failures" : ""}`);
