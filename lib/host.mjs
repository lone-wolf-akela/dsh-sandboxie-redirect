/**
 * Host half of the "which sandbox is this conversation bound to?" surface.
 *
 * The browser half cannot derive the box name: it has no session→workspace
 * path in any of its snapshots. So this half publishes one tiny session
 * projection whose client view carries the name and root, and the browser
 * reads it with the standard `useProjection` hook — no bespoke RPC.
 *
 * WHAT IT REPORTS — and why it is not simply the workspace's name:
 *
 * The name is only knowable once the box EXISTS. Collisions are resolved by
 * walking `boxNameCandidates()` against Sandboxie's own state, so which of the
 * candidates a workspace ends up owning cannot be decided from the path alone;
 * and before the first copy-on-write command there is no box at all. Reporting
 * a guess would put a name in the header that may never be used — worse than
 * showing nothing, because the whole point of the chip is to say whether a
 * sandbox is in play and which one it is.
 *
 * So the projection reports nothing until this workspace actually owns a box,
 * and it re-checks on the session's own event drive: every committed event
 * (the tool call and its result included) folds through `apply`, and returning
 * a NEW state reference is what makes the harness recompute the client view.
 * That is how the chip appears right after the first copy-on-write command —
 * with no polling, and without writing anything into the log.
 *
 * THE ONE HARD RULE FOR THIS FILE: never call `session.append()`.
 *
 * An earlier version appended a per-session `sandbox/box` event. That is a hard
 * error, not a style choice: the persistence read path refuses a stored event
 * whose type this build does not know unless the envelope carries
 * `ignorable: true`, and live `Session.append()` cannot set that marker — so
 * every session this plugin touched failed to reload ("contains event type ...
 * unknown to this harness and not marked ignorable"). The harness's own plugin
 * practices say the same: "Do not append session events with a new `type`. …
 * Derive state from existing events, or keep plugin-owned data in a storage
 * service." Logs written by that version were repaired in place (see
 * `tools/stamp-ignorable.mjs`) and still fold through the legacy branch below.
 *
 * Everything here is best-effort: a failure costs the header chip, never the
 * sandbox itself, so nothing is allowed to throw.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boxNameCandidates, boxNameFor, boxRoot, canonicalWorkspace } from "./naming.mjs";
import { importCore } from "./core.mjs";

export const name = "dsh-sandboxie-redirect-host";
export const inject = ["sessionProjections"];

/** Projection key the browser half reads. */
export const BOX_PROJECTION = "sandboxBox";
/**
 * The retired event type. Never appended — recognized only so logs written by
 * the version that did append it keep folding to the box they recorded.
 */
export const LEGACY_BOX_EVENT = "sandbox/box";

/** How many name candidates to consider, matching the launcher's resolution. */
const CANDIDATE_LIMIT = 12;
/** Re-reading the configuration file on every event would be rude; this is a hint, not an audit. */
const INI_MEMO_MS = 1500;

function report(line) {
  try {
    process.stderr.write(`dsh-sandboxie-redirect: ${line}\n`);
  } catch {}
}

/**
 * Diagnostics go to a file as well as to stderr, because the host's stderr is
 * not readable anywhere later — and "why did the chip stop updating?" is
 * precisely the question that cannot be answered without them.
 */
const HOST_LOG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "host.log");
/** Last view value written to the log, so only real changes are recorded. */
let lastLoggedView;
/** Whether this process already applied the size cap. */
let logOpened = false;
/** Keep the diagnostic file bounded: a session replay is thousands of lines. */
const HOST_LOG_MAX_BYTES = 512 * 1024;
function log(line) {
  try {
    if (logOpened === false) {
      logOpened = true;
      try { if (fs.statSync(HOST_LOG).size > HOST_LOG_MAX_BYTES) fs.rmSync(HOST_LOG, { force: true }); } catch {}
    }
    fs.appendFileSync(HOST_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {}
  report(line);
}

/** The Sandboxie configuration file whose box sections are the authority on "this box exists". */
export function sandboxIniPath() {
  const override = process.env.DSH_SBIE_INI;
  if (typeof override === "string" && override.length > 0) return override;
  return path.join(process.env.SystemDrive ?? "C:", "Windows", "Sandboxie.ini");
}

/**
 * Parse a Sandboxie configuration file into `lowercased section name -> body`.
 * The file is UTF-16LE; a plain `utf8` read yields interleaved NULs and every
 * section header would be missed.
 * @param text - the decoded file contents.
 */
export function parseIniSections(text) {
  const sections = new Map();
  let current;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[") && line.endsWith("]") && line.length > 2) {
      current = line.slice(1, -1).trim().toLowerCase();
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current !== undefined && line.length > 0) sections.get(current).push(line);
  }
  return sections;
}

