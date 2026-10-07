/**
 * Audit every stored session log for event types this harness does not know.
 *
 * The persistence read path refuses to interpret a log that contains an event
 * whose type the installed harness does not recognize, unless the event's
 * envelope carries `ignorable: true`. A plugin that appended a private event
 * type through live `Session.append()` (which cannot set that marker) makes
 * its sessions unopenable after a restart. Run this to see whether any stored
 * session is in that state, and which ones.
 *
 * The container walk mirrors the backend's own `scanZstdFrames`: frames are
 * located structurally (magic, frame header, block chain, optional checksum)
 * and each complete frame is decoded independently, exactly as the backend
 * reads it.
 *
 * usage:
 *   node tools/scan-session-events.mjs [<sessionsRoot>] [<knownType> ...]
 *
 * Defaults: $DSH_HOME/sessions (or %USERPROFILE%\.dsh\sessions) and the event
 * vocabulary of the harness build this plugin was written against. Pass `--all`
 * to list every distinct event type per session instead of only the offenders.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ZSTD_MAGIC = 4247762216;

/** The event vocabulary the plugin was written against (harness format v4). */
const KNOWN_EVENT_TYPES = [
  "agent-preset/selected", "agent/inbox/spliced", "approval/asked", "approval/decided",
  "approval/policy", "assistant/attempt", "assistant/message", "command/done", "command/run",
  "compaction/end", "compaction/prune", "compaction/start", "compaction/summary",
  "deliverables/presented", "developer/message", "feedback/message-delete", "feedback/message-put",
  "feedback/record", "goal/change", "hook/invoked", "hook/result", "image/offload", "llm/retry",
  "llm/retry-started", "model/selection", "permission/preset", "plan/mode", "request/context",
  "request/header", "sandbox/mode", "schedule/change", "session-log-deepseek/delivery-accepted",
  "session/end-seed", "session/title", "session/title-llm-request", "step/end", "step/start",
  "subagent/catalog", "subagent/descriptor", "subagent/model-selection-policy", "system/message",
  "team/member", "team/message/delivered", "team/message/queued", "team/task", "todo/write",
  "tool-workflow/agent-end", "tool-workflow/agent-start", "tool-workflow/run-end",
  "tool-workflow/run-start", "tool/call", "tool/ptc-dispatch", "tool/ptc-dispatch-start",
  "tool/result", "turn/end", "turn/start", "user/message",
  "web/deepseek-search-llm-request", "workspace/changes"
];

/** Locate complete Zstandard frames without decompressing them. */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset, checksum });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

/** Read one stored log into its header and event rows. */
export function readSessionLog(logPath) {
  const bytes = fs.readFileSync(logPath);
  const { frames, tornStart } = scanZstdFrames(bytes);
  if (tornStart !== undefined) throw new Error(`torn final Zstandard frame at byte ${tornStart}`);
  let header;
  const events = [];
  for (const frame of frames) {
    const text = zlib.zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString("utf8");
    for (const line of text.split("\n")) {
      if (line === "") continue;
      const row = JSON.parse(line);
      if (row.type === "session" && header === undefined) header = row;
      else events.push(row);
    }
  }
  return { bytes, frames, header, events };
}

/** Every stored session directory under one sessions root. */
function sessionDirs(root) {
  if (!fs.existsSync(root)) throw new Error(`no sessions root at ${root}`);
  const dirs = [];
  for (const project of fs.readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectPath = path.join(root, project.name);
    for (const session of fs.readdirSync(projectPath, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      dirs.push({ id: session.name, dir: path.join(projectPath, session.name) });
    }
  }
  return dirs;
}

function main(argv) {
  const showAll = argv.includes("--all");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const root = positional[0] ?? path.join(process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? ".", ".dsh"), "sessions");
  const known = new Set([...KNOWN_EVENT_TYPES, ...positional.slice(1)]);
  let offenders = 0;
  for (const { id, dir } of sessionDirs(root)) {
    const log = ["jsonl.zstd", "jsonl"]
      .map((suffix) => path.join(dir, `session.v4.${suffix}`))
      .find((candidate) => fs.existsSync(candidate));
    if (log === undefined) continue;
    const { header, events, frames } = readSessionLog(log);
    const unknown = events.filter((event) => typeof event.type === "string" && !known.has(event.type));
    const unmarked = unknown.filter((event) => event.ignorable !== true);
    const line = [
      id.padEnd(46),
      `events=${String(events.length).padStart(5)}`,
      `frames=${String(frames.length).padStart(5)}`,
      `cwd=${header?.cwd ?? "-"}`
    ].join(" ");
    if (unmarked.length > 0) {
      offenders += 1;
      console.log(`${line}  UNOPENABLE`);
      for (const event of unmarked) console.log(`    seq ${event.seq}: "${event.type}" without ignorable`);
    } else if (unknown.length > 0) {
      console.log(`${line}  ok (tolerated: ${[...new Set(unknown.map((e) => e.type))].join(", ")})`);
    } else if (showAll) {
      const types = [...new Set(events.map((event) => event.type))].sort();
      console.log(`${line}  ok (${types.length} types: ${types.join(", ")})`);
    } else {
      console.log(`${line}  ok`);
    }
  }
  console.log(offenders === 0 ? "\nno unopenable session logs" : `\n${offenders} session log(s) would refuse to load`);
  process.exitCode = offenders === 0 ? 0 : 1;
}

/** True when this file is the process entry point (so imports stay silent). */
const isEntryPoint = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntryPoint) main(process.argv.slice(2));
