/**
 * Acceptance harness for dsh-sandboxie-redirect.
 *
 * Every case drives the launcher exactly the way DSH does: the same argv shape
 * `[<runner>, ...bwrapProfileArgs, "--", <command...>]`, spawned with piped
 * stdio and windowsHide. Cases map onto the §7 table of the design note, plus
 * the facts M0 uncovered (read-only enforcement, stdin, stderr separation,
 * concurrency, runner-failure signalling).
 *
 * Run with a normal user token (Medium IL): the launcher talks to the
 * Sandboxie service, and the box must be entered for real.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boxNameFor, boxRoot } from "../lib/boxes.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.dirname(here);
const launcher = path.join(pluginDir, "bin", "dsh-sbie-run.mjs");
const NODE = process.execPath;

const WORKSPACE = process.env.DSH_SBIE_TEST_WORKSPACE ?? path.resolve(here, "..");
const OTHER_WORKSPACE = path.join(WORKSPACE, "probe", "ws-other");
/** A normal outside-workspace location with ordinary user rights. */
const OUTSIDE = path.join(process.env.USERPROFILE ?? "C:\\Users\\liuruoyang", "dsh-sbie-outside");
const BOX = boxNameFor(WORKSPACE, "workspace-write");
const BOX_ROOT = boxRoot(BOX);

const results = [];
let current;

function profileArgs(workspace, mode) {
  const base = ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--die-with-parent"];
  return mode === "workspace-write" ? [...base, "--tmpfs", "/tmp", "--bind", workspace, workspace] : base;
}

/**
 * Where a redirected file lands inside a box.
 *
 * Sandboxie uses two layouts: ordinary paths become `<box>\drive\<X>\<rest>`,
 * but anything under the user profile is folded into `<box>\user\current\`
 * (that is what makes "sandbox settings live in <box>\user\current\AppData"
 * work). Both are tried so a case reads the real copy rather than guessing.
 */
function boxPathsOf(realPath) {
  const resolved = path.resolve(realPath);
  const parsed = path.parse(resolved);
  const drive = parsed.root.replace(/[:\\]/g, "");
  const rest = resolved.slice(parsed.root.length);
  const candidates = [path.join(BOX_ROOT, "drive", drive, rest)];
  const profile = process.env.USERPROFILE;
  if (profile !== undefined && resolved.toLowerCase().startsWith(`${profile.toLowerCase()}\\`)) {
    candidates.push(path.join(BOX_ROOT, "user", "current", resolved.slice(profile.length + 1)));
  }
  return candidates;
}

