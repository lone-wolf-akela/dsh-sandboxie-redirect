// Validate the profile patch with the same YAML implementation the harness
// bundles, plus the structural expectations the permission/sandbox rows have.
// usage: node validate-patch.mjs [patch.yml]      (default: this bundle's own)
//
// The parser must be js-yaml, the implementation the harness itself parses
// layers with (its `yaml` dependency has a different API). It is looked up in
// three places, in this order: the devDependency of this repository, a copy
// extracted next to the workspace, and the copy inside an installed DSH profile
// — so the check runs on a fresh clone and on a user machine alike.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(here, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(repoDir, "package.json"), "utf8"));

/**
 * Module-level imports that could throw inside the Electron host: anything that
 * is not a Node builtin, plus any relative sibling that transitively is not
 * builtins-only either.
 *
 * This is the pin that cost the most to learn. An earlier `tool.mjs` imported
 * `boxes.mjs` at module level, which loads koffi — a native module that fails
 * to load in the Electron host. The failure happened before any of the file's
 * own code could run, so the row simply never registered: no tool, no error.
 * Relative siblings are allowed now, but only while they keep the same rule.
 */
function moduleLevelViolations(file, seen = new Set()) {
  if (seen.has(file)) return [];
  seen.add(file);
  let source;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch {
    return [`${path.relative(repoDir, file)} (unreadable)`];
  }
  const violations = [];
  for (const match of source.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)) {
    const specifier = match[1];
    if (specifier.startsWith("node:")) continue;
    if (specifier.startsWith(".")) {
      const target = path.resolve(path.dirname(file), specifier);
      if (!fs.existsSync(target)) violations.push(`${specifier} (missing)`);
      else violations.push(...moduleLevelViolations(target, seen));
      continue;
    }
    violations.push(specifier);
  }
  return violations;
}

async function loadYaml() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
  const candidates = [
    process.env.DSH_YAML,
    path.join(repoDir, "node_modules", "js-yaml", "dist", "js-yaml.mjs"),
    path.join(repoDir, "asar-yaml", "js-yaml", "dist", "js-yaml.mjs"),
    path.resolve(repoDir, "..", "asar-yaml", "js-yaml", "dist", "js-yaml.mjs"),
    path.join(home, "profiles", "node_modules", "js-yaml", "dist", "js-yaml.mjs")
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return (await import(pathToFileURL(candidate).href)).default;
  }
  console.error([
    "js-yaml was not found for this check.",
    "Install the dev dependencies (`pnpm install`) or point DSH_YAML at a copy:",
    "  DSH_YAML=/path/to/js-yaml/dist/js-yaml.mjs node test/validate-patch.mjs",
    `looked in:\n  ${candidates.join("\n  ")}`
  ].join("\n"));
  process.exit(2);
}
const yaml = await loadYaml();

const file = process.argv[2] ?? path.join(repoDir, "cordis.patch.yml");
console.log(`patch file: ${file}`);
const text = fs.readFileSync(file, "utf8");

// The harness patches may use `!!js` expressions; accept them as raw strings.
const JsTag = new yaml.Type("tag:yaml.org,2002:js", {
  kind: "scalar",
  resolve: () => true,
  construct: (data) => ({ __js: data })
});
const schema = yaml.DEFAULT_SCHEMA.extend([JsTag]);

let entries;
try {
  entries = yaml.load(text, { schema });
} catch (error) {
  console.error(`YAML PARSE FAILED: ${error.message}`);
  process.exit(1);
}
console.log(`YAML parses. top-level entries: ${entries.length}`);

const failures = [];
const need = (ok, message) => {
  if (!ok) failures.push(message);
};

const ids = entries.filter((e) => e && e.id).map((e) => e.id);
console.log(`rows: ${ids.join(", ")}`);

