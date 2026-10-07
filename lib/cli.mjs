/**
 * `dsh-sbie-run --manage ...` — scripted box administration.
 *
 * The same boxes are visible in SandMan (it reads the same `Sandboxie.ini`),
 * so this is a convenience for scripted inspection and cleanup, not the only
 * route: a human can browse, recover, or delete a box from the GUI.
 */
import fs from "node:fs";
import { boxNameCandidates, boxRoot, canonicalWorkspace, listManagedBoxes, managedBoxesFor, removeBox } from "./boxes.mjs";
import { boxExists, reloadConfig, sbieDir, sbieIni, sbieSandboxRoot } from "./sbie.mjs";

function print(line) {
  process.stdout.write(`${line}\n`);
}

/**
 * Sandboxie deliberately does not expose the box list to a process that is
 * itself inside a box (`SbieApi_EnumBoxes` comes back empty), so management
 * commands silently look like "no boxes exist" when run from a confined shell.
 * Say so instead.
 */
function warnIfConfined() {
  if (process.env.DSH_SANDBOX_ROOT === undefined) return;
  print("note: DSH_SANDBOX_ROOT is set, so this ran INSIDE a sandbox box.");
  print("      Sandboxie hides the box list from boxed processes; run --manage from");
  print("      a normal console, or from a session whose policy is danger-full-access.");
}

function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return "-";
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function directorySize(dir) {
  let total = 0;
  const queue = [dir];
  while (queue.length > 0) {
    const current = queue.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = `${current}\\${entry.name}`;
      try {
        if (entry.isDirectory()) queue.push(full);
        else total += fs.statSync(full).size;
      } catch {}
    }
  }
  return total;
}

function list() {
  if (sbieDir() === undefined) {
    print("Sandboxie-Plus is not installed.");
    return 1;
  }
  const boxes = listManagedBoxes();
  if (boxes.length === 0) {
    print("No managed boxes (Dsh_* / Dshr_*) exist yet.");
    return 0;
  }
  print(`sandbox root: ${sbieSandboxRoot()}`);
  print(["BOX", "MODE", "COPY", "SIZE", "WORKSPACE"].join("\t"));
  for (const entry of boxes) {
    print([entry.box, entry.mode, entry.exists ? "yes" : "no", entry.exists ? humanBytes(directorySize(entry.root)) : "-", entry.workspace || "?"].join("\t"));
  }
  return 0;
}

function clean(workspace) {
  if (workspace === undefined) {
    print("usage: dsh-sbie-run --manage clean <workspace>");
    return 2;
  }
  const root = canonicalWorkspace(workspace);
  const targets = managedBoxesFor(root);
  if (targets.length === 0) {
    print(`no managed box is bound to ${root}`);
    print(`(candidate names would be: ${[...boxNameCandidates(root, "workspace-write", 2), ...boxNameCandidates(root, "read-only", 2)].join(", ")})`);
    return 1;
  }
  for (const entry of targets) {
    removeBox(entry.box, { logger: print });
    print(`${entry.box}: removed (${entry.mode})`);
  }
  return 0;
}

function deleteBox(box) {
  if (box === undefined) {
    print("usage: dsh-sbie-run --manage delete-box <box>");
    return 2;
  }
  if (!boxExists(box)) {
    print(`${box}: not present`);
    return 1;
  }
  removeBox(box, { logger: print });
  print(`${box}: removed`);
  return 0;
}

function showBox(box) {
  if (box === undefined) {
    print("usage: dsh-sbie-run --manage show <box>");
    return 2;
  }
  if (!boxExists(box)) {
    print(`${box}: not present`);
    return 1;
  }
  const root = boxRoot(box);
  print(`box:   ${box}`);
  print(`root:  ${root}${fs.existsSync(root) ? "" : " (no copy yet)"}`);
  for (const key of ["Enabled", "OpenFilePath", "ReadFilePath", "AutoRecover", "UseFileDeleteV2"]) {
    const value = sbieIni(["query", box, key]);
    print(`${key}=${value.ok ? value.stdout || "(empty)" : "(unset)"}`);
  }
  return 0;
}

function reload() {
  reloadConfig();
  print("Sandboxie configuration reloaded.");
  return 0;
}

/** @param {string[]} argv - arguments after `--manage`. */
export function manage(argv) {
  const [subcommand, argument] = argv;
  warnIfConfined();
  switch (subcommand) {
    case undefined:
    case "list":
      return list();
    case "clean":
      return clean(argument);
    case "delete-box":
      return deleteBox(argument);
    case "show":
      return showBox(argument);
    case "reload":
      return reload();
    default:
      print(`unknown --manage subcommand: ${subcommand}`);
      print("usage: dsh-sbie-run --manage list|show <box>|clean <workspace>|delete-box <box>|reload");
      return 2;
  }
}