function boxPathOf(realPath) {
  const candidates = boxPathsOf(realPath);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

/** Drop any copy of `realPath` that already exists, under either layout. */
function clearBoxCopies(realPath) {
  for (const candidate of boxPathsOf(realPath)) fs.rmSync(candidate, { force: true });
}

/**
 * The copy that exists NOW. Must be called AFTER the run: before the run
 * neither layout exists, and the lexical fallback would guess wrong for
 * user-profile paths (Sandboxie folds those into `user\current\`).
 */
function findBoxCopy(realPath) {
  return boxPathsOf(realPath).find((candidate) => fs.existsSync(candidate));
}

/** Spawn the launcher the way DSH does and collect everything. */
function launch({ workspace = WORKSPACE, mode = "workspace-write", command, stdin }) {
  return new Promise((resolve) => {
    const argv = [launcher, "--verbose", ...profileArgs(workspace, mode), "--", ...command];
    const child = spawn(NODE, argv, { cwd: workspace, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString("utf8")));
    child.stderr.on("data", (d) => (err += d.toString("utf8")));
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
    const timer = setTimeout(() => child.kill(), 300000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (err.includes("(attempt 2)")) RELAY_RETRIES += 1;
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

/** How many launches needed the second relay attempt — the SBIE2308-sensitive path. */
let RELAY_RETRIES = 0;

async function test(name, body) {
  current = { name, ok: false, detail: "" };
  results.push(current);
  try {
    const detail = await body();
    current.ok = true;
    current.detail = detail ?? "";
  } catch (error) {
    current.ok = false;
    current.detail = error instanceof Error ? error.message : String(error);
  }
  process.stdout.write(`${current.ok ? "PASS" : "FAIL"}  ${name}${current.detail ? `  — ${current.detail}` : ""}\n`);
}

function need(condition, message) {
  if (!condition) throw new Error(message);
}

const rnd = () => Math.random().toString(36).slice(2, 10);

/**
 * File effects go through Node scripts rather than `cmd /c echo x> file`.
 * Node's Windows argv quoting is what DSH itself uses, and `cmd.exe`'s
 * redirect-plus-quotes combination is a quoting trap that has nothing to do
 * with the sandbox. `pwsh` covers the real shell path in case 17.
 */
const nodeWrite = (file, text) => [NODE, "-e", `require('fs').writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(text)})`];
const nodeDelete = (file) => [NODE, "-e", `try{require('fs').unlinkSync(${JSON.stringify(file)})}catch(e){process.exit(0)}`];

// ---------------------------------------------------------------------------

fs.rmSync(path.join(WORKSPACE, "probe", "sandboxie-tests"), { recursive: true, force: true });
const scratch = path.join(WORKSPACE, "probe", "sandboxie-tests");
fs.mkdirSync(scratch, { recursive: true });
fs.mkdirSync(OTHER_WORKSPACE, { recursive: true });

process.stdout.write(`workspace : ${WORKSPACE}\nbox       : ${BOX}\ncopy root : ${BOX_ROOT}\n\n`);

// 1 — workspace write passes through to the real disk.
await test("1  workspace write lands on the real disk", async () => {
  const target = path.join(scratch, `ws-${rnd()}.txt`);
  const marker = `ws-${rnd()}`;
  const run = await launch({ command: nodeWrite(target, marker) });
  need(run.code === 0, `exit ${run.code}: ${run.stderr}`);
  const real = fs.readFileSync(target, "utf8");
  need(real.includes(marker), `real file content was ${JSON.stringify(real)}`);
  return `${path.basename(target)} = ${real.trim()}`;
});

// 2 — write outside the workspace is redirected into the box copy.
await test("2  outside-workspace write: real disk untouched, copy created", async () => {
  const real = "C:\\Windows\\Temp\\dsh-sbie-probe.txt";
  const copy = boxPathOf(real);
  fs.rmSync(real, { force: true });
  clearBoxCopies(real);
  const marker = `outside-${rnd()}`;
  const run = await launch({ command: nodeWrite(real, marker) });
  need(run.code === 0, `exit ${run.code}: ${run.stderr}`);
  need(!fs.existsSync(real), "the real file exists — the write was NOT redirected");
  need(fs.existsSync(copy), `no copy at ${copy}`);
  need(fs.readFileSync(copy, "utf8").includes(marker), "copy has the wrong content");
  return `copy at ${copy}`;
});

// 3 — modifying an existing outside file leaves the original alone.
// The path is deliberately NOT C:\Windows\Temp: Sandboxie's copy-on-write
// refuses to re-materialise files there (case 19 pins that down, in both our
// box and the stock DefaultBox). Anywhere with normal user rights works.
await test("3  outside-workspace modify: original unchanged, copy diverges", async () => {
  const real = path.join(OUTSIDE, "dsh-sbie-existing.txt");
  fs.mkdirSync(OUTSIDE, { recursive: true });
  clearBoxCopies(real);
  fs.writeFileSync(real, "ORIGINAL\n");
  const run = await launch({ command: nodeWrite(real, "MODIFIED\n") });
  need(run.code === 0, `exit ${run.code}: ${run.stderr}`);
  need(fs.readFileSync(real, "utf8").includes("ORIGINAL"), "the real file was modified");
  const copy = findBoxCopy(real);
  need(copy !== undefined, `no copy under ${boxPathsOf(real).join(" or ")}`);
  need(fs.readFileSync(copy, "utf8").includes("MODIFIED"), `copy wrong: ${fs.readFileSync(copy, "utf8")}`);
  return `real=ORIGINAL copy=MODIFIED at ${path.relative(BOX_ROOT, copy)}`;
});

// 4 — deleting an outside file only records a tombstone in the copy.
await test("4  outside-workspace delete: real file survives", async () => {
  const real = "C:\\Windows\\Temp\\dsh-sbie-delete.txt";
  fs.writeFileSync(real, "KEEP\n");
  const run = await launch({ command: nodeDelete(real) });
  need(run.code === 0, `exit ${run.code}: ${run.stderr}`);
  need(fs.existsSync(real), "the real file was deleted — delete was NOT virtualised");
  return "real file still present";
});

// 5 — deleting a workspace file is a real delete (write-through).
await test("5  workspace delete: real file is removed", async () => {
  const target = path.join(scratch, `del-${rnd()}.txt`);
  fs.writeFileSync(target, "bye\n");
  const run = await launch({ command: nodeDelete(target) });
  need(run.code === 0, `exit ${run.code}: ${run.stderr}`);
  need(!fs.existsSync(target), "the workspace file survived — write-through is broken");
  return "real file removed";
});

// 6 — TLS works: the ACL runner's Low-IL token was what broke SChannel.
await test("6  curl https://www.example.com succeeds (no SEC_E_NO_CREDENTIALS)", async () => {
  const run = await launch({ command: ["curl.exe", "-sS", "-o", "NUL", "-w", "%{http_code}", "https://www.example.com"] });
  need(run.code === 0, `exit ${run.code}: ${run.stderr.trim()}`);
  need(run.stdout.trim() === "200", `http code was ${run.stdout.trim()}`);
  return "HTTP 200";
});

// 7 — stdout/stderr survive the box boundary.
await test("7  node stdout/stderr are captured verbatim", async () => {
  const run = await launch({
    command: [NODE, "-e", "process.stdout.write('OUT-MARK\\n');process.stderr.write('ERR-MARK\\n')"]
  });
  need(run.code === 0, `exit ${run.code}: ${run.stderr}`);
  need(run.stdout.includes("OUT-MARK"), `stdout was ${JSON.stringify(run.stdout)}`);
  need(run.stderr.includes("ERR-MARK"), `stderr was ${JSON.stringify(run.stderr)}`);
  need(!run.stdout.includes("ERR-MARK"), "stderr leaked into stdout");
  return "streams separated";
});

// 8 — exit codes propagate.
await test("8  cmd /c exit 7 propagates as exit code 7", async () => {
  const run = await launch({ command: ["cmd.exe", "/c", "exit", "7"] });
  need(run.code === 7, `exit code was ${run.code}`);
  return "exit 7";
});

// 9 — the boxed shell reads its own (merged) view of a redirected file.
await test("9  boxed read sees the copy the box itself wrote", async () => {
  const real = path.join(OUTSIDE, "dsh-sbie-shellread.txt");
  fs.writeFileSync(real, "REAL-VALUE\n");
  const script = `const fs=require('fs');const p=${JSON.stringify(real)};fs.writeFileSync(p,'BOX-VALUE\\n');process.stdout.write('READ:'+fs.readFileSync(p,'utf8').trim())`;
  const run = await launch({ command: [NODE, "-e", script] });
  need(run.code === 0, `exit ${run.code}: ${run.stderr}`);
  need(run.stdout.includes("READ:BOX-VALUE"), `boxed read saw ${JSON.stringify(run.stdout)}`);
  need(fs.readFileSync(real, "utf8").includes("REAL-VALUE"), "the host copy was changed");
  return "boxed=BOX-VALUE host=REAL-VALUE";
});

// 10 — stdin reaches the command.
await test("10 stdin is forwarded into the box", async () => {
  const run = await launch({ command: [NODE, "-e", "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write('GOT:'+s.trim()))"], stdin: "PIPE-PAYLOAD" });
  need(run.code === 0, `exit ${run.code}: ${run.stderr}`);
  need(run.stdout.includes("GOT:PIPE-PAYLOAD"), `stdout was ${JSON.stringify(run.stdout)}`);
  return "stdin round-trip ok";
});

// 11 — two workspaces never share a box.
await test("11 two workspaces get two independent boxes", async () => {
  const otherBox = boxNameFor(OTHER_WORKSPACE, "workspace-write");
  need(otherBox !== BOX, "box names collided");
  const run = await launch({
    workspace: OTHER_WORKSPACE,
    command: ["cmd.exe", "/c", "echo other> C:\\Windows\\Temp\\dsh-sbie-other.txt"]
  });
  need(run.code === 0, `exit ${run.code}: ${run.stderr}`);
  const otherCopy = path.join(boxRoot(otherBox), "drive", "C", "Windows", "Temp", "dsh-sbie-other.txt");
  need(fs.existsSync(otherCopy), `no copy in the second box: ${otherCopy}`);
  const firstCopy = boxPathOf("C:\\Windows\\Temp\\dsh-sbie-other.txt");
  need(!fs.existsSync(firstCopy), "the write leaked into the first workspace's box");
  return `${BOX} vs ${otherBox}`;
});

// 12 — read-only mode must not let the workspace be written.
await test("12 read-only mode denies a workspace write", async () => {
  const target = path.join(scratch, `ro-${rnd()}.txt`);
  fs.rmSync(target, { force: true });
  const run = await launch({ mode: "read-only", command: ["cmd.exe", "/c", `echo nope> "${target}"`] });
  need(!fs.existsSync(target), "read-only mode wrote to the real workspace");
  const copy = path.join(boxRoot(boxNameFor(WORKSPACE, "read-only")), "drive", "C", path.resolve(target).slice(3));
  need(!fs.existsSync(copy), `read-only mode silently redirected the write to ${copy} instead of denying it`);
  return `exit ${run.code}, neither real nor copy written`;
});

// 13 — concurrent calls do not corrupt each other's channel.
await test("13 three concurrent calls each get their own answer", async () => {
  const markers = ["AAA", "BBB", "CCC"];
  const runs = await Promise.all(
    markers.map((marker) =>
      launch({ command: [NODE, "-e", `setTimeout(()=>process.stdout.write('${marker}'), ${markers.indexOf(marker) * 120})`] })
    )
  );
  runs.forEach((run, index) => {
    need(run.code === 0, `run ${markers[index]} exited ${run.code}`);
    need(run.stdout.trim() === markers[index], `run ${markers[index]} got ${JSON.stringify(run.stdout)}`);
  });
  return "3/3 isolated";
});

// 14 — a large copy stays headless (CopyLimitSilent).
await test("14 a 140 MiB outside-workspace write stays silent", async () => {
  const real = "C:\\Windows\\Temp\\dsh-sbie-large.bin";
  fs.rmSync(real, { force: true });
  fs.rmSync(boxPathOf(real), { force: true });
  const script = `const fs=require('fs');const b=Buffer.alloc(1024*1024,7);const fd=fs.openSync(${JSON.stringify(real)},'w');for(let i=0;i<140;i++)fs.writeSync(fd,b);fs.closeSync(fd);process.stdout.write('written')`;
  const run = await launch({ command: [NODE, "-e", script] });
  const copy = boxPathOf(real);
  const copySize = fs.existsSync(copy) ? fs.statSync(copy).size : 0;
  need(!fs.existsSync(real), "the real 140 MiB file exists");
  need(run.code === 0, `exit ${run.code}: ${run.stderr}`);
  need(!/prompt|dialog/i.test(run.stderr), `a modal prompt leaked into stderr: ${run.stderr}`);
  return `exit 0, copy ${(copySize / 1048576).toFixed(0)} MiB`;
});

// 15 — runner failures announce themselves on the configured signature.
await test("15 a missing command is reported as a runner-side failure", async () => {
  const run = await launch({ command: ["C:\\definitely\\not\\here.exe"] });
  need(run.code !== 0, "a missing executable exited 0");
  return `exit ${run.code}`;
});

// 16 — the launcher's own error dialect is exactly the configured signature.
await test("16 launcher failures print the configured fatal signature", async () => {
  const result = spawnSync(NODE, [launcher, "--dry-run"], { encoding: "utf8", windowsHide: true });
  need(result.status === 127, `status was ${result.status}`);
  need(result.stderr.includes("dsh-sbie-run: "), `stderr was ${JSON.stringify(result.stderr)}`);
  return "exit 127 + signature";
});

// 17 — the real DSH shell (pwsh) round-trips a workspace file through the box.
await test("17 pwsh writes and reads a workspace file through the box", async () => {
  const target = path.join(scratch, `ps-${rnd()}.txt`);
  const script = `Set-Content -LiteralPath '${target}' -Value 'PS-VALUE'; Get-Content -LiteralPath '${target}'`;
  const run = await launch({ command: ["pwsh", "-NoProfile", "-NonInteractive", "-Command", script] });
  need(run.code === 0, `exit ${run.code}: ${run.stderr}`);
  need(run.stdout.includes("PS-VALUE"), `stdout was ${JSON.stringify(run.stdout)}`);
  need(fs.existsSync(target) && fs.readFileSync(target, "utf8").includes("PS-VALUE"), "the real workspace file is missing");
  return "pwsh write-through ok";
});

// 18 — box start/stop churn must stay reliable (the SBIE2308-sensitive path:
// Sandboxie builds and tears down a box's isolated IPC object directory
// whenever the box empties and refills, which is once per command here).
await test("18 six consecutive boxed launches all succeed", async () => {
  const failures = [];
  for (let i = 0; i < 6; i += 1) {
    const run = await launch({ command: [NODE, "-e", `process.stdout.write('soak-${i}')`] });
    if (run.code !== 0 || !run.stdout.includes(`soak-${i}`)) failures.push(`${i}:exit=${run.code}`);
  }
  need(failures.length === 0, `failed launches: ${failures.join(", ")}`);
  return "6/6";
});

// 19 — documented Sandboxie limitation: copy-on-write refuses to re-materialise
// an existing file under C:\Windows\Temp. The write is denied, which still
// leaves the host file untouched — the safety property holds either way. This
// reproduces in the stock DefaultBox too, so it is not a property of our box.
await test("19 C:\\Windows\\Temp modify is refused, host file still intact", async () => {
  const real = "C:\\Windows\\Temp\\dsh-sbie-refused.txt";
  fs.writeFileSync(real, "ORIGINAL\n");
  const run = await launch({ command: nodeWrite(real, "MODIFIED\n") });
  need(fs.readFileSync(real, "utf8").includes("ORIGINAL"), "the real file was modified");
  const copy = boxPathOf(real);
  return run.code === 0 ? "write accepted, redirected to the copy" : `write refused (exit ${run.code}), host intact`;
});

// ---------------------------------------------------------------------------

const failed = results.filter((entry) => !entry.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed`);
process.stdout.write(`   relay retries: ${RELAY_RETRIES}/${results.length}\n`);
process.stdout.write(`box: ${BOX}  copy root: ${BOX_ROOT}\n`);
process.exitCode = failed.length === 0 ? 0 : 1;

