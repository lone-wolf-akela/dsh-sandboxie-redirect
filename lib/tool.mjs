/**
 * The `sandbox_clear` tool — let the agent discard this workspace's Sandboxie
 * copy without leaving the conversation.
 *
 * WHY THIS EXISTS
 * ---------------
 * Under the copy-on-write preset, reads and writes outside the workspace are
 * served from a per-workspace copy. That is the point of the mode, but in a long
 * task it creates two problems a shell command cannot fix:
 *
 *  - a STALE copy from an earlier run masks the real state (a file "exists" that
 *    the real disk does not have, or an old virtualised edit is still in force);
 *  - a copy that only grows (every `%TEMP%` write, every download) hides the
 *    real filesystem behind it.
 *
 * Discarding the copy needs Sandboxie's own API, which a BOXED process cannot
 * reach (Sandboxie hides the box list from one), so a shell command cannot do
 * it. The harness process can, which is also why this tool works in every
 * permission mode: the mode governs how commands are spawned, not what a
 * host-side tool may do.
 *
 * WHY IT LOOKS LIKE THIS (a real failure, not a preference)
 * --------------------------------------------------------
 * The first version imported `boxes.mjs`, which loads koffi — a NATIVE module.
 * The launcher is a plain-Node process where koffi loads fine (that is how
 * `--manage` has always worked), but this half runs inside the Electron host,
 * and the row never registered: no tool, and no error anyone could see, because
 * a module-level import failure happens before any of this file's code can log.
 * So now:
 *
 *  - the module level imports NOTHING but Node builtins, so every failure below
 *    is reached and logged to `tool.log`;
 *  - native work happens in a CHILD process running the launcher under the
 *    managed Node runtime — the exact path `--manage clean` already uses;
 *  - the ownership question is answered with pure fs (the same helpers the
 *    header chip uses), so no native module is needed to decide what is ours.
 *
 * SAFETY
 * ------
 *  - It never takes a box name or a path from the model. The only boxes it can
 *    touch are those whose Sandboxie configuration grants THIS session's
 *    workspace access — the same test the chip uses, so what the tool reports
 *    and what the user sees cannot disagree.
 *  - `mode: "clear"` is explicit and is the only thing that deletes; `inspect`
 *    is a pure read, including the size accounting. Both exist because anything
 *    living only in the copy is destroyed by a clear.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logFile } from "./log.mjs";
import { resolveNodePath } from "./redirect.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "..");
/** Diagnostics land in the plugin's state directory, never inside the package. */
const LOG_PATH = logFile("tool.log");

/** Stop accounting after this many files or this long, and say so. */
const WALK_FILE_CAP = 20000;
const WALK_MS_CAP = 3000;

/** Append one diagnostic line; a diagnostic must never be the reason a call fails. */
function log(message) {
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* nothing sensible to do here */
  }
}

/**
 * The registrant context, kept for `mode: "status"`. Null outside a live plugin.
 * @type {any}
 */
let pluginScope = null;

/** Size up one copy tree. Host-side on purpose: walking `C:\Sandbox\…` from inside the box hangs. */
function measure(root) {
  let files = 0;
  let bytes = 0;
  let truncated = false;
  if (!fs.existsSync(root)) return { files, bytes, truncated };
  const started = Date.now();
  const stack = [root];
  while (stack.length > 0) {
    if (files >= WALK_FILE_CAP || Date.now() - started > WALK_MS_CAP) {
      truncated = true;
      break;
    }
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      files += 1;
      try {
        bytes += fs.statSync(full).size;
      } catch {
        /* a file that vanished mid-walk simply does not count */
      }
    }
  }
  return { files, bytes, truncated };
}

/**
 * Every box whose Sandboxie configuration grants this workspace access, with its
 * size. Pure fs — no Sandboxie API, no native module. Exported so a test (and
 * the `inspect-copies` CLI) can run it against the real configuration.
 * @param host - the loaded host half (its config helpers).
 * @param naming - the loaded naming helpers (`boxRoot`).
 * @param workspace - the session workspace.
 * @param options.sizes - pass false to skip the walk; the caller is then running
 *   INSIDE a box, where measuring `C:\Sandbox\…` recurses into the redirection
 *   layer and hangs.
 */
