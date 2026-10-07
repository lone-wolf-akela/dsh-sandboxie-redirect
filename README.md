# dsh-sandboxie-redirect

> **中文版**：[README.zh.md](README.zh.md)

Adds a fourth permission preset, **Copy-on-write (写时复制)**, to DSH: writes inside the workspace go to the real disk as usual; writes, edits, and deletions outside the workspace do not fail — they land in a Sandboxie sandbox copy dedicated to that workspace, leaving the real disk untouched. The three original presets (read-only, workspace-write, danger-full-access) behave exactly as before.

## Overview

- Installed as a permission preset; does not modify the DSH application itself.
- Requires Sandboxie-Plus. Copies can be inspected, recovered, or discarded.
- Intended to prevent accidental writes, provide undo, and keep system directories clean; it does not defend against malicious programs (Sandboxie offers no such guarantee).

## Terminology

| Term | Meaning |
|---|---|
| Real disk | Where files actually live on the system (for example `C:\Users\…`). |
| Sandbox | An isolated environment created by Sandboxie; this plugin creates one dedicated sandbox per workspace. |
| Copy | The sandbox's private storage for changes to files outside the workspace (under `C:\Sandbox\…`), kept separate from the real files. |
| Inside / outside the sandbox | Under Copy-on-write, shell commands run inside the sandbox; the DSH app itself and its file tools (read/write/edit) run outside it. |
| Merged view | When a command reads a file inside the sandbox, the sandbox overlays the copy's content onto the real file before presenting it. |
| SandMan | Sandboxie-Plus's built-in graphical management UI, for viewing, recovering, and deleting sandboxes. |

## Installation

**Prerequisite**: install [Sandboxie-Plus](https://sandboxie-plus.com/) first (download it from the official site, or get the installer from its [GitHub repository](https://github.com/sandboxie-plus/Sandboxie)). Every sandbox used by this plugin is created and managed by Sandboxie.

Steps:

1. Place the plugin in `C:\Users\<you>\.dsh\plugins\dsh-sandboxie-redirect\`.
2. Edit the profile patch file `C:\Users\<you>\.dsh\profiles\desktop\cordis.patch.yml` to include this plugin. A complete template is in `cordis.patch.yml.new` at the repository root; change the plugin paths to your actual paths. The essentials are three changes:
   - replace the shell sandbox provider with this plugin (disable the original `sandbox` row and add a provider row);
   - add the `copy-on-write` entry to the permission presets;
   - the model-facing note, the title-bar sandbox name, and the `sandbox_clear` tool are mounted automatically by the provider — no extra rows needed.
3. Restart the DSH client.
4. Select **Copy-on-write** in the permission dropdown.

When updating plugin files, use `tools/install.mjs`, and run it **outside the sandbox** (that is, with the DSH session in a mode other than Copy-on-write, or in an ordinary terminal): under Copy-on-write, writes made inside the sandbox are redirected and never reach the real disk, so the script detects this and refuses to run, to avoid "reports success but nothing changed".

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node .\tools\install.mjs
```

## Features

### Copy-on-write preset

Once selected, shell commands run inside the sandbox:

| Location | Behavior |
|---|---|
| Writes, edits, deletions inside the workspace | Applied directly to the real disk |
| Writes, edits outside the workspace | The command reports success, but changes happen only in that workspace's sandbox copy; the real disk is unaffected |
| Deletions outside the workspace | The real file is kept; the copy records only a deletion marker |

DSH's file tools (read/write/edit) run outside the sandbox and still follow the workspace-write rule: writable inside the workspace, refused outside it. Therefore, to read a file from the "sandbox's point of view", read it with a shell command (see "Read-side divergence" below).

Under this preset, the session's policy text gains an extra paragraph that tells the model how this mode behaves and what to watch out for.

### Sandbox name in the title bar

Under Copy-on-write, the title bar shows the current sandbox name (for example `dsh_able_willow`; hovering shows the copy's root path). It appears only when two conditions hold: the session's preset is Copy-on-write, and that workspace has actually created a sandbox. So it appears after the first command and disappears when the preset is switched or the sandbox is cleaned.

### Permission dropdown icon

The Copy-on-write preset carries an icon (two overlapping rectangles) in both the dropdown and the bottom button, following the active theme.

### The `sandbox_clear` tool

Inside a session, the `sandbox_clear` tool can inspect or clear this workspace's sandbox copy: `mode: "inspect"` only reports (file count, size), while `mode: "clear"` deletes the copy and its configuration. It is available in every permission mode and can only touch this workspace's sandbox.

## Notes for users

- **Read-side divergence (important)**: the same path can look different depending on the tool.
  - Shell commands run inside the sandbox and may see the merged view: if an earlier command wrote to that file outside the workspace, the command sees the version in the sandbox copy.
  - DSH's file tools run outside the sandbox and always see the real disk.
  - Therefore, to check "what did a command write outside the workspace", read with a shell command; to check "was the real disk changed", read with DSH's file tools (or File Explorer).
- **Copy location**: ordinary paths are at `<sandbox root>\drive\<drive letter>\<path>`; paths under the user profile are at `<sandbox root>\user\current\<relative path>`. The sandbox root is `C:\Sandbox\<user>\<sandbox name>\`.
- **Disk usage**: copies are not reclaimed automatically; they keep accumulating.
- **`C:\Windows\Temp`**: modifying an existing file there may be refused (native Sandboxie behavior, not caused by this plugin); creating and deleting files there work normally.
- **Concurrency**: concurrent commands for the same workspace share one sandbox and can see each other's changes.
- **Escalation**: under Copy-on-write, if a command needs more permissions and you escalate it, that single call runs entirely outside the sandbox and is not restricted by it; the next command returns to the sandbox.
- **Writing back**: changes in the copy are not merged back to the real disk by default. To recover, view and restore the relevant files in SandMan; this plugin's cleanup tool only deletes, it does not write back.

## Managing sandboxes manually

```powershell
node bin\dsh-sbie-run.mjs --manage list                    # list managed sandboxes
node bin\dsh-sbie-run.mjs --manage clean "<workspace>"     # clean a workspace's sandboxes
node bin\dsh-sbie-run.mjs --manage delete-box <sandbox>    # delete a specific sandbox
```

`--manage` must run outside the sandbox (an ordinary terminal, or a danger-full-access session): processes inside a sandbox cannot see the sandbox list.

You can also manage the corresponding sandboxes through Sandboxie-Plus's built-in GUI.