// --- the sandbox row: DISABLED, never renamed -----------------------------
//
// The patch vocabulary makes this the only workable shape. On a non-insert
// patch, `applyEntryPatches` keeps `id` plus the remaining overrides and treats
// `name` as a GUARD: it skips the patch entirely when `name` differs from the
// target row's name. Re-pointing `sandbox` at our module therefore does nothing
// at all (silently, with only a loader warning) — which is exactly how an
// earlier revision of this file shipped a provider that never loaded. So:
// disable the stock row, and add the provider as its own row.
const STOCK_SANDBOX = "@deepseek-ai/dsh-sandbox-local";
const sandbox = entries.find((e) => e?.id === "sandbox" && !e.insert);
need(sandbox !== undefined, "missing `sandbox` row");
if (sandbox) {
  console.log(`sandbox row  = disabled=${sandbox.disabled === true} name=${sandbox.name}`);
  need(sandbox.disabled === true, "the stock `sandbox` row must be disabled (it cannot be re-pointed: `name` is a guard)");
  need(
    sandbox.name === undefined || sandbox.name === STOCK_SANDBOX,
    `the sandbox row's name must stay ${STOCK_SANDBOX} (a different name makes the loader SKIP the patch)`
  );
  need(sandbox.config === undefined || sandbox.config.runnerCommand === undefined, "sandbox row must NOT carry runnerCommand (it would apply to every mode)");
}

// --- the provider must be its own INSERTED row ----------------------------
//
// Two shapes are legitimate and both are accepted here. The BUNDLE layer names
// the package (`dsh-sandboxie-redirect`), and Node resolution finds the
// installed code through the profile's package graph. A local `--patch` overlay
// names the provider FILE instead, because the loader resolves overlay paths
// relative to the profile directory. The directory whose sources get checked
// below follows from the shape.
const isPathLike = (name) => path.isAbsolute(name) || name.startsWith("./") || name.startsWith("../");
const providerRow = entries
  .flatMap((e) => e?.insert ?? [])
  .find((e) => typeof e?.name === "string" && (
    e.name === manifest.name ||
    e.name === `${manifest.name}/provider` ||
    (isPathLike(e.name) && fs.existsSync(e.name))
  ));
need(providerRow !== undefined, "the copy-on-write provider must be an inserted row of its own naming this package");
/** The tree the mounting row resolves to: the checkout, or the installed copy a path row points at. */
let packageDir = repoDir;
if (providerRow) {
  console.log(`provider row = ${providerRow.id} -> ${providerRow.name}`);
  need(typeof providerRow.id === "string" && providerRow.id.length > 0, "the inserted provider row needs its own id");
  need(providerRow.id !== "sandbox", "the inserted provider must NOT reuse the stock `sandbox` id");
  if (isPathLike(providerRow.name)) {
    need(providerRow.name.endsWith("provider.mjs"), `a path row must name the provider entry, got ${providerRow.name}`);
    packageDir = path.resolve(path.dirname(providerRow.name), "..");
  } else {
    // A package row loads the package's own entry point, so that entry point has
    // to BE the provider. It used to be host.mjs, and a bundle row would then
    // have mounted the wrong half — with the sandbox provider missing entirely.
    const mainEntry = manifest.exports?.["."]?.default ?? manifest.main ?? "";
    need(
      path.basename(mainEntry) === "provider.mjs",
      `a package row loads the package's main export, so it must be the provider (got ${mainEntry})`
    );
  }
}

