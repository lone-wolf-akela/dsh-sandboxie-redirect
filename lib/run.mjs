/**
 * `dsh-sbie-run` — the DSH sandbox runner that turns "deny writes outside the
 * workspace" into "let them succeed, but land in a throwaway copy".
 *
 * DSH's `@deepseek-ai/dsh-sandbox-local` provider, when configured with a
 * `runnerCommand`, stops enforcing anything itself and hands over:
 *
 *   [<runnerCommand...>, ...bwrapProfileArgs(policy), "--", <real argv...>]
 *
 * `bwrapProfileArgs` is bubblewrap vocabulary that has no meaning on Windows.
 * We read exactly two facts out of it — the workspace root (`--bind <ws> <ws>`)
 * and whether the mode grants writes (the presence of that `--bind`) — then
 * ignore the rest.
 *
 * Everything after the `--` is the command the model asked for. It is forwarded
 * verbatim: this process never re-quotes or re-parses it.
 *
 *   launcher (unboxed, owns the pipes)
 *      |  SbieDll_RunSandboxed(box, "node inner.mjs --port N --token T")
 *      v
 *   relay (boxed, no usable handles)
 *      |  loopback TCP: argv/cwd/env in, stdout/stderr/exit out
 *      |  spawn(argv) -> the command inherits the box
 *      v
 *   the model's command
 */
import { randomBytes } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boxNameFor, canonicalWorkspace, ensureBox } from "./boxes.mjs";
import { Frame, createFrameDecoder, encodeFrame, encodeJsonFrame } from "./protocol.mjs";
import { runSandboxed, killProcess, sbieDir } from "./sbie.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const relayScript = path.join(here, "inner.mjs");

/** Our own leading switches; anything else before `--` is the runner's profile dialect. */
const OUR_FLAGS = new Map([
  ["--box", 1],
  ["--workspace", 1],
  ["--mode", 1],
  ["--relay-timeout-ms", 1],
  ["--dry-run", 0],
  ["--verbose", 0]
]);

function usage() {
  return [
    "usage: dsh-sbie-run [--box NAME] [--workspace DIR] [--mode workspace-write|read-only] <runner profile args...> -- <command argv...>",
    "       dsh-sbie-run --manage list|clean <workspace>|delete-box <box>"
  ].join("\n");
}

/**
 * Split the runner argv into (our switches, the provider's profile args, the command).
 * @param {string[]} argv
 */
export function parseRunnerArgv(argv) {
  const options = { box: undefined, workspace: undefined, mode: undefined, relayTimeoutMs: 20000, dryRun: false, verbose: false };
  let index = 0;
  while (index < argv.length && OUR_FLAGS.has(argv[index])) {
    const name = argv[index];
    const arity = OUR_FLAGS.get(name);
    index += 1;
    let value;
    if (arity === 1) {
      value = argv[index];
      index += 1;
      if (value === undefined) throw new Error(`${name} requires a value`);
    }
    if (name === "--box") options.box = value;
    else if (name === "--workspace") options.workspace = value;
    else if (name === "--mode") options.mode = value;
    else if (name === "--relay-timeout-ms") options.relayTimeoutMs = Number(value);
    else if (name === "--dry-run") options.dryRun = true;
    else if (name === "--verbose") options.verbose = true;
  }

  const separator = argv.indexOf("--", index);
  if (separator < 0) throw new Error(`missing "--" separator before the command\n${usage()}`);
  const profileArgs = argv.slice(index, separator);
  const command = argv.slice(separator + 1);

  // The only facts we need out of the bubblewrap dialect.
  let workspace;
  let mode = "read-only";
  for (let i = 0; i < profileArgs.length; i += 1) {
    if (profileArgs[i] === "--bind" && profileArgs[i + 1] !== undefined) {
      workspace = profileArgs[i + 1];
      mode = "workspace-write";
      i += 2;
    }
  }
  if (options.workspace !== undefined) workspace = options.workspace;
  if (options.mode !== undefined) mode = options.mode === "read-only" ? "read-only" : "workspace-write";
  if (workspace === undefined) workspace = process.env.DSH_SBIE_WORKSPACE ?? process.cwd();
  return { options, profileArgs, command, workspace: canonicalWorkspace(workspace), mode };
}

