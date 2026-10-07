#!/usr/bin/env node
/**
 * Refresh the installed plugin from this working copy.
 *
 * WHY THIS SCRIPT EXISTS — the trap it encodes
 * --------------------------------------------
 * The plugin lives at `~/.dsh/plugins/dsh-sandboxie-redirect`, which is OUTSIDE
 * the workspace. In copy-on-write mode a shell command runs inside a Sandboxie
 * box, where every write outside the workspace is REDIRECTED into the box's
 * copy. So a `Copy-Item` into the plugin directory reports success while the
 * real plugin keeps its old bytes — and the natural check ("read it back") is
 * worse than useless, because an in-box read sees the merged view and happily
 * agrees that the new content is there.
 *
 * That combination silently invalidated several rounds of fixes: the code was
 * correct, the "install" was a no-op, and the verification confirmed the no-op.
 * Hence: refuse to run inside a box at all, and verify with HASHES against the
 * host-side view rather than trusting a copy's exit status.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, "..");
const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
const target = path.join(home, ".dsh", "plugins", "dsh-sandboxie-redirect");

const boxFlag = process.env.DSH_SBIE_BOX ?? "";
const boxRoot = process.env.DSH_SANDBOX_ROOT ?? "";
if (boxFlag !== "" || boxRoot !== "") {
  console.error("refusing to install from inside the sandbox box" + (boxFlag === "" ? "" : ` (DSH_SBIE_BOX=${boxFlag})`));
  console.error("");
  console.error("Writes to the plugin directory are redirected into the box copy, so this would");
  console.error("report success while the real plugin kept its old code:");
  console.error(`  redirected target: ${(boxRoot === "" ? "<box root>" : boxRoot)}\\user\\current\\.dsh\\plugins\\dsh-sandboxie-redirect`);
  console.error(`  real target      : ${target}`);
  console.error("");
  console.error("Run this from a danger-full-access session, or from a plain console outside DSH.");
  process.exit(2);
}

const ENTRIES = ["lib", "bin", "test", "tools", "package.json", "README.zh.md", "README.md", "AGENTS.md"];

const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const relativeFiles = (root) => {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) found.push(path.relative(root, full));
    }
  };
  walk(root);
  return found;
};

if (!fs.existsSync(path.join(source, "package.json"))) {
  console.error(`no package.json under ${source} — run this from the plugin's own working copy`);
  process.exit(2);
}

fs.mkdirSync(target, { recursive: true });

const copied = [];
for (const entry of ENTRIES) {
  const from = path.join(source, entry);
  if (!fs.existsSync(from)) continue;
  const to = path.join(target, entry);
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
  copied.push(entry);
}

console.log(`installed from ${source}`);
console.log(`           to ${target}`);
console.log(`entries: ${copied.join(", ")}\n`);

// Verify by hash. This is the part that would have caught the redirection: a
// redirected copy cannot make these match, because these reads come from a
// process that is NOT inside a box.
let mismatched = 0;
let verified = 0;
for (const entry of copied) {
  const from = path.join(source, entry);
  if (fs.statSync(from).isFile()) {
    const same = sha(from) === sha(path.join(target, entry));
    if (!same) mismatched += 1;
    verified += 1;
    console.log(`  ${same ? "ok  " : "DIFF"} ${entry}`);
    continue;
  }
  for (const rel of relativeFiles(from)) {
    const a = path.join(source, entry, rel);
    const b = path.join(target, entry, rel);
    const same = fs.existsSync(b) && sha(a) === sha(b);
    if (!same) {
      mismatched += 1;
      console.log(`  DIFF ${path.join(entry, rel)}`);
    }
    verified += 1;
  }
}

console.log(`\n${verified} file(s) compared, ${mismatched} mismatch(es)`);
if (mismatched > 0) {
  console.error("INSTALL DID NOT TAKE — the target does not match this working copy.");
  process.exit(1);
}
console.log("verified byte-for-byte.");
