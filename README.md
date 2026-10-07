# dsh-sandboxie-redirect

> **中文版**：[README.zh.md](README.zh.md)

A [DSH](https://github.com/deepseek-ai/deepseek-harness) bundle that adds a fourth permission preset, **Copy-on-write (写时复制)**: shell commands run inside a Sandboxie box dedicated to the workspace, so writes inside the workspace land on the real disk as usual, while writes, edits and deletions anywhere else keep succeeding — but only inside that box's copy. The three shipped presets (read-only, workspace-write, danger-full-access) behave exactly as before.

```
┌─ your DSH session ────────────────┐
│  file policy: copy-on-write       │
│                                   │
│  shell command ──▶ Sandboxie box ─┼──▶ workspace writes    → real disk
│  (inside the box)  (per workspace)┼──▶ writes elsewhere    → box copy
│                                   │    deletes elsewhere   → tombstone in copy
│  read/write/edit ──▶ host process ┼──▶ unchanged: writable inside the
│  (outside the box)                │    workspace, refused outside it
└───────────────────────────────────┘
```

- Windows only, and it needs [Sandboxie-Plus](https://sandboxie-plus.com/) installed (the sandbox service must be running).
- It is a permission **preset**, not a patch to the DSH application: nothing inside the app is modified.
- Its purpose is accident prevention, undo, and keeping system directories clean. It is **not** a defence against malicious programs — Sandboxie itself makes no such promise, and a plugin runs with the same access as the app hosting it.

## Terminology

| Term | Meaning |
|---|---|
| Real disk | Where files actually live (for example `C:\Users\…`). |
| Sandbox / box | The isolated environment Sandboxie creates. This plugin creates one per workspace. |
| Copy | The box's private storage for changes to files outside the workspace (under the sandbox root), kept apart from the real files. |
| Inside / outside the box | Under Copy-on-write, shell commands run inside the box; the DSH app and its file tools (read/write/edit) run outside it. |
| Merged view | What a command inside the box sees: the copy's content overlaid on the real file. |
| SandMan | Sandboxie-Plus's GUI, for inspecting, recovering and deleting sandboxes. |

## Installation

**Prerequisite:** [Sandboxie-Plus](https://sandboxie-plus.com/) ([source](https://github.com/sandboxie-plus/Sandboxie)). The installer must have created its service; every box this plugin uses is created and managed by Sandboxie.

The package is a DSH *bundle*: installing it also adds its configuration layer, so no profile file needs hand-editing.

```powershell
# install into a profile (the CLI creates it if needed and appends this bundle)
dsh plugin --profile <profile> add @lone-wolf-akela/dsh-sandboxie-redirect

# check the layer without booting, then start
dsh --profile <profile> --dump-config      # expect a "# == @lone-wolf-akela/dsh-sandboxie-redirect" layer
dsh --profile <profile>
```

Other supported sources, for a local checkout or an offline machine:

```powershell
dsh plugin --profile <profile> add C:\path\to\dsh-sandboxie-redirect   # a checkout (linked)
dsh plugin --profile <profile> add .\lone-wolf-akela-dsh-sandboxie-redirect-0.3.0.tgz
```

> **Which command for which profile?** The CLI refuses to touch a profile that a running desktop app owns (`profile "desktop" is managed exclusively by the Electron application`). For that profile, install from inside the app: **Settings → Plugins → add a bundle**, and give the package name above. For any other profile, the CLI works normally.

Then restart the client, open the permission dropdown, and select **❐ Copy-on-write 写时复制**. The preset appears once per session as needed; the title bar shows the box name after the first shell command.

### Migrating from a hand-mounted copy

Earlier revisions were installed by copying the tree into `~/.dsh/plugins/dsh-sandboxie-redirect` and adding rows to `~/.dsh/profiles/<profile>/cordis.patch.yml`. If your profile still carries those rows, **remove them** before switching to the bundle channel: two active rows into the same `dsh.client` package fail the boot ("resolves from multiple active Loader sources"). The rows to delete are the ones whose `name` is an absolute path ending in `lib\provider.mjs`, plus the `sandbox` and `permission` rows this plugin added. `tools/install.mjs` remains in the repository for that manual channel, and it must be run outside the sandbox.

## What it does

### The Copy-on-write preset

| Location | Behavior |
|---|---|
| Writes, edits, deletions **inside** the workspace | Applied directly to the real disk |
| Writes, edits **outside** the workspace | The command reports success, but the change lands in that workspace's box copy; the real disk is untouched |
| Deletions **outside** the workspace | The real file survives; the copy records only a deletion marker |

DSH's own file tools (read/write/edit) run outside the box and keep the workspace-write rule: writable inside the workspace, refused outside it. To read a file *as the sandbox sees it*, read it with a shell command — see [Read-side divergence](#read-side-divergence).

Under this preset the session's policy text gains a paragraph that tells the model how the mode behaves and what to watch for, so an agent does not have to infer it.

### Sandbox name in the title bar

Under Copy-on-write the title bar shows the box name (for example `dsh_able_willow`; hover for the copy's root). It appears only when both hold: this session's preset is Copy-on-write, and this workspace really owns a box — so it shows up after the first command, and disappears when the preset changes or the box is cleaned.

### Permission dropdown icon

The preset carries an icon (two overlapping sheets) in the dropdown and the bottom button, following the active theme. The preset's display name starts with `❐` for the same reason: the shipped dropdown takes icons from a closed id→icon map, so the name is the one surface that always renders.

### The `sandbox_clear` tool

In-session, `sandbox_clear` inspects or discards this workspace's copy: `mode: "inspect"` reports (file count, size), `mode: "clear"` deletes the copy and its configuration. It works in every permission mode, and can only ever touch boxes Sandboxie attributes to *this* workspace.

## Notes for users

- **Read-side divergence (important)**: one path can look different depending on who reads it.
  - Shell commands run inside the box and may see the merged view — if an earlier command wrote that file outside the workspace, the command sees the copy's version.
  - DSH's file tools run outside the box and always see the real disk.
  - So: to see "what a command wrote outside the workspace", read with a shell command; to see "was the real disk changed", read with DSH's file tools (or File Explorer).
- **Copy location**: ordinary paths at `<sandbox root>\drive\<drive>\<path>`; paths under the user profile at `<sandbox root>\user\current\<relative path>`. Sandboxie's own sandbox folder is followed automatically (its `FileRootPath`, box setting or `[GlobalSettings]`, with `%USER%`/`%SANDBOX%` expanded); `DSH_SBIE_ROOT` overrides that if you need it (see [Environment](#environment)).
- **Disk usage**: copies are not reclaimed automatically and keep growing.
- **`C:\Windows\Temp`**: modifying an *existing* file there may be refused — native Sandboxie behavior, not this plugin's. Creating and deleting files there works.
- **Concurrency**: concurrent commands in one workspace share one box and see each other's changes.
- **Escalation**: if a command escalates for wider permissions, that single call runs entirely outside the box; the next command returns to the box. Escalation is not a way to make one file real.
- **Write-back**: copy changes are not merged back automatically. Recover files in SandMan; `sandbox_clear` only deletes.
- **Uninstalling** the bundle removes the preset and the rows, but the boxes and their copies stay on disk. Clean them first (`sandbox_clear`, or `--manage clean`) if you want the space back.

## Managing boxes manually

```powershell
node bin\dsh-sbie-run.mjs --manage list                  # list managed boxes
node bin\dsh-sbie-run.mjs --manage clean "<workspace>"    # clean one workspace's boxes
node bin\dsh-sbie-run.mjs --manage delete-box <box>      # delete one box
```

`--manage` must run outside the box (an ordinary terminal, or a `danger-full-access` session): a process inside a box cannot see Sandboxie's box list. The same operations are available in SandMan.

## Environment

All optional; each exists as an escape hatch rather than a configuration surface.

| Variable | Effect |
|---|---|
| `DSH_SBIE_NODE` | The `node.exe` that runs the launcher. Set it if the plugin cannot find one (the desktop app's own runtime, then `$DSH_HOME/dsh-runtimes`, are searched automatically). |
| `DSH_SBIE_ROOT` | Overrides the sandbox root. Normally unnecessary: Sandboxie's configured `FileRootPath` is followed. Default `%SystemDrive%\Sandbox\%USERNAME%`. |
| `DSH_SBIE_LOG_DIR` | Where diagnostics land. Default `$DSH_HOME/state/dsh-sandboxie-redirect`. |
| `DSH_SBIE_INI` | The Sandboxie configuration file to read. Default `%SystemDrive%\Windows\Sandboxie.ini`. |
| `DSH_SBIE_KOFFI` / `DSH_SBIE_KOFFI_ROOT` | A `koffi.node` (or a directory holding one) for the launcher, when the app's copy cannot be found. |
| `DSH_SBIE_BOX` / `DSH_SANDBOX_ROOT` | **Set by the plugin** inside a command; authoritative for "which box am I in" — never derive the name from the workspace path. |

Diagnostics: `provider.log`, `host.log`, `tool.log` under the log directory above. The host log is capped at 512 KB and records only state transitions.

## How it works (short)

- The bundle layer disables the stock `sandbox` row (`@deepseek-ai/dsh-sandbox-local`) and inserts this package's provider, which subclasses it: only the Copy-on-write *preset* is diverted, every other mode delegates to the stock ACL path. A configured `runnerCommand` cannot do this — it would apply to every mode.
- The same layer merges `copy-on-write` into the `permission` preset list, keeping whatever the layers before it contributed.
- Shell commands are then run through `bin/dsh-sbie-run.mjs`, a plain-Node child process that holds the Sandboxie FFI. Sandboxie builds processes through its service and drops the standard handles, so stdio is relayed over a loopback TCP channel with length-prefixed frames.
- Box names are a deterministic word pair derived from the workspace path (`dsh_<adjective>_<noun>`), so no state file is needed to find a workspace's box; a collision steps to the next candidate, and a name is only adopted when Sandboxie's own configuration says that workspace owns it.
- Only a failure to load the harness packages is fatal, and that case registers a provider that fails **closed** — refusing to run commands rather than running them unconfined.

## Development

See [AGENTS.md](AGENTS.md) for the architecture and the hard-won constraints. The short version:

```powershell
node test\unit.mjs               # pure logic
node test\host-projection.mjs    # the title-bar projection, without the harness bundle
node test\validate-patch.mjs     # this bundle's layer: structure, and the preset merge actually evaluated
node test\run-tests.mjs          # acceptance: real boxes, real redirection (outside any box, medium IL)
```

## License

MIT — see [LICENSE](LICENSE).