/** Whether one box section grants this workspace read/write access. */
export function sectionOwnsWorkspace(body, cwd) {
  const needle = `${canonicalWorkspace(cwd)}\\*`.toLowerCase();
  return body.some((line) => {
    const lowered = line.toLowerCase();
    return (lowered.startsWith("openfilepath=") || lowered.startsWith("readfilepath=")) && lowered.includes(needle);
  });
}

/**
 * The box this workspace actually owns, or null when it has none yet.
 * Mirrors the launcher's resolution: walk the same candidates in the same
 * order and accept the first that exists AND is ours, so another workspace's
 * box is never reported as this one's.
 * @param cwd - the session workspace.
 * @param sections - parsed configuration sections.
 */
export function ownedBoxFor(cwd, sections) {
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  for (const candidate of boxNameCandidates(cwd, "workspace-write", CANDIDATE_LIMIT)) {
    const body = sections.get(candidate.toLowerCase());
    if (body === undefined) continue;
    if (!sectionOwnsWorkspace(body, cwd)) continue;
    return { box: candidate, root: boxRoot(candidate) };
  }
  return null;
}

let iniMemo;

/**
 * Drop the memo so the next read hits the file.
 *
 * Called by the shell provider the moment it decides a call will be redirected:
 * the box may be about to be created, so a "no box yet" answer cached a moment
 * earlier must not be the one the next committed event sees — otherwise the
 * header chip would wait for the memo to expire. Also the test hook.
 */
export function invalidateBoxCache() {
  iniMemo = undefined;
}

/** Read the configuration sections, memoized briefly. Null when unreadable. */
export function readIniSections(now = Date.now()) {
  if (iniMemo !== undefined && now - iniMemo.at < INI_MEMO_MS) return iniMemo.sections;
  let sections = null;
  try {
    sections = parseIniSections(fs.readFileSync(sandboxIniPath(), "utf16le"));
  } catch {
    sections = null;
  }
  iniMemo = { at: now, sections };
  return sections;
}

/** The workspace's owned box as of now, or null. */
export function currentBoxFor(cwd) {
  const sections = readIniSections();
  if (sections === null) return null;
  return ownedBoxFor(cwd, sections);
}

/** The name this workspace WOULD use; exported for the deterministic-name tests. */
export function boxForHeader(header) {
  const cwd = header?.cwd;
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  try {
    const box = boxNameFor(cwd, "workspace-write");
    return { box, root: boxRoot(box) };
  } catch (error) {
    report(`could not derive the box for ${cwd}: ${error?.message ?? error}`);
    return null;
  }
}

// Re-exported for the resolution tests; keeps a single import from ./naming.mjs
// so the bundle-free test loader only has one specifier to rewrite.
export { boxNameCandidates };

/** A stored legacy event's payload, when it is the shape this plugin wrote. */
export function boxFromLegacyEvent(event) {
  const data = event?.data;
  if (typeof data?.box !== "string" || data.box.length === 0) return undefined;
  return { box: data.box, root: typeof data.root === "string" && data.root.length > 0 ? data.root : boxRoot(data.box) };
}

/** Seed one session's projection state from its header, resolving any box that already exists. */
export function seedState(header) {
  const cwd = header?.cwd;
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  const existing = currentBoxFor(cwd);
  return { cwd, box: existing?.box ?? null, root: existing?.root ?? null };
}