function fail(message, code = 127) {
  process.stderr.write(`dsh-sbie-run: ${message}\n`);
  process.exit(code);
}

function quote(value) {
  return `"${value.replaceAll('"', '\\"')}"`;
}

/**
 * Bind the loopback listener the boxed relay will dial.
 *
 * Returns as soon as the socket is bound — the caller must start the relay and
 * only then await `accepted`, otherwise it waits for a connection nobody has
 * been asked to make yet.
 */
function openChannel(timeoutMs) {
  const token = randomBytes(24).toString("hex");
  const server = net.createServer();
  let settle;
  let fail;
  const accepted = new Promise((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const timer = setTimeout(() => fail(new Error(`the boxed relay did not connect within ${timeoutMs} ms`)), timeoutMs);
  server.on("error", (error) => {
    clearTimeout(timer);
    fail(error);
  });
  server.once("connection", (socket) => {
    socket.setNoDelay(true);
    const decode = createFrameDecoder((type, body) => {
      if (type !== Frame.HELLO) return;
      let hello;
      try {
        hello = JSON.parse(body.toString("utf8"));
      } catch {
        socket.destroy();
        fail(new Error("malformed relay hello"));
        return;
      }
      if (hello.token !== token) {
        socket.destroy();
        fail(new Error("relay presented the wrong token"));
        return;
      }
      clearTimeout(timer);
      settle(socket);
    });
    socket.on("data", decode);
    socket.on("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        token,
        port: server.address().port,
        accepted: accepted.catch((error) => {
          server.close();
          throw error;
        }),
        dispose: () => {
          clearTimeout(timer);
          server.close();
        }
      });
    });
    server.once("error", reject);
  });
}

/**
 * Run one confined command.
 *
 * @param {string[]} argv - the runner argv DSH produced.
 * @param {{stdin?: NodeJS.ReadableStream, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream}} [io]
 * @returns {Promise<number>} the command's exit code.
 */
export async function run(argv, io = {}) {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;

  const parsed = parseRunnerArgv(argv);
  const { options, command, workspace, mode } = parsed;
  if (command.length === 0) throw new Error(`no command after "--"\n${usage()}`);

  const box = options.box ?? process.env.DSH_SBIE_BOX ?? boxNameFor(workspace, mode);
  const log = options.verbose ? (message) => process.stderr.write(`dsh-sbie-run: ${message}\n`) : () => {};

  if (sbieDir() === undefined) throw new Error("Sandboxie-Plus is not installed (SbieDll.dll not found)");

  const ensured = ensureBox({ box, workspace, mode, logger: log });
  const env = { ...process.env, DSH_SANDBOX_ROOT: ensured.root, DSH_SBIE_BOX: ensured.box };

  if (options.dryRun) {
    stdout.write(
      `${JSON.stringify({ box: ensured.box, boxRoot: ensured.root, workspace: ensured.workspace, mode: ensured.mode, created: ensured.created, cwd: process.cwd(), argv: command }, null, 2)}\n`
    );
    return 0;
  }

  const channel = await startRelay(ensured, options, log);
  return await relay({ server: channel.server, socket: channel.socket }, { command, cwd: process.cwd(), env, stdin, stdout, stderr, box: ensured });
}

/**
 * Start the boxed relay, retrying a few times.
 *
 * Sandboxie occasionally fails to bring a box up: its isolated IPC object
 * directory creation can lose a race with the previous teardown
 * (`SBIE2308 … C0000024`), the box's GUI server is then refused
 * (`SBIE2336 … C0000022`), the boxed process fails to initialise
 * (`SBIE2335`) and the launch aborts with `SBIE2337 / Win32 1067`
 * (`ERROR_PROCESS_ABORTED`). Sometimes the process starts but never reaches
 * the listener. Both shapes are transient — a fresh attempt on a new channel
 * has always succeeded — so they are retried, with a short settle pause so the
 * teardown can finish, and a stranded relay is killed rather than left behind.
 */
