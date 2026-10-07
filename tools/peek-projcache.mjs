// Read-only peek at one session's projection checkpoint: what the host last
// persisted for the `sandboxBox` unit (and anything else naming a sandbox).
import fs from "node:fs";
import path from "node:path";

const dir = path.join(process.env.USERPROFILE ?? "", ".dsh", "storages", "session_projcache", "sessions");
const wanted = process.argv[2];
const files = fs.readdirSync(dir).filter((name) => (wanted === undefined ? true : name.includes(wanted)));
for (const name of files.slice(0, 3)) {
  const file = path.join(dir, name);
  console.log(`== ${name} (${fs.statSync(file).size} bytes, ${fs.statSync(file).mtime.toISOString()})`);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.log(`   cannot parse: ${error.message}`);
    continue;
  }
  const hits = [];
  const walk = (node, at) => {
    if (node === null || typeof node !== "object") return;
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (/sandbox/i.test(key)) hits.push([`${at}.${key}`, value]);
      walk(value, `${at}.${key}`);
    }
  };
  walk(data, "");
  if (hits.length === 0) console.log("   (no key naming a sandbox)");
  for (const [where, value] of hits) {
    console.log(`   ${where} = ${JSON.stringify(value)?.slice(0, 300)}`);
  }
}
