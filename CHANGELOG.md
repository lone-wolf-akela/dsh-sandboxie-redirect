# Changelog

Notable changes per release. The format is loose; the version numbers are what
the DSH compatibility gate reads.

## 0.3.6 — 2026-11-14

**Plugin manager shows a name and an icon**

- The plugin was listed by its technical package name and without an icon.
  It now ships a localized display title/description (`locale/en.json`,
  `locale/zh.json`, each with `meta.title` and `meta.description`) and an
  `icon.svg` declared as `package.json.icon`.
- DSH's plugin metadata reader resolves `<pkg>/locale/en.json` and the icon
  through the package's `exports` map, so `./locale/*.json` and `./icon` are
  exported and `icon.svg`/`locale` are in `files`. `test/unit.mjs` installs a
  throwaway copy and resolves both subpaths through Node's resolver, so a broken
  exports map fails the suite instead of silently falling back to the package
  name.
- The icon is a copy-on-write motif: a writable copy in front of the untouched
  original, with a confinement badge.

## 0.3.5 — 2026-11-14

**Programmatic tool calling + copy-on-write: every command failed**

- PTC spawns its runtime with a deliberately scrubbed environment — only
  `PATH`, `PATHEXT`, `SYSTEMROOT`, `WINDIR`, `TEMP` and `TMP`. The launcher
  inherits it, and Sandboxie expands its `ProfileList` values
  (`%SystemDrive%\ProgramData`, `%SystemDrive%\Users\…`) with
  `ExpandEnvironmentStrings`, which only sees the *caller's* environment. Without
  `SystemDrive` the expansion fails, the boxed relay dies during initialization
  (`SBIE2306 Could not locate user directory: [C000003B / 33]` followed by
  `SBIE2304`) and the launcher could only report `the boxed relay did not connect
  within 15000 ms` — so *every* tool call in the session failed, including a
  program that made none.
- `lib/sandbox-env.mjs` now restores `SystemDrive` into the launcher's own
  process environment before the boxed relay is started, deriving it from the
  caller's environment, from `GetWindowsDirectoryW`, or from Node's own drive —
  in that order. The command's spawn specification is built from a snapshot taken
  *before* the restoration, so the boxed command still receives exactly the
  environment its caller chose; `test/unit.mjs` pins both halves.
- Reproduced offline by spawning the launcher through `CreateProcessW` with the
  exact six-variable environment and no `SystemDrive`: the launcher timed out and
  the boxed `node.exe` reported SBIE2306/SBIE2304. With the fix the same
  invocation runs the command and returns its exit code.

**PTC runtime: Sandboxie injected browser flags into Electron's Node mode**