// --- the permission row: the fourth preset, merged, order preserved ---------
const permission = entries.find((e) => e?.id === "permission");
need(permission !== undefined, "missing `permission` row (the fourth preset would not appear)");
let presetName;
if (permission) {
  const declared = permission.config?.presets;
  const STOCK = {
    "read-only": { sandbox: "read-only", approval: "ask" },
    "workspace-write": { sandbox: "workspace-write", approval: "ask" },
    "danger-full-access": { sandbox: "danger-full-access", approval: "never" }
  };
  /**
   * Evaluate a computed `presets` value the way the loader will: as an
   * expression with a `ctx` in scope. `base` is what the earlier layers
   * composed, which the expression reads through `ctx.loader.entries()`.
   *
   * Running the expression (rather than only checking that it parses) is the
   * point: the merge is the one place where this plugin's configuration depends
   * on the host's runtime, and a silent mistake there removes the SHIPPED
   * presets from the picker.
   */
  const evaluatePresets = (expression, base) => {
    const rows = base === undefined ? [] : [{ options: { id: "permission", config: { presets: base } } }];
    const ctx = { loader: { entries: () => rows } };
    return new Function("ctx", `return (${expression});`)(ctx);
  };
  const computed = declared !== null && typeof declared === "object" && typeof declared.__js === "string";
  const presets = computed ? evaluatePresets(declared.__js, undefined) : (declared ?? {});
  const names = Object.keys(presets);
  console.log(`presets (${computed ? "computed, earlier layers unreadable" : "declared"}; order): ${names.join(", ")}`);
  presetName = presets["copy-on-write"]?.name;
  console.log(`copy-on-write name        = ${JSON.stringify(presetName)}`);
  need(names.length === 4, `expected 4 presets, found ${names.length}`);
  need(JSON.stringify(names) === JSON.stringify(["read-only", "workspace-write", "copy-on-write", "danger-full-access"]),
    "preset order must keep copy-on-write AFTER workspace-write so fresh sessions still default to workspace-write");
  const combos = { "read-only": ["read-only", "ask"], "workspace-write": ["workspace-write", "ask"], "copy-on-write": ["workspace-write", "ask"], "danger-full-access": ["danger-full-access", "never"] };
  for (const [key, [sandboxMode, approval]] of Object.entries(combos)) {
    const spec = presets[key];
    need(spec !== undefined, `missing preset ${key}`);
    if (spec) {
      need(spec.sandbox === sandboxMode, `${key}: sandbox must be ${sandboxMode} (got ${spec.sandbox}) — only the three legal modes are accepted`);
      need(spec.approval === approval, `${key}: approval must be ${approval} (got ${spec.approval})`);
    }
  }
  // `custom` and `auto` are reserved and would throw at construction.
  need(presets.custom === undefined && presets.auto === undefined, "`custom` and `auto` are reserved preset names");
  need(typeof presets["copy-on-write"]?.name === "string" && presets["copy-on-write"].name.length > 0, "copy-on-write needs a display name");
  for (const key of ["read-only", "workspace-write", "danger-full-access"]) {
    need(presets[key]?.name === undefined, `${key} must NOT carry a name, or the client loses its localized label`);
  }
  if (computed) {
    // The reason the value is computed at all: a preset another bundle (or a
    // newer DSH) contributes must survive, and ours must still sit right after
    // workspace-write without touching the rest.
    const extra = { ...STOCK, "added-by-another-bundle": { sandbox: "workspace-write", approval: "ask" } };
    const merged = evaluatePresets(declared.__js, extra);
    const mergedNames = Object.keys(merged);
    need(mergedNames.includes("added-by-another-bundle"), "a computed preset list must KEEP presets contributed by earlier layers");
    need(
      mergedNames.indexOf("copy-on-write") === mergedNames.indexOf("workspace-write") + 1,
      "…and still place copy-on-write immediately after workspace-write"
    );
    need(
      merged["read-only"]?.sandbox === "read-only" && merged["read-only"]?.approval === "ask" && merged["danger-full-access"]?.approval === "never",
      "…and leave the earlier layers' entries untouched"
    );
  }
}

// --- ONE loader entry per plugin package, and the package must be reachable ---
//
// The client-modules registry composes a `dsh.client` package only while exactly
// ONE of its loader entries is active; a second one fails the entire boot with
// "resolves from multiple active Loader sources … remove one entry", which left
// the app usable only through "disable third-party plugins". Which entries count
// depends on activation timing, so this was a race rather than a stable state —
// hence a pin, not a convention: every row (config and insert) that points into
// this plugin's directory must be the same single entry.
const inserted = entries.filter((e) => e?.insert).flatMap((e) => e.insert);
/** Whether a row name refers to this plugin — by package name, or by path into the mounted tree. */
const namesThisPackage = (rowName) => {
  if (typeof rowName !== "string") return false;
  if (isPathLike(rowName)) return path.resolve(rowName).startsWith(packageDir + path.sep);
  return rowName === manifest.name || rowName.startsWith(`${manifest.name}/`);
};
// Imported, not read as text: the value-schema mirror has to be RUN against the
// installed schema, which is the schema that will actually be compiled at boot.
const installedToolSchema = await import(pathToFileURL(path.join(packageDir, "lib", "tool-schema.mjs")).href);
const valueViolations = installedToolSchema.valueSchemaViolations;
const rowsIntoPackage = [...entries, ...inserted]
  .map((entry) => entry?.name)
  .filter(namesThisPackage);
