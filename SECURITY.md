# Security policy

## What this plugin is, and what it is not

`dsh-sandboxie-redirect` runs **inside the DSH host process** with the privileges
of the user who installed it, and it spawns a plain-Node launcher that talks to
Sandboxie. Installing any DSH plugin is therefore granting code execution to
that plugin; that is the trust decision, not something this document can
remove.

What it is: a copy-on-write **permission preset**. Shell commands run inside a
per-workspace Sandboxie box, so writes outside the workspace land in that box's
copy.

What it is **not**: a security boundary. It exists to prevent accidents, to make
mistakes undoable, and to keep the real disk clean. Sandboxie's isolation is not
a malware sandbox — do not rely on this plugin to contain hostile code, and do
not treat a "sandboxed" command as trusted.

## What it changes in a DSH installation

- Its bundle layer **disables the stock `sandbox` row**
  (`@deepseek-ai/dsh-sandbox-local`) and inserts its own provider, which
  subclasses the stock one. Only sessions whose preset is `copy-on-write` are
  diverted; every other mode delegates to the original ACL path.
- It merges a `copy-on-write` entry into the `permission` preset list (the value
  is computed at load time by a `!!js` expression, like the bundles DSH ships).
- It contributes a per-session system-prompt paragraph, a header chip, and the
  `sandbox_clear` tool.
- If the harness packages cannot be imported, it registers a provider that
  **fails closed**: commands are refused (`SANDBOX_UNAVAILABLE`) rather than run
  without confinement.

Uninstalling the bundle removes the preset and its rows; **the boxes and their
copies stay on disk** until they are cleared (see the README).

## Attack surface, and what is done about it

| Surface | Notes |
|---|---|
| The layer's `!!js` expression | Evaluated by the DSH loader in the host process. It only reads `ctx.loader.entries()` to merge the preset list, and falls back to a literal map if that read fails. |
| `bin/dsh-sbie-run.mjs` (plain-Node child) | Loads `koffi` to call Sandboxie's API. `koffi` is located by searching the harness's own resources first; `DSH_SBIE_KOFFI` / `DSH_SBIE_KOFFI_ROOT` can point elsewhere — only set those to paths you trust, since a substituted native module is code execution in that child. |
| Command stdio relay | Sandboxie drops standard handles, so output is relayed over a **loopback TCP** socket with a random port and a per-launch random token, framing length-prefixed messages. Anything that can reach that port and guess the token could inject bytes into one command's output. |
| `sandbox_clear` | Deletes a box's copy tree. It never accepts a box name or a path from the model: it resolves its targets from Sandboxie's own configuration, using the same ownership test as the header chip, so it can only ever touch boxes that grant **this session's workspace** access. `mode: "clear"` is destructive to the copy by design; anything that exists only there is gone. |
| `Sandboxie.ini` | Box sections are written through `SbieIni.exe` (the service route), not by editing the file. `--manage delete-box` removes one section. |
| The browser half | Registers a header cell and decorates the preset's label by ARIA-based lookups. It only sets attributes and adds a generated stylesheet — it inserts no nodes into React's tree and makes no network requests. |

The plugin makes **no network connections of its own** and collects no telemetry.

## Things this plugin deliberately never does

- append a new session event type (it would make affected sessions unloadable);
- take a box name, box path or workspace path from the model for a destructive
  operation;
- write diagnostics into its own installed package directory;
- delete a directory it did not resolve through Sandboxie's own ownership rule;
- run a command unconfined as a *fallback*: failures go to refusal, not to
  weaker isolation.

## Accepted risks you should know about

- **Escalation** (`sandbox_permissions` + `justification`, approved by the user)
  runs that one call entirely outside the box, on the real disk. That is the
  documented lever for installing or configuring things outside the workspace.
- **Concurrent commands in one workspace share one box** and can see each other's
  changes.
- **Copies are not recovered automatically** and grow until they are cleared.
- The plugin cannot protect you from another plugin you install, nor from
  anything running outside the box.

## Reporting a vulnerability

Please use GitHub's **private** reporting: *Security → Report a vulnerability* on
[github.com/lone-wolf-akela/dsh-sandboxie-redirect](https://github.com/lone-wolf-akela/dsh-sandboxie-redirect).
If that is unavailable to you, open an issue that says only that you have a
security report and asks for a private channel — please do not include the
details in the issue.

Helpful in a report: the version, what an attacker would need (local user?
network? malicious plugin?), which of the surfaces above is involved, and a
minimal reproduction that says whether it ran inside a box.

There is no bug bounty. Reports are handled on a best-effort basis, and the
supported version is the latest release on npm.
