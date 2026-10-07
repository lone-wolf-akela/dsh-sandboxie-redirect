/**
 * Reliability soak: N sequential launcher runs, reporting transient box-start
 * failures and how many needed a retry. This is the measurement that decides
 * whether the engine-level retry is doing its job.
 *
 * usage: node test/soak.mjs [runs] [--box <name>]
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boxNameFor, boxRoot } from "../lib/boxes.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.dirname(here);
const launcher = path.join(pluginDir, "bin", "dsh-sbie-run.mjs");
const NODE = process.execPath;
const WORKSPACE = pluginDir;
const runs = Number(process.argv[2] ?? 30);
const boxArg = process.argv.includes("--box") ? process.argv[process.argv.indexOf("--box") + 1] : boxNameFor(WORKSPACE, "workspace-write");

function profileArgs() {
  return ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--die-with-parent", "--tmpfs", "/tmp", "--bind", WORKSPACE, WORKSPACE];
}

function launch(tag) {
  return new Promise((resolve) => {
    const argv = [launcher, "--verbose", "--relay-timeout-ms", "8000", ...profileArgs(), "--", NODE, "-e", `process.stdout.write('${tag}')`];
    const started = Date.now();
    const child = spawn(NODE, argv, { cwd: WORKSPACE, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 120000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, ms: Date.now() - started, ok: code === 0 && out === tag });
    });
  });
}

console.log(`box: ${boxArg}\ncopy root: ${boxRoot(boxArg)}\nruns: ${runs}\n`);
let failures = 0;
let retried = 0;
const times = [];
for (let i = 0; i < runs; i += 1) {
  const tag = `soak-${i}`;
  const r = await launch(tag);
  const usedRetry = /\(attempt [2-9]/.test(r.err) || /attempt [23]\/3 failed/.test(r.err);
  if (usedRetry) retried += 1;
  if (!r.ok) {
    failures += 1;
    console.log(`FAIL #${i} exit=${r.code} ${r.ms}ms :: ${r.err.trim().split("\n").slice(-2).join(" | ")}`);
  } else if (usedRetry) {
    console.log(`retry #${i} ${r.ms}ms`);
  }
  times.push(r.ms);
}
times.sort((a, b) => a - b);
const p = (q) => times[Math.min(times.length - 1, Math.floor(times.length * q))];
console.log(`\nok=${runs - failures}/${runs}  retried=${retried}  latency p50=${p(0.5)}ms p90=${p(0.9)}ms max=${times[times.length - 1]}ms`);
process.exitCode = failures === 0 ? 0 : 1;
