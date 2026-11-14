/**
 * The boxed half of the runner.
 *
 * Started by `SbieDll_RunSandboxed`, so this process already lives inside the
 * Sandboxie box, but it starts with SbieSvc's handles rather than the
 * launcher's. It therefore:
 *   1. dials back to the launcher over loopback TCP (the one channel measured
 *      to cross the box boundary — named pipes do not),
 *   2. receives the exact argv/cwd/env,
 *   3. spawns the real command with ordinary pipes. Because this process is
 *      boxed, the child inherits the box: that is Sandboxie's core rule.
 *
 * If the launcher dies, the socket closes and the child is killed with it —
 * the stand-in for bwrap's `--die-with-parent`.
 */
import { spawn } from "node:child_process";
import net from "node:net";
import { Frame, createFrameDecoder, encodeFrame, encodeJsonFrame } from "./protocol.mjs";

function parseArgs(argv) {
  const out = { host: "127.0.0.1", port: 0, token: "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--port") out.port = Number(argv[++i]);
    else if (argv[i] === "--token") out.token = argv[++i];
    else if (argv[i] === "--host") out.host = argv[++i];
  }
  return out;
}

const options = parseArgs(process.argv.slice(2));
if (!Number.isInteger(options.port) || options.port <= 0) {
  process.stderr.write("dsh-sbie-relay: missing --port\n");
  process.exit(2);
}

let child;
let control;
let finished = false;

const socket = net.connect({ host: options.host, port: options.port });
socket.setNoDelay(true);

function send(type, payload) {
  if (socket.destroyed) return;
  socket.write(encodeFrame(type, payload));
}

function finish(code) {
  if (finished) return;
  finished = true;
  process.exitCode = code;
  setTimeout(() => process.exit(code), 10).unref?.();
}

function startChild(spec) {
  let childProcess;
  // The harness's control channel reaches the launcher on fd 7 (DSH's
  // SUBPROCESS_CONTROL_FD); SbieSvc cannot pass inherited handles into the box,
  // so the launcher forwards the bytes and we re-create the same shape here: an
  // `overlapped` named pipe at fd 7, which the PTC runtime opens with
  // `net.Socket`. fds 3-6 stay unused (the Windows job runner reserves them),
  // so the array must be padded rather than compacted.
  const stdio = ["pipe", "pipe", "pipe"];
  if (spec.control === true) {
    while (stdio.length < 7) stdio.push("ignore");
    stdio.push("overlapped");
  }
  try {
    childProcess = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      env: spec.env,
      stdio,
      windowsHide: true
    });
  } catch (error) {
    send(Frame.FAIL, `cannot spawn ${spec.argv[0]}: ${error.message}`);
    socket.end();
    finish(127);
    return;
  }
  child = childProcess;
  if (spec.control === true && childProcess.stdio[7] !== undefined && childProcess.stdio[7] !== null) {
    control = childProcess.stdio[7];
    control.on("data", (chunk) => send(Frame.CONTROL, chunk));
    control.on("error", () => {
      /* the launcher may close the channel first; the child's exit still decides */
    });
  }
  child.on("error", (error) => {
    send(Frame.FAIL, `cannot spawn ${spec.argv[0]}: ${error.message}`);
    socket.end();
    finish(127);
  });
  child.stdout.on("data", (chunk) => send(Frame.STDOUT, chunk));
  child.stderr.on("data", (chunk) => send(Frame.STDERR, chunk));
  child.on("exit", (code, signal) => {
    send(Frame.EXIT, JSON.stringify({ code: code === null ? null : code, signal: signal ?? null }));
    socket.end();
    finish(code === null ? 1 : code);
  });
}

socket.on("connect", () => {
  socket.write(encodeJsonFrame(Frame.HELLO, { token: options.token }));
});

const decode = createFrameDecoder((type, body) => {
  switch (type) {
    case Frame.SPEC:
      startChild(JSON.parse(body.toString("utf8")));
      break;
    case Frame.STDIN:
      if (child !== undefined && child.stdin.writable) child.stdin.write(body);
      break;
    case Frame.STDIN_EOF:
      if (child !== undefined && child.stdin.writable) child.stdin.end();
      break;
    case Frame.CONTROL:
      if (control !== undefined && control.writable) control.write(body);
      break;
    case Frame.CONTROL_EOF:
      if (control !== undefined) control.end();
      break;
    default:
      break;
  }
});

socket.on("data", decode);
socket.on("error", (error) => {
  process.stderr.write(`dsh-sbie-relay: channel error: ${error.message}\n`);
  child?.kill();
  finish(127);
});
socket.on("close", () => {
  control?.destroy();
  if (!finished) {
    // The launcher went away (or finished): do not leave the command running.
    child?.kill();
    finish(child === undefined ? 127 : 0);
  }
});