export function copiesFor(host, naming, workspace, options = {}) {
  const sections = host.readIniSections();
  if (sections === null) return null;
  const copies = [];
  for (const [box, body] of sections) {
    if (!host.sectionOwnsWorkspace(body, workspace)) continue;
    const root = naming.boxRoot(box);
    copies.push(options.sizes === false ? { box, root } : { box, root, ...measure(root) });
  }
  return copies;
}

function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const DESCRIPTION = [
  "Discard this workspace's Sandboxie copy — the redirected writes the copy-on-write permission preset collects for paths OUTSIDE the workspace.",
  "Use it when a command's view of the filesystem disagrees with the real disk (a file that exists only in the copy, or a stale copy from an earlier run masking the real state), or to reclaim the space a long task accumulated.",
  '`mode: "inspect"` only reports; `mode: "clear"` stops the box\'s processes, deletes its copy and drops its Sandboxie configuration, so the next copy-on-write command starts from a fresh empty box. Anything that exists ONLY in the copy is destroyed, so inspect first when the copy may hold the only copy of something.',
  "Only boxes whose Sandboxie configuration grants THIS session's workspace access can be touched, and the tool works in every permission mode because it runs in the harness process rather than in the sandbox."
].join(" ");

/**
 * Register `sandbox_clear`.
 * @param ctx - registrant context carrying the tool registry.
 */
