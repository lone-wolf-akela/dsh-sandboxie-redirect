/**
 * Shell sandbox provider for DSH: stock behaviour everywhere, Sandboxie
 * copy-on-write for sessions whose permission preset is `copy-on-write`.
 *
 * Why a subclass rather than more `runnerCommand` config: `runnerCommand`
 * applies to EVERY mode (the seam early-returns as soon as it is set), so a
 * configured runner cannot leave `read-only` / `workspace-write` on their
 * original ACL restricted-token path. Overriding `confine` per call does.
 *
 * The preset — not the resolved mode — is what distinguishes copy-on-write.
 * The preset deliberately bundles `sandbox: workspace-write`, so the mode stays
 * a legal literal: the session projection schema, `SANDBOX_MODES`, the file
 * fence (`writableRoots`) and the escalation tables are all untouched, and the
 * model-visible mode string stays truthful for the file tools.
 *
 * Failure posture: everything about the preset lookup is best-effort, and any
 * surprise falls back to `super.confine` (the stock behaviour). Only a failure
 * to import the harness packages themselves is fatal, and that case still
 * registers a provider that fails CLOSED instead of running commands
 * unconfined.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importCore } from "./core.mjs";
import { invalidateBoxCache } from "./host.mjs";
import { logFile } from "./log.mjs";
import { canonicalWorkspace } from "./naming.mjs";
import { REDIRECT_PRESET, SELECTION_COPY_ON_WRITE, copyOnWriteSource, redirectWrap, resolveNodePath, selectionKind } from "./redirect.mjs";
// Imported, not mounted as their own loader rows: see wireCompanions().
import { apply as applyHostHalf } from "./host.mjs";
import { apply as applyNote } from "./note.mjs";
import { apply as applyTool } from "./tool.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const launcherPath = path.resolve(here, "..", "bin", "dsh-sbie-run.mjs");
// Diagnostics go to the plugin's state directory: an installed bundle lives in
// the profile's node_modules (pnpm may serve it from its content-addressed
// store), which is no place to append log lines.
const LOG = logFile("provider.log");

function log(line) {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

let Core = null;
let Base = null;
let loadError;
try {
  Core = await importCore("@deepseek-ai/cordis");
  Base = (await importCore("@deepseek-ai/dsh-sandbox-local")).default;
  log(`loaded: cordis=${typeof Core.Service} base=${Base?.name} config=${Base?.Config !== undefined} launcher=${launcherPath}`);
} catch (error) {
  loadError = error;
  log(`LOAD FAILED: ${error?.message ?? error}`);
}

/**
 * Mount the rest of the plugin: the header chip's projection, the model-facing
 * note, and the `sandbox_clear` tool.
 *
 * They used to be their own profile rows. They cannot be: the client-modules
 * registry composes a `dsh.client` package only when exactly ONE of its loader
 * entries is active, and it fails the whole boot otherwise —
 *
 *   client-modules: package dsh-sandboxie-redirect resolves from multiple
 *   active Loader sources: "…/lib/host.mjs", "…/lib/tool.mjs"; remove one entry
 *
 * — with the app offering "disable third-party plugins" as the only way out.
 * Which entries count depends on activation timing, so several rows into one
 * package made every start a race. One entry, three imports: no race to lose.
 *
 * Each companion is isolated so a failure costs that feature and nothing else.
 * `note.mjs` and `tool.mjs` inject their own dependencies inside their `apply`,
 * so handing them this ctx is enough.
 * @param ctx - the provider's context.
 */
function wireCompanions(ctx) {
  const mount = (label, run) => {
    try {
      const result = run(ctx);
      // tool.mjs's apply is async; a rejection must not become an unhandled one.
      if (result !== undefined && typeof result.then === "function") {
        result.then(undefined, (error) => log(`${label} failed: ${error?.stack ?? error}`));
      }
      log(`wired ${label}`);
    } catch (error) {
      log(`wiring ${label} FAILED: ${error?.stack ?? error}`);
    }
  };
  mount("host half (header chip projection)", applyHostHalf);
  mount("note (model-facing policy text)", applyNote);
  mount("tool (sandbox_clear)", applyTool);
}

/** Last-resort provider: present (so the rest of the profile still loads) but refusing to run anything. */function makeFailClosedProvider(Service) {
  return class FailClosedSandboxProvider extends Service {
    constructor(ctx) {
      super(ctx, "sandbox");
      log("fail-closed provider constructed");
      // The companions are pure-JS and do not depend on the harness packages
      // that just failed to load, so they are still wired: a fail-closed sandbox
      // must not also take the header chip or `sandbox_clear` down with it.
      wireCompanions(ctx);
    }
    async confine() {
      const error = new Error(
        `sandbox: the copy-on-write provider could not load the harness packages (${loadError?.message ?? "unknown error"}); refusing to run the command unconfined. Switch the session to danger-full-access to run without confinement.`
      );
      error.code = "SANDBOX_UNAVAILABLE";
      throw error;
    }
  };
}