async function startRelay(ensured, options, log) {
  // A healthy relay connects in well under a second, so a long first wait only
  // wastes time when the box is struggling; later attempts get more room for a
  // genuinely slow first start of a box.
  const attemptTimeouts = [Math.min(options.relayTimeoutMs, 7000), 10000, 15000];
  const attempts = attemptTimeouts.length;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const timeoutMs = attemptTimeouts[attempt - 1];
    let channel;
    let launched;
    try {
      channel = await openChannel(timeoutMs);
      const relayCommandLine = `${quote(process.execPath)} ${quote(relayScript)} --port ${channel.port} --token ${channel.token}`;
      // The relay's own cwd only has to be a directory the Sandboxie service
      // can resolve; the command's real cwd travels in the spec.
      launched = runSandboxed({ box: ensured.box, commandLine: relayCommandLine, cwd: here });
      if (!launched.ok) throw new Error(`cannot start the boxed relay in ${ensured.box}: ${launched.error}`);
      log(`boxed relay pid ${launched.pid} in ${ensured.box} (attempt ${attempt})`);
      const socket = await channel.accepted;
      return { server: channel.server, socket, pid: launched.pid };
    } catch (error) {
      lastError = error;
      channel?.dispose();
      if (launched?.ok === true) killProcess(launched.hProcess);
      const detail = error instanceof Error ? error.message : String(error);
      log(`relay attempt ${attempt}/${attempts} failed: ${detail}`);
      if (attempt < attempts) await sleep(300 * attempt);
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pump one command's stdio through the channel and settle on its exit code. */
function relay(channel, session) {
  const { socket, server } = channel;
  const { stdin, stdout, stderr } = session;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      server.close();
      socket.destroy();
      resolve(code);
    };
    const bail = (error) => {
      if (settled) return;
      settled = true;
      server.close();
      socket.destroy();
      reject(error);
    };

    const decode = createFrameDecoder((type, body) => {
      switch (type) {
        case Frame.STDOUT:
          stdout.write(body);
          break;
        case Frame.STDERR:
          stderr.write(body);
          break;
        case Frame.EXIT: {
          const { code } = JSON.parse(body.toString("utf8"));
          done(code === null ? 1 : code);
          break;
        }
        case Frame.FAIL:
          // The boxed side could not start the command at all: that is a runner
          // failure, not a command failure, so it takes the fatal signature and
          // the runner's own exit code.
          stderr.write(`dsh-sbie-run: ${body.toString("utf8")}\n`);
          done(127);
          break;
        default:
          break;
      }
    });
    socket.on("data", decode);
    socket.on("error", (error) => bail(error));
    socket.on("close", () => {
      if (!settled) bail(new Error("the boxed relay closed the channel before reporting an exit code"));
    });

    socket.write(encodeJsonFrame(Frame.SPEC, { argv: session.command, cwd: session.cwd, env: session.env }));

    const forward = (chunk) => {
      if (socket.destroyed) return;
      if (typeof chunk === "string") socket.write(encodeFrame(Frame.STDIN, Buffer.from(chunk, "utf8")));
      else socket.write(encodeFrame(Frame.STDIN, chunk));
    };
    if (stdin !== null && stdin !== undefined && typeof stdin.on === "function" && stdin.readable !== false) {
      stdin.on("data", forward);
      stdin.on("end", () => {
        if (!socket.destroyed) socket.write(encodeFrame(Frame.STDIN_EOF));
      });
      stdin.on("error", () => {
        if (!socket.destroyed) socket.write(encodeFrame(Frame.STDIN_EOF));
      });
      if (stdin.readableEnded === true) socket.write(encodeFrame(Frame.STDIN_EOF));
    } else {
      socket.write(encodeFrame(Frame.STDIN_EOF));
    }
  });
}

/** Entry point for the bin shim: exits with the command's code, or 127 on runner failure. */
export async function main(argv = process.argv.slice(2)) {
  try {
    const code = await run(argv);
    process.exitCode = code;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