- Sandboxie classifies Electron images (DSH's executable included) as Chromium
  and, for every non-child process of that image, prepends its
  `CustomChromiumFlags` — by default `--disable-features=PrintCompositorLPAC` —
  to the command line. The PTC runtime is Electron started with
  `ELECTRON_RUN_AS_NODE=1`, so Node parses that browser flag as one of its own
  options and exits 9 with `bad option: --disable-features=PrintCompositorLPAC`
  before the program's first line runs.
- Managed boxes now carry `SpecialImage=none,DeepSeek Harness.exe`, which
  suppresses the classification for DSH's own executable only; other Chromium
  applications in the same box keep Sandboxie's compatibility flags. Boxes
  created by older versions are repaired on the next launch.
- `test/unit.mjs` pins the box setting for both access modes.

**PTC runtime: the inherited control channel never reached the box**

- DSH hands the confined process a control channel on fd 7 (`SUBPROCESS_CONTROL_FD`,
  an `overlapped` named pipe marked by `DSH_SUBPROCESS_CONTROL=pipe`). SbieSvc
  ignores inherited handles, so the boxed relay started the command with only
  stdin/stdout/stderr; the PTC runtime then died at startup with
  `ERR_INVALID_FD_TYPE: Unsupported fd type: UNKNOWN` from
  `openInheritedControlChannel()`.
- The launcher now opens fd 7 itself, forwards its bytes over the relay's TCP
  channel (new `CONTROL` / `CONTROL_EOF` frames) and the relay re-creates an
  `overlapped` fd 7 for the boxed child. The command's environment is unchanged.
- `test/run-tests.mjs` case 21 pins the roundtrip through a real box; case 20
  remains the scrubbed-environment regression.

## 0.3.4 — 2026-10-13

**`sandbox_clear` mode `status` no longer answers in `inspect`'s words**

- `render` gave every action except `clear` the inspect head line, so a status
  query read `Sandbox copies for <workspace>: 0 found.` — which looks like "this
  workspace has no copy" when the call says nothing about copies at all. `status`
  now has its own head, `Session projection state for <workspace>.`, above the
  projection detail that actually carries the information.
- `test/tool-execute.mjs` pins the rendered text of all three actions, plus the
  empty and truncated copy lines, so the wording cannot silently fall through
  again.

## 0.3.3 — 2026-10-13

**`sandbox_clear` mode `status` never worked**

- `execute` referenced `workspace` in the `status` early return while the
  `const workspace = …` that names it was declared below, in the same function
  body. A `const` in its temporal dead zone throws on *any* earlier reference, so
  `mode: "status"` failed on every call with `ReferenceError: Cannot access
  'workspace' before initialization`. The declaration now precedes every use,
  which is also what `status` was always meant to report: the canonical workspace
  alongside the projection registry's state for the calling session.
- The defect came in with the 0.2.1 import, so it shipped in 0.3.0, 0.3.1 and
  0.3.2; `inspect` and `clear` were unaffected, because they use `workspace`
  after the declaration.
- New `test/tool-execute.mjs` drives all three modes of the real tool offline
  (only the harness loader, the Node lookup and `spawnSync` are redirected), so
  this — and any future runtime failure in a mode nobody exercises by hand — is a
  failed test rather than a report from a user. It reproduces the
  `ReferenceError` on the pre-fix source.

## 0.3.2 — 2026-10-13

**DeepSeek Harness installation lookup**

- The launcher no longer assumes DSH is installed in
  `%LOCALAPPDATA%\Programs\DeepSeek Harness`. `koffi.node` ships *inside* the
  installation, so a relocated DSH failed every command with "koffi native addon
  not found". The new `lib/dsh-locate.mjs` finds the installation instead: the
  interpreter's own path walked upwards (the host starts the launcher with the
  Node the app ships, so that path points back at the installation), then the
  installer's uninstall entry — `InstallLocation`, `DisplayIcon` and
  `UninstallString` are all accepted, and it is found by display name because
  the key is a GUID — then the conventional folders and `PATH`.
- `DSH_SBIE_KOFFI` and `DSH_SBIE_KOFFI_ROOT` remain the explicit overrides, and
  the failure message now says what it looked for and where.
- New `test/dsh-locate.mjs` (18 offline checks) pins the source order and
  includes a regression case for an installation outside every default folder.

**Packaging**

- `bin` no longer carries a leading `./`. npm's `@npmcli/package-json`
  normalizes that away and then reports `"bin[dsh-sbie-run]" script name
  bin/dsh-sbie-run.mjs was invalid and removed` on every publish; the emitted
  path was already the normalized one, so this removes a misleading warning and
  nothing else. `test/unit.mjs` pins the form.

## 0.3.1 — 2026-10-12

**Sandboxie installation lookup**

- The engine is no longer looked for in a fixed four-path list. The new
  `lib/sbie-locate.mjs` reads Sandboxie's own registry entries first — the
  `SbieSvc` service's `ImagePath` above all, which every installation able to
  create a box must have — then the driver service and the installer's uninstall
  entry, then the conventional folders and `PATH`, and only as a last resort
  walks well-known parent folders and fixed-drive roots for a directory named
  after Sandboxie. An installation on another drive, in a per-user folder or in
  a portable directory is now found instead of reported as "not installed".
- `DSH_SBIE_DIR` still wins when set, and the "not installed" error now names it
  as well as `SbieDll.dll`, so the remaining unusual cases are actionable.
- `--manage list` prints the installation folder it resolved and how it found it
  (registry / conventional folder / `PATH` / disk scan).