function makeRedirectProvider(BaseClass) {
  return class CopyOnWriteSandboxProvider extends BaseClass {
    constructor(ctx, config) {
      super(ctx, config);
      log(`provider constructed (runnerCommand=${this.runnerCommand === undefined ? "unset" : "SET"})`);
      // This class is the package's ONLY loader entry, and that is load-bearing.
      // The client-modules registry refuses to compose a `dsh.client` package
      // that resolves from more than one ACTIVE loader entry, and which entries
      // are active depends on activation timing — so several rows pointing into
      // this package made startup a race that eventually failed outright
      // ("resolves from multiple active Loader sources; remove one entry").
      // The other halves are imported modules now, wired here instead of by
      // their own rows. Each registration is isolated: a broken one costs that
      // feature, never the profile.
      wireCompanions(ctx);
    }

    /**
     * One session's OWN selection, as the `SELECTION_*` kinds.
     *
     * Two readings, because only one of them may exist depending on load order:
     * the permission service's own derivation (`current(session)`, which folds
     * the `permission/preset` event and the knob state, and therefore also
     * answers for a session whose knobs match the preset without an event), and
     * the raw `permissions` projection, which is what distinguishes "no
     * selection at all" (inheritable) from "a different preset, on purpose".
     */
    selectionOf(session, presets, projections) {
      try {
        if (presets !== undefined && typeof presets.current === "function" && presets.current(session) === REDIRECT_PRESET) {
          return SELECTION_COPY_ON_WRITE;
        }
      } catch {
        /* the preset reader may not be ready yet; the projection still answers */
      }
      let state;
      try {
        state = projections?.stateOf?.(session, "permissions");
      } catch {
        state = undefined;
      }
      return selectionKind(state);
    }

    /**
     * Whether this call belongs to a copy-on-write session — its own selection,
     * or, for a DELEGATED session, the selection of the session that delegated
     * it. Any failure to read the imperative state answers `false`, which routes
     * the call to the stock path — the safe direction, since the stock path is
     * the original behaviour.
     *
     * Inheritance is not a nicety. The harness seeds only `auto` and
     * `danger-full-access` into a delegated child and pins the child's approval
     * policy to `never`, so a custom preset is dropped at the delegation
     * boundary: without this walk, a subagent of a copy-on-write session would be
     * confined by the stock ACL runner. On a workspace whose inherited DACL
     * grants only Modify, that runner's very first grant fails (Win32 5: the Low
     * mandatory label needs WRITE_OWNER) and the child cannot start its tool
     * runtime at all — "a subagent cannot call any tool". See
     * `copyOnWriteSource` in redirect.mjs for the full failure story.
     */
    isCopyOnWrite(policy) {
      // A read-only policy must keep the stock read-only runner: the redirect
      // always executes workspace-write, so choosing it here would widen the
      // call instead of narrowing it.
      if (policy?.mode !== "workspace-write") return false;
      const sessionId = policy?.sessionId;
      if (sessionId === undefined) return false;
      try {
        const sessions = this.ctx.get("sessions");
        if (sessions === undefined) return false;
        const byId = new Map();
        for (const candidate of sessions.list()) byId.set(String(candidate.id), candidate);
        const session = byId.get(String(sessionId));
        if (session === undefined) return false;

        const presets = this.ctx.get("permissionPresets");
        const projections = this.ctx.get("sessionProjections");
        const source = copyOnWriteSource(session, {
          selectionOf: (candidate) => this.selectionOf(candidate, presets, projections),
          parentOf: (id) => byId.get(String(id))
        });
        if (source === undefined) return false;
        if (source !== session) {
          // The inherited decision is otherwise invisible: the child's own
          // projection still reads `custom`, so log it once per child to make a
          // future report ("which runner did the subagent get?") answerable.
          this.loggedInheritance ??= new Set();
          const childId = String(session.id);
          if (!this.loggedInheritance.has(childId)) {
            this.loggedInheritance.add(childId);
            log(`delegated session ${childId} inherits copy-on-write from parent ${String(source.id)}`);
          }
        }
        return true;
      } catch (error) {
        log(`preset lookup failed, falling back to stock: ${error?.message ?? error}`);
        return false;
      }
    }

    async confine(argv, policy, signal) {
      signal?.throwIfAborted();
      if (!this.isCopyOnWrite(policy)) {
        if (!this.loggedStock) {
          this.loggedStock = true;
          log(`stock path in use (mode=${policy?.mode}, sessionId=${policy?.sessionId ?? "none"})`);
        }
        return super.confine(argv, policy, signal);
      }
      const workspace = canonicalWorkspace(policy.workspaceRoot ?? process.cwd());
      const nodePath = resolveNodePath();
      if (nodePath === null) {
        // No safe fallback exists: `process.execPath` in this host is the
        // Electron binary, and handing it to the launcher would fail later,
        // inside the box, where nothing can attribute the failure. Fail here,
        // loudly, with the one thing the user can act on.
        const error = new Error(
          "sandbox: no genuine Node runtime found to run the Sandboxie launcher, so the copy-on-write preset cannot confine this command. Set DSH_SBIE_NODE to a node.exe path, or switch this session to another permission preset."
        );
        error.code = "SANDBOX_UNAVAILABLE";
        log(`redirect refused: ${error.message}`);
        throw error;
      }
      // The launcher may be about to CREATE this workspace's box. The host
      // half's box lookup memoizes the Sandboxie configuration for a moment,
      // so a "no box yet" answer cached before this command must not be the one
      // the post-command event folds — otherwise the header chip would lag
      // behind the box by up to the memo window. Same module instance, so this
      // clears the cache the projection reads.
      try {
        invalidateBoxCache();
      } catch {
        /* a stale cache costs a delayed chip, never a broken command */
      }
      log(`redirect: node=${nodePath} workspace=${workspace} argv0=${argv[0]}`);
      return redirectWrap({ nodePath, launcherPath, workspace, argv });
    }
  };
}

const Exported = Base === null ? makeFailClosedProvider(Core.Service) : makeRedirectProvider(Base);
log(`exporting ${Exported.name}`);
export default Exported;
export { REDIRECT_PRESET, launcherPath };