console.log(`rows into this package: ${rowsIntoPackage.length}`);
for (const rowName of rowsIntoPackage) console.log(`  ${rowName}`);
need(
  rowsIntoPackage.length === 1,
  `exactly ONE loader row may point into this dsh.client package (found ${rowsIntoPackage.length}); the client-modules registry refuses to compose a package with several active sources`
);

// --- the note, the projection and the tool must be wired, not mounted ---
const providerSource = fs.readFileSync(path.join(packageDir, "lib", "provider.mjs"), "utf8");
for (const wired of ["applyNote", "applyHostHalf", "applyTool"]) {
  need(providerSource.includes(`mount(`) && providerSource.includes(wired), `provider.mjs must wire ${wired} (that half has no row of its own any more)`);
}

// --- the note half is reachable through the package it now shares ---
const note = inserted.find((e) => e?.id === "dsh-sandboxie-redirect-note");
need(note === undefined, "the note must NOT have its own insert row any more (one entry per package)");

// --- the agent-facing `sandbox_clear` tool ---
const toolPath = path.join(packageDir, "lib", "tool.mjs");
need(fs.existsSync(toolPath), `missing the sandbox_clear implementation at ${toolPath}`);
const toolSource = fs.readFileSync(toolPath, "utf8");
{
  need(toolSource.includes('name: "sandbox_clear"'), "the tool must register a tool named sandbox_clear");
  need(
    // The output schema lives in its own module so it can be checked OFFLINE.
    // Mirrored from the shipped compiler: `required` is legal only on a
    // property-map entry, never on the root, an `items` object or a `oneOf`
    // branch — and the root and items mistakes each cost a restart before this
    // check existed.
    valueViolations(installedToolSchema.OUTPUT_SCHEMA).length === 0,
    `the tool's output schema breaks the value schema DSL: ${valueViolations(installedToolSchema.OUTPUT_SCHEMA).join("; ")}`
  );
  need(
    valueViolations({ type: "object", additionalProperties: false, required: true, properties: {} }).length === 1 &&
      valueViolations({
        type: "object",
        additionalProperties: false,
        properties: {
          a: { type: "array", required: true, items: { type: "object", additionalProperties: false, required: true, properties: {} } }
        }
      }).length === 1,
    "the value-schema mirror must still reject a root-level and an items-level `required` (negative controls)"
  );
  need(
    toolSource.includes("valueSchemaViolations(OUTPUT_SCHEMA)"),
    "the tool must pre-flight its own schema before defineTool, so a schema error is logged instead of thrown"
  );  // THE PIN THAT MATTERS MOST. The first version imported boxes.mjs at module
  // level, which loads koffi — a native module. In the Electron host that import
  // failed and the row never registered: no tool, and no diagnostic, because a
  // module-level failure happens before any of the file's own code can log. So
  // the module level may import Node builtins ONLY, and the native work must go
  // to a child process running the launcher under the managed Node runtime.
  const moduleLevel = moduleLevelViolations(toolPath);
  need(
    moduleLevel.length === 0,
    `the tool's module level must reach Node builtins only (found ${moduleLevel.join(", ")}): an import that throws there kills the row before it can log`
  );
  need(
    !/from\s+"\.\/(boxes|sbie|koffi)\.mjs"/.test(toolSource) && !/\bkoffi\b/.test(toolSource.replace(/^[\s\S]*?\/\*\*[\s\S]*?\*\//, "")),
    "sandbox_clear must not pull the native Sandboxie bindings into the Electron host"
  );
  need(
    /import\("\.\/core\.mjs"\)/.test(toolSource) && /importCore\("@deepseek-ai\/dsh-tools"\)/.test(toolSource),
    "defineTool must be imported lazily, through the asar-aware core loader (bare specifiers do not resolve for a path-mounted plugin)"
  );
  need(
    /spawnSync\(node, \[launcher, "--manage", "clean", workspace\]/.test(toolSource),
    "clearing must run the launcher's `--manage clean` in a plain-Node child, the path the launcher already owns"
  );
  need(
    !/process\.execPath/.test(toolSource) || /NEVER `process\.execPath`/.test(toolSource),
    "the child must NOT be started with process.execPath (that is the Electron binary in the host)"
  );
  // The safety property that makes this tool acceptable in EVERY permission
  // mode: it can only ever reach boxes Sandboxie attributes to this session's
  // workspace, so it must never accept a box name or a path from the model.
  need(!/args\.(box|boxes|path|root|workspace)\b/.test(toolSource), "sandbox_clear must not take a box name or path from the model");
  need(
    /sectionOwnsWorkspace\(body, workspace\)/.test(toolSource),
    "sandbox_clear must resolve its targets with the same ownership test the header chip uses"
  );
  need(/tool\.log|LOG_PATH/.test(toolSource), "sandbox_clear must log to tool.log so a host-side failure is visible");
}

// --- the host half that publishes the box-name projection ---
//
// It has NO row of its own any more: the package may carry exactly one loader
// entry, so provider.mjs imports and wires it (asserted above). Only its file
// has to exist.
const hostHalfPath = path.join(packageDir, "lib", "host.mjs");
need(fs.existsSync(hostHalfPath), `host half target does not exist: ${hostHalfPath}`);
console.log(`host half    = ${hostHalfPath} (wired by the provider, no row of its own)`);
{
  const hostSource = fs.readFileSync(hostHalfPath, "utf8");
  need(
    // The projections service calls `wire.viewSchema.parse(...)` unconditionally
    // when it publishes and when it snapshots, so a wire registered with an
    // UNDEFINED schema throws on every publish: the chip then freezes at
    // whatever `init` last built — "the name disappeared and never came back".
    // zod is resolved through the asar-aware loader and may legitimately be
    // unavailable, so the fallback must be a schema-like object, never nothing.
    /PASS_THROUGH/.test(hostSource) && /viewSchema,/.test(hostSource),
    "host.mjs must register a view schema that is always defined (fall back to a pass-through, never to nothing)"
  );
  need(/host\.log/.test(hostSource), "host.mjs must log transitions to host.log so a frozen chip can be traced");
  need(
    // THE PIN THAT COST THE MOST TO LEARN. This half is wired from the sandbox
    // provider's CONSTRUCTOR. Registering the projection eagerly there — while
    // `sessionProjections` may not resolve yet — puts it on an instance that is
    // never driven: no cell is created, `apply` is never called, `wire.view` is
    // never produced, and the header chip silently never renders (not even at
    // load, because snapshots iterate cells). Registering through `ctx.inject`,
    // as note.mjs does, fixes it — so the pattern is asserted, not trusted.
    /ctx\.inject\(\["sessionProjections"\]/.test(hostSource) && /scope\.sessionProjections\.register\(/.test(hostSource),
    'host.mjs must register its projection through ctx.inject(["sessionProjections"], …), never eagerly from the provider constructor'
  );
}

// --- the browser half must be declared the way the shell discovers it ---
const pluginRoot = path.resolve(here, "..");
const manifestPath = path.join(pluginRoot, "package.json");
need(fs.existsSync(manifestPath), `missing package.json in ${pluginRoot}`);
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const client = manifest.dsh?.client;
  console.log(`dsh.client   = ${JSON.stringify(client)}`);
  need(client !== undefined, "package.json must declare dsh.client or the browser half is never loaded");
  need(client?.platform === "web", "dsh.client.platform must be 'web'");
  need(Array.isArray(client?.inject), "dsh.client.inject must be an array");
  const clientEntry = path.join(pluginRoot, manifest.exports?.["./client"]?.default ?? "lib/client.js");
  need(fs.existsSync(clientEntry), `browser half missing: ${clientEntry}`);
  const clientSource = fs.readFileSync(clientEntry, "utf8");
  need(
    clientSource.includes("window.__ModuleLoader__.load("),
    "the browser half must be evaluated through window.__ModuleLoader__.load (client halves are not ES modules)"
  );
  need(clientSource.includes('require("react")'), "the browser half must require React from the shell's module registry");
  need(
    clientSource.includes("conversation.session.header.actions"),
    "the browser half must register into the title-adjacent header actions slot (beside the agent-preset and job chips)"
  );
  need(
    !clientSource.includes("conversation.session.header.utilities"),
    "the browser half must NOT register into the far-right utilities slot"
  );
  need(
    // The configured glyph is the FLOOR of the ladder: it is host config
    // rendered verbatim in every surface, so an icon exists even if the DOM half
    // below fails entirely. That is why it stays in the name.
    typeof presetName === "string" && /^[^\p{L}\p{N}\s]/u.test(presetName),
    `the copy-on-write preset name must start with a glyph (it is the fallback when the DOM half cannot draw one); got ${JSON.stringify(presetName)}`
  );
  need(
    // …and the DOM half may only UPGRADE it, never be the sole source. These pins
    // are the contract that kept breaking: address BOTH surfaces the name is
    // rendered in (dropdown list AND composer trigger) by ARIA rather than by
    // hashed CSS-module classes, never insert nodes into React's positional child
    // array, and never strip the configured glyph unless the generated one is
    // proven to render.
    /new\s+MutationObserver/.test(clientSource) &&
      /\[role="menu"\]/.test(clientSource) &&
      /aria-label\*=/.test(clientSource),
    "the browser half must address BOTH name surfaces (dropdown list and composer trigger) by ARIA"
  );
  need(
    /previousElementSibling/.test(clientSource),
    "the leading-glyph test must inspect PRECEDING siblings: the trigger's trailing chevron is also a span holding an SVG"
  );
  need(
    // The flag must be REVOCABLE. React reuses the label span when the preset
    // changes and never removes an attribute it did not set, so a flag left
    // behind keeps drawing our glyph next to the product's own icon — the
    // observed "two icons after switching away from copy-on-write".
    /removeAttribute\(LABEL_FLAG\)/.test(clientSource),
    "the glyph flag must be removed when the label is no longer this preset, or the glyph survives a mode change and the control shows two icons"
  );
  need(
    !/insertBefore|\.prepend\(/.test(clientSource) && !/\brow\.appendChild|\blabel\.appendChild/.test(clientSource),
    "the glyph shim must not insert nodes into the menu (attribute + generated stylesheet only)"
  );
  need(
    /getComputedStyle\(label, "::before"\)\.content === "none"[\s\S]{0,80}?continue/.test(clientSource),
    "the configured text glyph may only be stripped AFTER the generated glyph is confirmed to render"
  );
  need(
    clientSource.includes('PRESET_ID = "copy-on-write"') && clientSource.includes("PRESET_ID) return null"),
    "the browser half must gate the chip on the copy-on-write preset, not show a box name in every mode"
  );
  need(
    clientSource.includes("permissions") && clientSource.includes("sandboxBox"),
    "the browser half must read BOTH the permissions preset and the host's box projection"
  );
  need(clientSource.includes("exports.apply"), "the browser half must export apply");
  need(clientSource.includes("exports.inject"), "the browser half must export inject");
  const clientId = /id:\s*"([^"]+)"/.exec(clientSource)?.[1];
  need(clientId === manifest.name, `the module-loader id (${clientId}) must equal the package name (${manifest.name})`);
}

// --- every referenced plugin path must exist ---
for (const entry of [...entries.filter((e) => e?.name && path.isAbsolute(e.name)), ...inserted.filter((e) => e?.name && path.isAbsolute(e.name))]) {
  need(fs.existsSync(entry.name), `referenced plugin path missing: ${entry.name}`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} PROBLEM(S):`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log("\nAll structural checks passed.");
