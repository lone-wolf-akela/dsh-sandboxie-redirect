/**
 * Live check of the host half's rule: a workspace's box name is reported only
 * once that box really exists, and it is the name the launcher actually used.
 *
 * Reads the real Sandboxie configuration file (no fixtures, no overrides) and
 * drives the real launcher to create and destroy the box, so this exercises the
 * same logic the session projection runs for the header chip.
 *
 * usage: node tools/verify-box-binding.mjs [workspace]
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apply as hostApply, boxForHeader, currentBoxFor, invalidateBoxCache, sandboxIniPath } from "../lib/host.mjs";
import { boxNameCandidates } from "../lib/naming.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.dirname(here);
const launcher = path.join(pluginDir, "bin", "dsh-sbie-run.mjs");
const node = process.execPath;
const workspace = process.argv[2] ?? process.cwd();
if (process.argv[2] === undefined) {
  console.log(`(no workspace argument: using the current directory; pass one explicitly to check another)`);
}

console.log(`config    : ${sandboxIniPath()}`);
console.log(`workspace : ${workspace}`);
console.log(`would-use : ${boxForHeader({ cwd: workspace })?.box} (first candidate, NOT reported until it exists)`);
console.log(`candidates: ${boxNameCandidates(workspace, "workspace-write", 4).join(", ")}`);

/**
 * The regression this tool exists to catch: a log repaired in place carries
 * retired `sandbox/box` rows (with `ignorable: true`). Folding one back in would
 * report a name recorded in the past as if the box were live now — which is how
 * the header chip once claimed a sandbox Sandboxie did not have.
 *
 * Replays that shape through the REAL projection definition: seed from the
 * header, then fold the retired event, exactly as the harness would.
 */
async function repairedLogVerdict(cwd) {
  let definition;
  // Mirrors cordis: `apply` now registers through `ctx.inject`, so the fake ctx
  // must run the callback with a context carrying the service.
  const fakeCtx = {
    effect: () => () => {},
    sessionProjections: {
      register: (value) => {
        definition = value;
        return () => {};
      }
    }
  };
  fakeCtx.inject = (deps, callback) => {
    for (const dep of deps) if (!(dep in fakeCtx)) throw new Error(`fake ctx is missing the ${dep} service`);
    callback(fakeCtx);
  };
  await hostApply(fakeCtx);
  if (definition === undefined) return "the projection did not register";
  // The invariant is NOT "the answer is null" — a box may legitimately exist.
  // It is "folding the retired event changes nothing": same state reference as
  // the seed, and the retired name never appears.
  const RETIRED = "dsh_retired_must_not_win";
  const seeded = definition.init({ cwd }, 0);
  const folded = definition.apply(seeded, {
    type: "sandbox/box",
    seq: 1849,
    time: 0,
    data: { box: RETIRED, root: `C:\\Sandbox\\someone\\${RETIRED}` },
    ignorable: true
  });
  if (folded.box === RETIRED) return "WRONG — the retired name won";
  if (folded !== seeded) return "WRONG — the retired event changed the state";
  return `the retired event changed nothing (live answer from init: ${seeded?.box ?? "no box"})`;
}

console.log(`\n0. repaired-log replay  -> ${await repairedLogVerdict(workspace)}`);

// `--manage` and a nested launcher both need SbieDll/SbieIni, and Sandboxie
// deliberately hides the box list from a process that is itself inside a box.
// So the create/clean half is only meaningful from OUTSIDE the box.
const insideBox = typeof process.env.DSH_SBIE_BOX === "string" && process.env.DSH_SBIE_BOX.length > 0;
if (insideBox) {
  console.log("   NOTE: this ran INSIDE the sandbox box (DSH_SBIE_BOX is set).");
  console.log("         Sandboxie hides the box list from boxed processes, so `--manage` and a nested");
  console.log("         launcher invocation cannot work here — steps 2-5 are skipped rather than");
  console.log("         reported as failures. Re-run from a danger-full-access session or a plain console.");
}

const before = currentBoxFor(workspace);
console.log(`1. box as of now        -> ${before === null ? "no box reported" : JSON.stringify(before)}`);

if (!insideBox) {
  // Model the real sequence: the shell provider invalidates the box cache the
  // moment it decides to redirect, because that is the call that may create the
  // box. Then the post-command session event folds and must see it.
  invalidateBoxCache();
  const run = spawnSync(
    node,
    [launcher, "--workspace", workspace, "--mode", "workspace-write", "--", node, "-e", "process.stdout.write('probe')"],
    { encoding: "utf8", windowsHide: true, cwd: workspace, timeout: 120000 }
  );
  console.log(`2. ran a copy-on-write command -> exit=${run.status} stdout=${JSON.stringify((run.stdout ?? "").trim())}`);

  const after = currentBoxFor(workspace);
  console.log(`3. after the command    -> ${after === null ? "STILL no box reported (WRONG)" : `${after.box}  root=${after.root}`}`);
  if (after !== null) {
    const expected = boxForHeader({ cwd: workspace })?.box;
    console.log(`   matches the launcher's box: ${after.box === expected ? "yes (no collision)" : "resolved past a collision"}`);
    console.log(`   root exists on disk       : ${fs.existsSync(after.root)}`);
  }

  const clean = spawnSync(node, [launcher, "--manage", "clean", workspace], { encoding: "utf8", windowsHide: true, timeout: 120000 });
  const cleanOutput = (clean.stdout ?? "").trim();
  console.log(`4. clean attempt        -> ${cleanOutput.split("\n").slice(-1)[0]}`);
  if (/no managed box is bound|not present/i.test(cleanOutput)) {
    console.log("5. disappearance check  -> SKIPPED: `--manage` could not resolve the box list here");
  } else {
    // The reader memoizes the configuration for a moment so a burst of session
    // events does not re-read the file per token; wait it out before judging.
    await new Promise((resolve) => setTimeout(resolve, 1700));
    console.log(`5. after cleaning       -> ${currentBoxFor(workspace) === null ? "no box reported (correct)" : "still reported (stale)"}`);
  }
}