export async function apply(ctx) {
  try {
    // Everything risky is imported HERE, not at module level: a throw above this
    // point aborts the row before any log line can be written, which is exactly
    // how the first version failed invisibly.
    const { importCore } = await import("./core.mjs");
    const { defineTool } = await importCore("@deepseek-ai/dsh-tools");
    const { OUTPUT_SCHEMA, valueSchemaViolations } = await import("./tool-schema.mjs");
    const host = await import("./host.mjs");
    const naming = await import("./naming.mjs");

    ctx.inject(["tools"], (scope) => {
      // cordis CALLS this callback, so it is outside the try/catch below: a
      // throw here is reported by the loader as an unattributed failure, which
      // is how the previous schema error stayed invisible in the logs. Hence its
      // own guard.
      try {
      // Kept so `mode: "status"` can ask the projection registry directly what
      // it holds for the calling session. The header chip goes through that
      // registry, and when the chip is wrong there is otherwise no way to tell a
      // stale client from a fold that never ran.
      pluginScope = scope;
      // Pre-flight the schema, because `defineTool` throwing here is invisible
      // and cost two restarts. The authoritative compiler still has the last
      // word; this converts an unattributed throw into a logged skip.
      const problems = valueSchemaViolations(OUTPUT_SCHEMA);
      if (problems.length > 0) {
        for (const problem of problems) log(`schema pre-flight: ${problem}`);
        log("refusing to register sandbox_clear with an invalid output schema");
        return;
      }
      scope.tools.register(
      defineTool({
        name: "sandbox_clear",
        description: DESCRIPTION,
        parameters: {
          mode: {
            type: "string",
            required: true,
            enum: ["inspect", "clear", "status"],
            description: "inspect reports the copies and their size; clear deletes them (destroying anything that exists only in the copy)."
          }
        },
        output: {
          // Checked by valueSchemaViolations() before registration, and by
          // test/validate-patch.mjs offline: see lib/tool-schema.mjs for why the
          // parameter DSL and the value schema DSL disagree about required.
          schema: OUTPUT_SCHEMA,
          render: (_args, value) => {
            const lines = value.copies.map(
              (copy) =>
                `- ${copy.box}: ${copy.files} file(s), ${humanBytes(copy.bytes)}${copy.truncated ? " (counting stopped early)" : ""} at ${copy.root}`
            );
            const head =
              value.action === "clear"
                ? `Cleared ${value.cleared.length} sandbox copy/copies for ${value.workspace}.`
                : `Sandbox copies for ${value.workspace}: ${value.copies.length} found.`;
            return [{ type: "text", text: [head, ...lines, value.note].join("\n") }];
          }
        },
        execute(args, exec) {
          const cwd = exec.agent?.session?.header?.cwd;
          if (typeof cwd !== "string" || cwd.length === 0) {
            throw new Error("sandbox_clear needs the calling session's workspace, and this caller has none");
          }
          if (args.mode === "status") {
            // Ask the projection registry what it holds for THIS session. The
            // header chip reads that value, so this separates "the fold never
            // ran" from "the client never got it" — the ambiguity that made the
            // chip cost several restarts to even locate.
            let detail;
            try {
              const projections = pluginScope?.get?.("sessionProjections");
              const session = exec.agent?.session;
              const state = projections?.stateOf?.(session, "sandboxBox");
              detail = `projections=${projections === undefined ? "absent" : "present"} session=${session?.id ?? "?"} seq=${session?.seq ?? "?"} stateOf=${JSON.stringify(state ?? null)}`;
            } catch (error) {
              detail = `status query threw: ${error?.message ?? error}`;
            }
            log(`status: ${detail}`);
            return Promise.resolve({ action: "status", workspace, copies: [], cleared: [], note: detail });
          }          const workspace = naming.canonicalWorkspace(cwd);
          const before = copiesFor(host, naming, workspace);
          if (before === null) {
            throw new Error(`cannot read ${host.sandboxIniPath()}, so the sandbox state is unknown; refusing to act`);
          }
          const listed = before.map((copy) => ({
            box: copy.box,
            root: copy.root,
            files: copy.files,
            bytes: copy.bytes,
            truncated: copy.truncated
          }));
          log(`execute mode=${args.mode} workspace=${workspace} copies=${listed.map((copy) => copy.box).join(",") || "(none)"}`);

          if (args.mode === "inspect") {
            return Promise.resolve({
              action: "inspect",
              workspace,
              copies: listed,
              cleared: [],
              note:
                before.length === 0
                  ? "No copy exists for this workspace, so reads and writes outside it already reflect the real disk."
                  : 'Call again with mode: "clear" to delete these copies. Files that exist only in a copy are lost.'
            });
          }

          // The deletion runs in a CHILD process under the managed Node runtime:
          // the launcher owns the Sandboxie/native work, and this is the same
          // `--manage clean` path a human would use from a console.
          const node = resolveNodePath();
          if (node === null) {
            throw new Error(
              "cannot find a genuine Node runtime to run the launcher; set DSH_SBIE_NODE to a node.exe path"
            );
          }
          const launcher = path.join(PACKAGE_ROOT, "bin", "dsh-sbie-run.mjs");
          const result = spawnSync(node, [launcher, "--manage", "clean", workspace], {
            encoding: "utf8",
            windowsHide: true,
            timeout: 180000
          });
          const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
          log(`clear exit=${result.status} output=${output.replace(/\s+/g, " ").slice(0, 400)}`);
          // The box's existence is what the header chip and the session
          // projection read, so drop the memo now instead of waiting it out.
          host.invalidateBoxCache();
          const stillThere = copiesFor(host, naming, workspace) ?? [];
          const cleared = listed.filter((copy) => !stillThere.some((after) => after.box === copy.box)).map((copy) => copy.box);

          if (result.status !== 0 && cleared.length === 0) {
            throw new Error(`the launcher could not clear the copies (exit ${result.status}): ${output || "no output"}`);
          }
          return Promise.resolve({
            action: "clear",
            workspace,
            copies: listed,
            cleared,
            note:
              listed.length === 0
                ? "Nothing to clear: no managed box belongs to this workspace."
                : "The copies are gone, so paths outside the workspace read from the real disk again. The next copy-on-write command creates a fresh, empty box."
          });
        },
        presentCall: (args) => ({
          card: "generic",
          title: args.mode === "clear" ? "Clear the sandbox copy" : "Inspect the sandbox copy",
          kind: "other",
          rawInput: args
        })
      })
      );
      log("apply: registered sandbox_clear");
      } catch (error) {
        log(`registering sandbox_clear FAILED: ${error?.stack ?? error}`);
      }
    });
  } catch (error) {
    // `apply` is async, so an escaping throw would surface as an unhandled
    // rejection instead of a readable diagnostic.
    log(`apply FAILED: ${error?.stack ?? error}`);
  }
}

export const inject = ["tools"];