/**
 * Repair session logs that a plugin made unopenable by appending a private
 * event type through live `Session.append()`.
 *
 * The persistence read path refuses a stored event whose type the installed
 * harness does not know, unless the event's envelope carries
 * `ignorable: true`. Live `Session.append()` cannot set that marker, so such
 * a session fails to load after a restart:
 *
 *   session "<id>" contains event type "sandbox/box" (seq 1849) unknown to
 *   this harness and not marked ignorable; refusing to interpret the log
 *
 * The event cannot simply be deleted: the log's `seq` values are the array
 * indices and must stay contiguous from 0. So this keeps every row and stamps
 * the marker the harness already defines for exactly this case — an unknown
 * event it is allowed to skip. `seq`, `time`, and `data` are untouched, so the
 * fold that derives state from the log sees the same payload as before.
 *
 * Frames that contain no repaired row are copied byte-for-byte. Frames that
 * do are re-encoded with the checksum setting their own header declared.
 * The original file is backed up before the first write.
 *
 * usage:
 *   node tools/stamp-ignorable.mjs <log|sessionsRoot> [--type <eventType>] [--apply]
 *
 * Without `--apply` it is a dry run that prints what it would change.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { readSessionLog, scanZstdFrames } from "./scan-session-events.mjs";

const BACKUP_SUFFIX = ".bak-dsh-sbie-box-event";

/** Re-encode one frame with the checksum setting its header declared. */
function encodeFrame(text, checksum) {
  return zlib.zstdCompressSync(Buffer.from(text, "utf8"), {
    params: { [zlib.constants.ZSTD_c_checksumFlag]: checksum ? 1 : 0 }
  });
}

/**
 * Stamp `ignorable: true` on every row of `targetType`, preserving everything
 * else about the log. Returns a summary; writes only when `apply` is true.
 */
export function stampIgnorable(logPath, targetType, apply) {
  const bytes = fs.readFileSync(logPath);
  const { frames, tornStart } = scanZstdFrames(bytes);
  if (tornStart !== undefined) throw new Error(`refusing to repair a log with a torn final frame at byte ${tornStart}`);

  const parts = [];
  let repaired = 0;
  let rows = 0;
  let lastSeq = -1;
  let gaps = 0;
  for (const frame of frames) {
    const text = zlib.zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString("utf8");
    const outLines = [];
    let changed = false;
    for (const line of text.split("\n")) {
      if (line === "") continue;
      rows += 1;
      const row = JSON.parse(line);
      if (typeof row.seq === "number") {
        if (row.seq !== lastSeq + 1) gaps += 1;
        lastSeq = row.seq;
      }
      if (row.type === targetType && row.ignorable !== true) {
        // Rebuild in the writer's key order; only the marker is added.
        const rebuilt = {};
        for (const key of Object.keys(row)) rebuilt[key] = row[key];
        rebuilt.ignorable = true;
        outLines.push(JSON.stringify(rebuilt));
        repaired += 1;
        changed = true;
        continue;
      }
      outLines.push(line);
    }
    parts.push(changed ? encodeFrame(outLines.length === 0 ? "" : `${outLines.join("\n")}\n`, frame.checksum) : bytes.subarray(frame.start, frame.end));
  }

  const after = Buffer.concat(parts);
  // Verify the rebuilt container before it can reach the disk.
  const verify = scanZstdFrames(after);
  if (verify.tornStart !== undefined) throw new Error("rebuilt log has a torn final frame");
  let verifyRows = 0;
  let verifySeq = -1;
  const remaining = [];
  for (const frame of verify.frames) {
    const text = zlib.zstdDecompressSync(after.subarray(frame.start, frame.end)).toString("utf8");
    for (const line of text.split("\n")) {
      if (line === "") continue;
      verifyRows += 1;
      const row = JSON.parse(line);
      if (typeof row.seq !== "number") continue;
      if (row.seq !== verifySeq + 1) throw new Error(`rebuilt log has a seq gap before ${row.seq}`);
      verifySeq = row.seq;
      if (row.type === targetType && row.ignorable !== true) remaining.push(row.seq);
    }
  }
  if (verifyRows !== rows) throw new Error(`rebuilt log has ${verifyRows} rows, expected ${rows}`);
  if (remaining.length > 0) throw new Error(`rebuilt log still has unmarked ${targetType} rows at ${remaining.join(", ")}`);

  const summary = {
    log: logPath,
    frames: frames.length,
    rows,
    lastSeq,
    seqGaps: gaps,
    repaired,
    bytesBefore: bytes.length,
    bytesAfter: after.length,
    backup: undefined
  };
  if (repaired > 0 && apply) {
    const backup = `${logPath}${BACKUP_SUFFIX}`;
    if (!fs.existsSync(backup)) fs.copyFileSync(logPath, backup);
    fs.writeFileSync(logPath, after);
    summary.backup = backup;
  }
  return summary;
}

/** Every stored session log under one sessions root. */
function logsUnder(root) {
  if (fs.statSync(root).isFile()) return [root];
  const logs = [];
  for (const project of fs.readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectPath = path.join(root, project.name);
    for (const session of fs.readdirSync(projectPath, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      for (const suffix of ["jsonl.zstd", "jsonl"]) {
        const log = path.join(projectPath, session.name, `session.v4.${suffix}`);
        if (fs.existsSync(log)) logs.push(log);
      }
    }
  }
  return logs;
}

function main(argv) {
  const apply = argv.includes("--apply");
  const typeIndex = argv.indexOf("--type");
  const targetType = typeIndex === -1 ? "sandbox/box" : argv[typeIndex + 1];
  const positional = argv.filter((arg, index) => !arg.startsWith("--") && index !== typeIndex + 1);
  const target = positional[0] ?? path.join(process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? ".", ".dsh"), "sessions");
  if (targetType === undefined) throw new Error("--type needs a value");
  const logs = logsUnder(target);
  if (logs.length === 0) throw new Error(`no session logs under ${target}`);
  let total = 0;
  for (const log of logs) {
    const summary = stampIgnorable(log, targetType, apply);
    if (summary.repaired === 0) continue;
    total += summary.repaired;
    console.log(JSON.stringify(summary));
  }
  if (total === 0) console.log(`no "${targetType}" rows need the marker (${logs.length} log(s) scanned)`);
  else console.log(apply ? `\nstamped ${total} row(s)` : `\ndry run: ${total} row(s) would be stamped; pass --apply to write`);
}

const isEntryPoint = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntryPoint) main(process.argv.slice(2));