export async function apply(ctx) {
  // The schemas are validation for the wire. They must never be ABSENT: the
  // projections service calls `wire.viewSchema.parse(...)` unconditionally when
  // it publishes (and when it snapshots), so registering a wire with an
  // undefined `viewSchema` throws on every publish — the chip then freezes at
  // whatever `init` last built, which is exactly the "the name disappeared and
  // never came back" failure. `importCore("zod")` is optional, so fall back to a
  // pass-through schema rather than to nothing; either way the shape is small
  // enough that validation adds little.
  let z;
  let schemaSource = "zod";
  try {
    ({ z } = await importCore("zod"));
  } catch (error) {
    z = undefined;
    schemaSource = "pass-through";
    log(`schemas unavailable, using a pass-through view schema: ${error?.message ?? error}`);
  }
  /** Minimal stand-in for a schema: keeps `.parse` callable when zod is missing. */
  const PASS_THROUGH = { parse: (value) => value };
  const stateSchema = z?.object({ cwd: z.string(), box: z.string().nullable(), root: z.string().nullable() }).nullable() ?? PASS_THROUGH;
  const viewSchema = z?.object({ box: z.string().nullable(), root: z.string().nullable() }) ?? PASS_THROUGH;
  // One source of truth for the version. A hardcoded copy inside a log line once
  // sent me chasing a phantom "old build is still loaded" for two restarts.
  const STATE_VERSION = 5;
  log(`attaching projection registration (stateVersion ${STATE_VERSION}, schemas=${schemaSource})`);

  // Register through `ctx.inject`, exactly as note.mjs does for the services it
  // needs, so the registration lands on the LIVE registry once that service
  // exists. This half is wired from the sandbox provider's CONSTRUCTOR, where
  // `sessionProjections` may not resolve yet; a registration that lands anywhere
  // else is never driven — no cell is created, `apply` is never called, no view
  // is ever produced, and the chip silently never renders. That is exactly the
  // observed signature: host.log had no `apply` and no `view` lines at all,
  // while the box existed and the shipped units kept updating.
  ctx.inject(["sessionProjections"], (scope) => {
  try {
    scope.sessionProjections.register({
      key: BOX_PROJECTION,
      // v5 forces every session's cell to be rebuilt from `init`. A v4 cell can
      // FREEZE: the registry advances a cell by folding committed events into
      // `apply`, and a cell that is ever built (or restored from the cache) while
      // the box is absent stays at `{box:null}` — the symptom being a chip that
      // vanished and never returned even though `init` reports the box. A version
      // bump is the documented way to discard such cells; it is paired with
      // per-call logging in `apply` so the next occurrence is recorded, not
      // guessed at.
      //   v1 stored an event-derived value
      //   v2 froze the box at the session's first event
      //   v3 carried the workspace so the box could be re-checked as it appears
      //   v4 tolerates the retired event without trusting it
      //   v5 rebuilds cells so a stale one cannot outlive a fix
      stateVersion: STATE_VERSION,
      stateSchema,
      init: (header) => seedState(header),
      apply: (state, event) => {
        // The retired event is tolerated, never trusted. It is history: the name
        // it recorded was that workspace's box AT THE TIME, so reporting it would
        // make the chip claim a sandbox that may no longer exist — exactly what
        // the chip must never do. Only the live check below decides, so a
        // repaired log behaves identically to a clean one.
        if (event.type === LEGACY_BOX_EVENT) return state;
        const cwd = state?.cwd;
        if (typeof cwd !== "string" || cwd.length === 0) return state;
        // Re-verify in BOTH directions on every committed event. The box appears
        // on the first redirected command, and it disappears when it is deleted
        // (SandMan, or `--manage clean`) — exactly what a user who just removed
        // the sandbox expects the chip to reflect. Latching the first non-null
        // answer would leave the chip claiming a deleted box forever.
        const sections = readIniSections();
        // An unreadable configuration means "cannot tell", never "there is no
        // box": clearing on a transient read failure would drop the chip for a
        // box that still exists.
        if (sections === null) return state;
        const live = ownedBoxFor(cwd, sections);
        const bound = state?.box ?? null;
        // TRANSITIONS only. Logging every call is what finally located the
        // frozen-chip bug — a registration that was never driven looked exactly
        // like a fold that ran and found nothing — but one session replay is
        // thousands of calls, so the evidence is kept where it is decisive.
        if ((live === null ? null : live.box) === bound) return state;
        log(`transition seq=${event.seq} type=${event.type} ${bound ?? "none"} -> ${live?.box ?? "none"}`);
        if (live === null) return { cwd, box: null, root: null };
        return { cwd, box: live.box, root: live.root };
      },
      wire: {
        viewSchema,
        // Logged only when the value actually changes: this runs for every
        // publish AND every snapshot, and it is the last place the host can
        // observe what the client is handed.
        view: (state) => {
          const view = { box: state?.box ?? null, root: state?.root ?? null };
          if (view.box !== lastLoggedView) {
            lastLoggedView = view.box;
            log(`view box=${view.box ?? "none"}`);
          }
          return view;
        }
      }
    });
    log("projection registered");
  } catch (error) {
    log(`projection registration failed: ${error?.message ?? error}`);
  }
  });
}
