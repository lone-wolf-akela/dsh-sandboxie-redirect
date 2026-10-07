#!/usr/bin/env node
/**
 * Report the Sandboxie copies bound to one workspace — the same view the
 * `sandbox_clear` tool takes, and without needing Sandboxie's API at all: this
 * reads the configuration file and walks the copy trees with plain fs.
 *
 *   node tools/inspect-copies.mjs ["C:\path\to\workspace"]
 *
 * It still identifies the copies when run INSIDE a sandbox box, but it SKIPS the
 * size accounting there on purpose: measuring `C:\Sandbox\…` from inside the box
 * walks the box's own storage through the redirection layer, which hangs.
 */
import * as host from "../lib/host.mjs";
import * as naming from "../lib/naming.mjs";
import { copiesFor } from "../lib/tool.mjs";

const insideBox = (process.env.DSH_SBIE_BOX ?? "") !== "";
const workspace = naming.canonicalWorkspace(process.argv[2] ?? process.cwd());
const copies = copiesFor(host, naming, workspace, { sizes: !insideBox });

console.log(`workspace: ${workspace}`);
if (copies === null) {
  console.log(`cannot read ${host.sandboxIniPath()}`);
  process.exit(1);
}
if (copies.length === 0) {
  console.log("copies   : none — reads and writes outside the workspace reflect the real disk");
} else {
  console.log(`copies   : ${copies.length}`);
  for (const copy of copies) {
    const size = copy.bytes === undefined ? "" : copy.bytes < 1024 * 1024 ? `, ${(copy.bytes / 1024).toFixed(1)} KB` : `, ${(copy.bytes / (1024 * 1024)).toFixed(1)} MB`;
    console.log(`  ${copy.box}  ${copy.files === undefined ? "(size skipped)" : `${copy.files} file(s)${size}`}`);
    console.log(`    ${copy.root}`);
  }
}
if (insideBox) console.log("\nWARNING: ran INSIDE a sandbox box, so sizes are omitted.");