- The registry is read through `koffi`/`advapi32` when available — exact wide
  characters, no subprocess — and through `reg.exe` when it is not.
- New `test/sbie-locate.mjs` (25 checks, no Sandboxie and no registry needed)
  covers the registry value shapes, the candidate ordering, and the staged
  resolution, including that the disk scan runs only when nothing cheap answers.
  It is part of `npm test`.

## 0.3.0 — 2026-10-07

The distribution changed shape, so this is a breaking release for the earlier
hand-mounted installations.

**Distribution**

- The package is now a DSH **bundle**: `dsh.bundle.patch` points at a root
  `cordis.patch.yml` whose rows name the package instead of an absolute Windows
  path. Install with `dsh plugin --profile <name> add @lone-wolf-akela/dsh-sandboxie-redirect`
  (or the in-app Plugins page for the profile a running desktop app owns); the
  profile no longer needs hand-editing.
- `exports["."]` now resolves to `lib/provider.mjs`. It used to be `lib/host.mjs`,
  which would have mounted the wrong half of the plugin under a package row.
- Added `LICENSE`, `files`, `publishConfig.access`, `repository`/`author`/`bugs`,
  `os: ["win32"]`, keywords and the peer ranges the compatibility gate reads
  (`@deepseek-ai/dsh-* ^0.2.0-rc.2`, `@deepseek-ai/cordis ^4.0.4`).
- Removed the `cordis.patch.yml.new` template: with the bundle channel it was the
  one file that could not survive publication (it carried an absolute path).

**Configuration layer**

- The `permission` row's preset list is computed at load time (`!!js`) from the
  layers before it, instead of restating the three shipped presets. A preset
  another bundle contributes is no longer silently dropped, and an unreadable
  earlier layer falls back to the literal stock three.
- The preset's display name and description are bilingual:
  `❐ Copy-on-write 写时复制`.

**Behaviour**

- Diagnostics moved out of the package directory into
  `$DSH_HOME/state/dsh-sandboxie-redirect` (`DSH_SBIE_LOG_DIR` overrides). An
  installed bundle lives in the profile's `node_modules`, possibly served from
  pnpm's content-addressed store, where appending logs is both rude and fragile.
- The launcher's Node runtime is now located through `process.resourcesPath`
  (the desktop app's own Node) before the `$DSH_HOME/dsh-runtimes` pool, and
  `process.execPath` is only accepted on a non-Electron host. Finding no genuine
  Node now fails loudly with `SANDBOX_UNAVAILABLE` instead of silently spawning
  the Electron binary inside the box.
- The copy root follows Sandboxie's configured `FileRootPath` (box setting, then
  `[GlobalSettings]`), with `%USER%`/`%SANDBOX%`/`%SystemDrive%`/`%USERPROFILE%`/
  `%WINDIR%` expanded; `DSH_SBIE_ROOT` still overrides it. A template without
  `%SANDBOX%`, or one that cannot be fully expanded, is refused — the plugin then
  keeps the default layout rather than pointing its cleanup at a shared folder.
- `--manage list` derives the sandbox root from the boxes it lists, and
  `--manage show` resolves a box's own directory the same way.
- The model-facing note names the same resolved root.

**Tooling and docs**

- `tools/install.mjs` (the manual channel) derives its copy list from
  `package.json`'s `files`.
- `test/validate-patch.mjs` accepts both row shapes (package name for bundles,
  absolute path for the manual channel), reads js-yaml from the devDependency /
  `asar-yaml/` / an installed profile, and now EXECUTES the computed preset
  expression against a stub context.
- The module-level import pin for `lib/tool.mjs` follows relative siblings
  recursively instead of banning them.
- GitHub Actions runs the Sandboxie-free tests; `npm test`, `npm run
  test:acceptance` and `npm run pack:check` are wired up. The READMEs are
  rewritten around the bundle install.

## 0.2.1

The last hand-mounted release: copy the tree into
`~/.dsh/plugins/dsh-sandboxie-redirect` and add three rows to the profile's
`cordis.patch.yml`. Functionally it already had the copy-on-write preset, the
title-bar box name, the permission-dropdown icon and the `sandbox_clear` tool.
